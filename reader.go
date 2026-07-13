package main

import (
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/warthog618/go-gpiocdev"
)

type WiegandReader struct {
	Cfg           HardwareProfile
	OutputChannel chan string
	bitBuffer     string
	lastBitTime   time.Time
	isProcessing  bool
	chip          *gpiocdev.Chip
	d0Line        *gpiocdev.Line
	d1Line        *gpiocdev.Line
	relayLine     *gpiocdev.Line
	dsmLine       *gpiocdev.Line
	rexLine       *gpiocdev.Line
	buzzLine      *gpiocdev.Line 
	hornLine      *gpiocdev.Line 
	logger        *log.Logger

	// Operational State Machine Latches
	ExpectOpen     bool
	DhoBypassed    bool
	DoorOpenedAt   time.Time
	DhoTriggered   bool
	PreAlarmActive bool
	DfoTriggered   bool
	LockdownActive bool
	SustainActive  bool

	// Electrical Anti-Chatter Latches
	relayMutex     sync.Mutex
	relockTime     time.Time
	
	// Spattering prevention flag tracker
	lastLoggedState string
}

func NewWiegandReader(cfg HardwareProfile) *WiegandReader {
	return &WiegandReader{
		Cfg:            cfg,
		OutputChannel:  make(chan string, 10),
		ExpectOpen:     false,
		DhoBypassed:    false,
		DfoTriggered:   false,
		DhoTriggered:   false,
		PreAlarmActive: false,
	}
}

func (r *WiegandReader) SetLogger(l *log.Logger) {
	r.logger = l
}

func (r *WiegandReader) logMessage(msg string) {
	if r.logger != nil {
		r.logger.Println(msg)
	} else {
		log.Println(msg)
	}
}

func (r *WiegandReader) diagnosticPinError(pinName string, offset int, originalErr error) error {
	info, _ := r.chip.LineInfo(offset)
	return fmt.Errorf("\n--------------------------------------------------------------------------------\n"+
		"[RESOURCE LOCKOUT ERROR]\n"+
		"Target Subsystem Element : %s\n"+
		"Physical Board Setting   : GPIO Offset %d\n"+
		"Kernel Error Reason      : %v\n"+
		"Current Active Consumer  : %s\n"+
		"--------------------------------------------------------------------------------",
		pinName, offset, originalErr, info.Consumer)
}

func (r *WiegandReader) InitializeHardware() error {
	var err error
	r.chip, err = gpiocdev.NewChip(r.Cfg.Chip)
	if err != nil {
		return fmt.Errorf("[BUS-FATAL] Unable to open primary character device node '%s': %w", r.Cfg.Chip, err)
	}

	r.d0Line, err = r.chip.RequestLine(r.Cfg.D0, gpiocdev.WithEventHandler(func(e gpiocdev.LineEvent) { r.handleBitDrop("0") }), gpiocdev.WithFallingEdge)
	if err != nil { return r.diagnosticPinError("D0", r.Cfg.D0, err) }
	
	r.d1Line, err = r.chip.RequestLine(r.Cfg.D1, gpiocdev.WithEventHandler(func(e gpiocdev.LineEvent) { r.handleBitDrop("1") }), gpiocdev.WithFallingEdge)
	if err != nil { return r.diagnosticPinError("D1", r.Cfg.D1, err) }

	r.dsmLine, err = r.chip.RequestLine(r.Cfg.Dsm, 
		gpiocdev.WithBothEdges,
		gpiocdev.WithDebounce(25*time.Millisecond),
	)
	if err != nil { return r.diagnosticPinError("DSM", r.Cfg.Dsm, err) }

	r.rexLine, err = r.chip.RequestLine(r.Cfg.Rex, 
		gpiocdev.WithFallingEdge,
		gpiocdev.WithDebounce(25*time.Millisecond),
		gpiocdev.WithEventHandler(func(e gpiocdev.LineEvent) {
			r.logMessage("[REX-INTERRUPT] Request to Exit button pressed. Bypassing perimeter shunts.")
			r.ExecuteUnlockCycle()
		}),
	)
	if err != nil { return r.diagnosticPinError("REX", r.Cfg.Rex, err) }

	r.relayLine, err = r.chip.RequestLine(r.Cfg.Rely, gpiocdev.AsOutput(0))
	if err != nil { return r.diagnosticPinError("Relay", r.Cfg.Rely, err) }
	
	r.buzzLine, err = r.chip.RequestLine(r.Cfg.Buzz, gpiocdev.AsOutput(0))
	if err != nil { return r.diagnosticPinError("Buzzer", r.Cfg.Buzz, err) }
	
	r.hornLine, err = r.chip.RequestLine(r.Cfg.AlarmHornPin, gpiocdev.AsOutput(0))
	if err != nil { return r.diagnosticPinError("Horn", r.Cfg.AlarmHornPin, err) }

	r.logMessage(fmt.Sprintf("[HARDWARE] Pin bindings locked. Input D0:%d, D1:%d DSM:%d REX:%d | NC-Logic: %t", 
		r.Cfg.D0, r.Cfg.D1, r.Cfg.Dsm, r.Cfg.Rex, r.Cfg.DsmNormallyClosed))
	return nil
}

func (r *WiegandReader) IsDoorPhysicallyOpen() bool {
	rawVal, err := r.dsmLine.Value()
	if err != nil {
		return false 
	}
	if r.Cfg.DsmNormallyClosed {
		return rawVal == 1
	}
	return rawVal == 0
}

func (r *WiegandReader) handleBitDrop(bit string) {
	r.bitBuffer += bit
	r.lastBitTime = time.Now()
	r.isProcessing = true
}

func (r *WiegandReader) StartListening(stopChan chan struct{}, alarmCallback func(string, string)) {
	// Loop A: Wiegand Bitstream Packet Assembler Thread
	go func() {
		ticker := time.NewTicker(5 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stopChan:
				return
			case <-ticker.C:
				if r.isProcessing && time.Since(r.lastBitTime) > time.Duration(r.Cfg.Tout)*time.Millisecond {
					frame := r.bitBuffer
					r.bitBuffer = ""
					r.isProcessing = false
					r.OutputChannel <- frame
				}
			}
		}
	}()

	// Loop B: State Machine Perimeter Watcher (Dynamic DFO Bypass to DHO Fallthrough Execution)
	go func() {
		ticker := time.NewTicker(50 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stopChan:
				return
			case <-ticker.C:
				doorIsOpen := r.IsDoorPhysicallyOpen()

				if r.ExpectOpen {
					r.relayMutex.Lock()
					if !r.SustainActive && time.Now().After(r.relockTime) {
						r.relayLine.SetValue(0)
						r.ExpectOpen = false
						r.logMessage("[HARDWARE] Strike relay de-energized.")
					}
					r.relayMutex.Unlock()
				}

				if doorIsOpen {
					if r.DoorOpenedAt.IsZero() {
						r.DoorOpenedAt = time.Now()
					}
					
					if r.lastLoggedState != "OPEN" {
						r.logMessage(fmt.Sprintf("[DOOR] Position status changed to OPEN. Auth-Latch: %t, DFO-Enabled: %t", r.ExpectOpen, r.Cfg.DfoEnabled))
						r.lastLoggedState = "OPEN"
						alarmCallback("DOOR_OPEN", "Door position status changed to OPEN.")
					}

					// Relock on Open logic
					if r.ExpectOpen && r.Cfg.RelockOnOpen {
						r.relayMutex.Lock()
						if !r.SustainActive {
							r.relayLine.SetValue(0)
							r.ExpectOpen = false
							r.logMessage("[HARDWARE] Relock-on-Open: Door contacts broken; strike relay de-energized immediately.")
						}
						r.relayMutex.Unlock()
					}

					// 1. DFO TRACKING LAYER
					if !r.ExpectOpen && r.Cfg.DfoEnabled {
						if !r.DfoTriggered {
							r.DfoTriggered = true 
							r.logMessage("[ALARM-CRITICAL] Door Forced Open (DFO) Detected! No authorization signal active.")
							alarmCallback("DFO", "Perimeter door open without strike or REX signal.")
							r.hornLine.SetValue(1)
						}
					}

					// 2. TIMED DHO TRACKING LAYER (Runs if authorized OR if DFO is turned off)
					if r.ExpectOpen || !r.Cfg.DfoEnabled {
						if r.Cfg.DhoEnabled && !r.DhoBypassed {
							elapsedSecs := time.Since(r.DoorOpenedAt).Seconds()

							// Stage A: Move into Pre-Alarm zone warning
							if elapsedSecs >= float64(r.Cfg.DhoPreAlarmSecs) && elapsedSecs < float64(r.Cfg.DhoTimeout) {
								if !r.PreAlarmActive && !r.DhoTriggered {
									r.PreAlarmActive = true
									r.logMessage(fmt.Sprintf("[WARN] Pre-Alarm threshold reached (Door open %d secs). Chirping reader buzzer.", int(elapsedSecs)))
									alarmCallback("PRE_ALARM", fmt.Sprintf("Door open past warning window at %d seconds.", int(elapsedSecs)))
									r.ExecuteBuzzerPulse(15)
								}
							}

							// Stage B: Exceed master baseline timeframe -> Trigger full DHO alarm
							if elapsedSecs >= float64(r.Cfg.DhoTimeout) {
								if !r.DhoTriggered {
									r.DhoTriggered = true
									r.PreAlarmActive = false
									r.logMessage(fmt.Sprintf("[ALARM-CRITICAL] Door Held Open (DHO) limit breached! Exceeded %d seconds.", r.Cfg.DhoTimeout))
									alarmCallback("DHO", "Door left open beyond configured baseline parameters.")
									r.hornLine.SetValue(1)
								}
							}
						}
					}
				} else {
					// DOOR IS SECURELY CLOSED: Cleanly purge metrics back to low
					if !r.DoorOpenedAt.IsZero() || r.DfoTriggered || r.DhoTriggered || r.PreAlarmActive || r.lastLoggedState != "SECURE" {
						r.DoorOpenedAt = time.Time{}
						r.DhoTriggered = false
						r.DfoTriggered = false 
						r.PreAlarmActive = false
						r.ExpectOpen = false
						r.DhoBypassed = false
						r.buzzLine.SetValue(0)
						r.hornLine.SetValue(0) 
						r.logMessage("[DOOR] Contacts met. Perimeter returned to secure latched state. All alert matrices reset.")
						r.lastLoggedState = "SECURE"
						alarmCallback("DOOR_CLOSE", "Door position status returned to SECURE.")
					}
				}
			}
		}
	}()
}

func (r *WiegandReader) ExecuteUnlockCycle() {
	r.relayMutex.Lock()
	defer r.relayMutex.Unlock()

	if r.LockdownActive {
		return
	}

	r.ExpectOpen = true
	r.relayLine.SetValue(1)
	r.logMessage("[HARDWARE] Strike relay energized.")
	r.relockTime = time.Now().Add(4 * time.Second)
}

func (r *WiegandReader) ExecuteBuzzerPulse(pulses int) {
	go func() {
		for i := 0; i < pulses; i++ {
			if !r.PreAlarmActive || r.DfoTriggered || r.DhoTriggered { return }
			r.buzzLine.SetValue(1)
			time.Sleep(100 * time.Millisecond)
			r.buzzLine.SetValue(0)
			time.Sleep(150 * time.Millisecond)
		}
		
		time.Sleep(1 * time.Second)
		if r.PreAlarmActive && !r.DhoTriggered && !r.DfoTriggered {
			r.ExecuteBuzzerPulse(pulses)
		}
	}()
}

func (r *WiegandReader) CloseHardware() {
	if r.relayLine != nil { r.relayLine.SetValue(0); r.relayLine.Close() }
	if r.buzzLine != nil { r.buzzLine.SetValue(0); r.buzzLine.Close() }
	if r.hornLine != nil { r.hornLine.SetValue(0); r.hornLine.Close() }
	if r.d0Line != nil { r.d0Line.Close() }
	if r.d1Line != nil { r.d1Line.Close() }
	if r.dsmLine != nil { r.dsmLine.Close() }
	if r.rexLine != nil { r.rexLine.Close() }
	if r.chip != nil { r.chip.Close() }
}
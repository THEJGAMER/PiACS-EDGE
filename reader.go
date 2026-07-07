package main

import (
	"sync"
	"time"

	"github.com/warthog618/go-gpiocdev"
)

type ReaderConfig struct {
	GpioChipDevice string
	WiegandD0Pin   int
	WiegandD1Pin   int
	LockRelayPin   int
	BuzzerPin      int
	LedRedPin      int
	LedGreenPin    int
	TimeoutMs      int
}

type WiegandReader struct {
	mu           sync.Mutex
	config       ReaderConfig
	bitBuffer    string
	bitCount     int
	lastBitTime  time.Time
	isProcessing bool

	chip         *gpiocdev.Chip
	lineD0       *gpiocdev.Line
	lineD1       *gpiocdev.Line
	lineRelay    *gpiocdev.Line
	lineBuzzer   *gpiocdev.Line
	lineLedRed   *gpiocdev.Line
	lineLedGreen *gpiocdev.Line

	OutputChannel chan string
}

func NewWiegandReader(cfg ReaderConfig) *WiegandReader {
	return &WiegandReader{
		config:        cfg,
		OutputChannel: make(chan string, 10),
	}
}

func (wr *WiegandReader) InitializeHardware() error {
	var err error

	wr.chip, err = gpiocdev.NewChip(wr.config.GpioChipDevice)
	if err != nil {
		return err
	}

	wr.lineRelay, err = wr.chip.RequestLine(wr.config.LockRelayPin, gpiocdev.AsOutput(0)) // Fail-secure (0 = locked)
	if err != nil {
		return err
	}
	wr.lineBuzzer, err = wr.chip.RequestLine(wr.config.BuzzerPin, gpiocdev.AsOutput(0))
	if err != nil {
		return err
	}
	wr.lineLedGreen, err = wr.chip.RequestLine(wr.config.LedGreenPin, gpiocdev.AsOutput(0))
	if err != nil {
		return err
	}
	wr.lineLedRed, err = wr.chip.RequestLine(wr.config.LedRedPin, gpiocdev.AsOutput(1)) // 1 = Solid Red Normal posture
	if err != nil {
		return err
	}

	return nil
}

func (wr *WiegandReader) StartListening(stopSignal chan struct{}) {
	wr.lineD0, _ = wr.chip.RequestLine(wr.config.WiegandD0Pin, gpiocdev.WithEventHandler(func(evt gpiocdev.LineEvent) {
		wr.mu.Lock()
		wr.bitBuffer += "0"
		wr.bitCount++
		wr.lastBitTime = time.Now()
		wr.isProcessing = true
		wr.mu.Unlock()
	}), gpiocdev.WithPullUp)

	wr.lineD1, _ = wr.chip.RequestLine(wr.config.WiegandD1Pin, gpiocdev.WithEventHandler(func(evt gpiocdev.LineEvent) {
		wr.mu.Lock()
		wr.bitBuffer += "1"
		wr.bitCount++
		wr.lastBitTime = time.Now()
		wr.isProcessing = true
		wr.mu.Unlock()
	}), gpiocdev.WithPullUp)

	go wr.monitorTimeoutLoop(stopSignal)
}

func (wr *WiegandReader) monitorTimeoutLoop(stopSignal chan struct{}) {
	timeoutDuration := time.Duration(wr.config.TimeoutMs) * time.Millisecond
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-stopSignal:
			if wr.lineRelay != nil { wr.lineRelay.SetValue(0) }
			if wr.lineD0 != nil { wr.lineD0.Close() }
			if wr.lineD1 != nil { wr.lineD1.Close() }
			if wr.chip != nil { wr.chip.Close() }
			return
		case <-ticker.C:
			wr.mu.Lock()
			if wr.isProcessing && time.Since(wr.lastBitTime) > timeoutDuration {
				fullBitStream := wr.bitBuffer
				wr.bitBuffer = ""
				wr.bitCount = 0
				wr.isProcessing = false
				wr.mu.Unlock()

				wr.OutputChannel <- fullBitStream
			} else {
				wr.mu.Unlock()
			}
		}
	}
}

func (wr *WiegandReader) ExecuteUnlockCycle() {
	wr.lineLedRed.SetValue(0)
	wr.lineLedGreen.SetValue(1)
	wr.lineBuzzer.SetValue(1)
	wr.lineRelay.SetValue(1) // Drop barrier lock
	time.Sleep(200 * time.Millisecond)
	wr.lineBuzzer.SetValue(0)
	
	time.Sleep(3800 * time.Millisecond) // Maintain unlock window
	wr.lineRelay.SetValue(0) // Secure strike
	wr.lineLedGreen.SetValue(0)
	wr.lineLedRed.SetValue(1)
}

func (wr *WiegandReader) ExecuteDenialAlert() {
	for i := 0; i < 3; i++ {
		wr.lineLedRed.SetValue(0)
		wr.lineBuzzer.SetValue(1)
		time.Sleep(150 * time.Millisecond)
		wr.lineLedRed.SetValue(1)
		wr.lineBuzzer.SetValue(0)
		time.Sleep(150 * time.Millisecond)
	}
}
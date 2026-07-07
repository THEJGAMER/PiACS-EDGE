package main

import (
	"log"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	log.Println("[BOOT] Launching PiACS-EDGE System Supervisor Node...")

	config, err := LoadConfiguration("config.json")
	if err != nil {
		log.Fatalf("Initialization Fail: Could not parse config.json profile: %v", err)
	}
	log.Printf("[CONFIG] Node ID %s verified. Dynamic pin allocations initialized.\n", config.ControllerSettings.ControllerID)

	readerCfg := ReaderConfig{
		GpioChipDevice: config.HardwareMapping.GpioChipDevice,
		WiegandD0Pin:   config.HardwareMapping.WiegandD0Pin,
		WiegandD1Pin:   config.HardwareMapping.WiegandD1Pin,
		LockRelayPin:   config.HardwareMapping.LockRelayPin,
		BuzzerPin:      config.HardwareMapping.ReaderBuzzerPin,
		LedRedPin:      config.HardwareMapping.ReaderRedPin,
		LedGreenPin:    config.HardwareMapping.ReaderGreenPin,
		TimeoutMs:      config.HardwareMapping.TimeoutMs,
	}

	reader := NewWiegandReader(readerCfg)
	if err := reader.InitializeHardware(); err != nil {
		log.Fatalf("Hardware Mount Error: Unable to bind to Linux character device lines: %v", err)
	}

	stopSignal := make(chan struct{})
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	reader.StartListening(stopSignal)
	log.Println("[ENGINE] High-Priority edge loops activated. Awaiting card swipe events...")

	go func() {
		for bitStream := range reader.OutputChannel {
			totalBits := len(bitStream)
			log.Printf("\n[SWIPE EVENT] Captured raw bit length on wire: %d bits\n", totalBits)
			log.Printf("Binary Stream : %s\n", bitStream)

			// Hardcoded match verification for your physical test credential
			if totalBits == 35 && bitStream == "00011010101010101110010100001010101" {
				log.Println("[MATCH] Profile: PiACS Custom 35-Bit User Badge (6B / 289749). Access Granted.")
				reader.ExecuteUnlockCycle()
			} else {
				log.Println("[DENIED] Unknown or alignment mismatch bitstream footprint signature.")
				reader.ExecuteDenialAlert()
			}
		}
	}()

	<-sigChan
	log.Println("[SHUTDOWN] OS System Termination caught. Tearing down daemon layers cleanly...")
	close(stopSignal)
	log.Println("[SHUTDOWN] System processing halted successfully.")
}
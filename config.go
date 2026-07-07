package main

import (
	"encoding/json"
	"os"
)

type MainConfigWrapper struct {
	ControllerID    string          `json:"controller_id"`
	APIToken        string          `json:"api_token"`
	BackendPort     int             `json:"backend_port"`
	DatabaseConfig  DatabaseProfile `json:"database_config"`
	HardwareMapping HardwareProfile `json:"hardware_mapping"`
}

type DatabaseProfile struct {
	DBHost     string `json:"db_host"`
	DBPort     int    `json:"db_port"`
	DBUser     string `json:"db_user"`
	DBPassword string `json:"db_password"`
	DBName     string `json:"db_name"`
	SSLMode    string `json:"ssl_mode"`
}

type HardwareProfile struct {
	Chip             string `json:"gpio_chip_device"`
	D0               int    `json:"wiegand_d0_pin"`
	D1               int    `json:"wiegand_d1_pin"`
	Rely             int    `json:"lock_relay_pin"`
	RedLed           int    `json:"reader_red_led_pin"`
	GrnLed           int    `json:"reader_green_led_pin"`
	Buzz             int    `json:"reader_buzzer_pin"` 
	Dsm              int    `json:"dsm_pin"`
	Rex              int    `json:"rex_pin"`
	Tout             int    `json:"wiegand_timeout_ms"`
	DhoTimeout       int    `json:"dho_timeout_secs"`
	ApbStrict        bool   `json:"apb_strict"`
	DfoEnabled       bool   `json:"dfo_enabled"`
	DhoEnabled       bool   `json:"dho_enabled"`
	DhoPreAlarmSecs  int    `json:"dho_pre_alarm_secs"`
	AlarmHornPin     int    `json:"alarm_horn_pin"`
	
	// Dynamic Logic Inversion Configuration
	DsmNormallyClosed bool  `json:"dsm_normally_closed"`
}

func LoadConfig(path string) (MainConfigWrapper, error) {
	var cfg MainConfigWrapper
	file, err := os.Open(path)
	if err != nil {
		return cfg, err
	}
	defer file.Close()
	err = json.NewDecoder(file).Decode(&cfg)
	return cfg, err
}
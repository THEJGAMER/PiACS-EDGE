package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	_ "github.com/lib/pq"
	_ "github.com/mattn/go-sqlite3"
)

var (
	configPath   = "config.json"
	runtimeState MainConfigWrapper
	localLogFile *os.File
	edgeLogger   *log.Logger
	dbConn       *sql.DB
	localCache   *sql.DB
	reader       *WiegandReader
	isOffline    bool
)

type APICommandRequest struct {
	ControllerID string           `json:"controller_id"`
	Command      string           `json:"command"`
	NewConfig    *HardwareProfile `json:"new_config_payload,omitempty"`
}

type DBLogWriter struct {
	Fallback io.Writer
}

func (w *DBLogWriter) Write(p []byte) (n int, err error) {
	n, err = w.Fallback.Write(p)
	if err != nil {
		return n, err
	}

	msg := strings.TrimSpace(string(p))
	level := "INFO"
	if strings.Contains(msg, "-FATAL]") {
		level = "FATAL"
	} else if strings.Contains(msg, "-ERR]") || strings.Contains(msg, "-WARNING]") || strings.Contains(msg, "-ALERT]") {
		level = "ERROR"
	} else if strings.Contains(msg, "[WARN]") {
		level = "WARN"
	}

	cleanMsg := msg
	if len(msg) > 20 {
		if msg[4] == '/' && msg[7] == '/' && msg[13] == ':' && msg[16] == ':' {
			cleanMsg = strings.TrimSpace(msg[20:])
		}
	}

	go func(lvl, m string) {
		if runtimeState.ControllerID == "" || localCache == nil {
			return
		}
		cID := runtimeState.ControllerID
		if cID == "" {
			cID = "BEDRM-1"
		}

		if dbConn != nil && !isOffline {
			_, execErr := dbConn.Exec("INSERT INTO controller_logs (controller_id, level, message) VALUES ($1, $2, $3)", cID, lvl, m)
			if execErr != nil {
				localCache.Exec("INSERT INTO controller_logs (controller_id, level, message) VALUES (?, ?, ?)", cID, lvl, m)
			}
		} else {
			localCache.Exec("INSERT INTO controller_logs (controller_id, level, message) VALUES (?, ?, ?)", cID, lvl, m)
		}
	}(level, cleanMsg)

	return n, nil
}

func initLogger() {
	localLogFile, _ = os.OpenFile("edge_engine.log", os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0666)
	edgeLogger = log.New(&DBLogWriter{Fallback: io.MultiWriter(os.Stdout, localLogFile)}, "", log.Ldate|log.Ltime|log.Lshortfile)
}

func initLocalCache() {
	var err error
	localCache, err = sql.Open("sqlite3", "./edge_cache.db")
	if err != nil {
		edgeLogger.Fatalf("[CACHE-FATAL] Unable to build SQLite context: %v", err)
	}
	statement := `
	CREATE TABLE IF NOT EXISTS local_credentials (
		facility_code INT,
		card_id INT,
		employee_name TEXT,
		user_active INT,
		cred_active INT,
		last_area TEXT,
		activation_date TEXT DEFAULT NULL,
		expiration_date TEXT DEFAULT NULL,
		pin_code TEXT DEFAULT NULL,
		PRIMARY KEY(facility_code, card_id)
	);
	CREATE TABLE IF NOT EXISTS controller_logs (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		log_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
		controller_id TEXT NOT NULL,
		level TEXT NOT NULL,
		message TEXT NOT NULL
	);`
	localCache.Exec(statement)

	localCache.Exec("ALTER TABLE local_credentials ADD COLUMN activation_date TEXT DEFAULT NULL;")
	localCache.Exec("ALTER TABLE local_credentials ADD COLUMN expiration_date TEXT DEFAULT NULL;")
	localCache.Exec("ALTER TABLE local_credentials ADD COLUMN pin_code TEXT DEFAULT NULL;")
}

func syncBufferedLogsToPostgres() {
	if isOffline || localCache == nil || dbConn == nil {
		return
	}
	rows, err := localCache.Query("SELECT id, log_timestamp, level, message FROM controller_logs ORDER BY id ASC")
	if err != nil {
		return
	}
	defer rows.Close()

	var logsToSync []struct {
		ID        int
		Timestamp string
		Level     string
		Message   string
	}
	for rows.Next() {
		var l struct {
			ID        int
			Timestamp string
			Level     string
			Message   string
		}
		if err := rows.Scan(&l.ID, &l.Timestamp, &l.Level, &l.Message); err == nil {
			logsToSync = append(logsToSync, l)
		}
	}

	if len(logsToSync) == 0 {
		return
	}

	tx, err := dbConn.Begin()
	if err != nil {
		return
	}
	defer tx.Rollback()

	stmt, err := tx.Prepare("INSERT INTO controller_logs (controller_id, level, message, log_timestamp) VALUES ($1, $2, $3, $4)")
	if err != nil {
		return
	}
	defer stmt.Close()

	cID := runtimeState.ControllerID
	for _, l := range logsToSync {
		_, err := stmt.Exec(cID, l.Level, l.Message, l.Timestamp)
		if err != nil {
			edgeLogger.Printf("[DB-ERR] Failed uploading buffered log %d: %v\n", l.ID, err)
			return
		}
	}

	if err := tx.Commit(); err != nil {
		return
	}

	for _, l := range logsToSync {
		localCache.Exec("DELETE FROM controller_logs WHERE id = ?", l.ID)
	}
	edgeLogger.Printf("[CACHE-SYNC] Synchronized %d buffered diagnostic logs upstream.\n", len(logsToSync))
}


func syncPostgresToSQLiteCache() {
	if isOffline { return }
	rows, err := dbConn.Query("SELECT c.facility_code, c.card_id, u.employee_name, u.is_active, c.is_active, u.last_area, c.activation_date, c.expiration_date, c.pin_code FROM credentials c JOIN users u ON c.user_id = u.user_id")
	if err != nil { return }
	defer rows.Close()

	localCache.Exec("DELETE FROM local_credentials")
	tx, _ := localCache.Begin()
	for rows.Next() {
		var fc, cid int
		var uActBool, cActBool bool
		var name, area string
		var actDate, expDate sql.NullTime
		var pin sql.NullString
		rows.Scan(&fc, &cid, &name, &uActBool, &cActBool, &area, &actDate, &expDate, &pin)
		
		uActInt := 0
		if uActBool { uActInt = 1 }
		cActInt := 0
		if cActBool { cActInt = 1 }

		var actStr, expStr, pinStr interface{}
		if actDate.Valid { actStr = actDate.Time.Format("2006-01-02") } else { actStr = nil }
		if expDate.Valid { expStr = expDate.Time.Format("2006-01-02") } else { expStr = nil }
		if pin.Valid { pinStr = pin.String } else { pinStr = nil }

		tx.Exec("INSERT INTO local_credentials VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", fc, cid, name, uActInt, cActInt, area, actStr, expStr, pinStr)
	}
	tx.Commit()
	edgeLogger.Println("[CACHE-SYNC] Local SQLite survivability mirror table refreshed.")
}

func collectSystemHealth() (float64, float64, int) {
	cpuLoad := 0.0
	if f, err := os.Open("/proc/loadavg"); err == nil {
		defer f.Close()
		var load1, load5, load15 float64
		if _, err := fmt.Fscanf(f, "%f %f %f", &load1, &load5, &load15); err == nil {
			cpuLoad = load1 * 100.0
		}
	}

	memUsage := 0.0
	if f, err := os.Open("/proc/meminfo"); err == nil {
		defer f.Close()
		var memTotal, memAvailable uint64
		var label string
		for {
			var val uint64
			var unit string
			_, err := fmt.Fscanf(f, "%s %d %s\n", &label, &val, &unit)
			if err != nil {
				break
			}
			if label == "MemTotal:" {
				memTotal = val
			} else if label == "MemAvailable:" {
				memAvailable = val
			}
		}
		if memTotal > 0 {
			memUsage = (1.0 - float64(memAvailable)/float64(memTotal)) * 100.0
		}
	}

	bufferedLogsCount := 0
	if localCache != nil {
		localCache.QueryRow("SELECT COUNT(*) FROM controller_logs").Scan(&bufferedLogsCount)
	}

	return cpuLoad, memUsage, bufferedLogsCount
}

func pushSystemHealthTelemetry() {
	if isOffline || dbConn == nil {
		return
	}
	cpu, mem, bufCount := collectSystemHealth()
	
	start := time.Now()
	var dummy int
	err := dbConn.QueryRow("SELECT 1").Scan(&dummy)
	pingMs := int(time.Since(start).Milliseconds())
	if err != nil {
		pingMs = 999
	}

	_, err = dbConn.Exec(`
		UPDATE controllers 
		SET cpu_usage = $1, memory_usage = $2, buffered_logs = $3, last_ping_ms = $4, last_heartbeat = NOW()
		WHERE controller_id = $5`, 
		cpu, mem, bufCount, pingMs, runtimeState.ControllerID)
	if err != nil {
		edgeLogger.Printf("[DB-ERR] Failed uploading health telemetry metrics: %v\n", err)
	}
}

func pushLocalConfigToDatabaseReference(cfg HardwareProfile, syncReason string) {
	if isOffline { return }
	
	query := `
		INSERT INTO controller_configs (
			controller_id, gpio_chip_device, wiegand_d0_pin, wiegand_d1_pin, lock_relay_pin,
			reader_red_led_pin, reader_green_led_pin, reader_buzzer_pin, dsm_pin, rex_pin,
			wiegand_timeout_ms, dho_timeout_secs, apb_strict, dfo_enabled, dho_enabled,
			dho_pre_alarm_secs, alarm_horn_pin, dsm_normally_closed
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
		ON CONFLICT (controller_id) DO UPDATE SET
			gpio_chip_device = EXCLUDED.gpio_chip_device, wiegand_d0_pin = EXCLUDED.wiegand_d0_pin,
			wiegand_d1_pin = EXCLUDED.wiegand_d1_pin, lock_relay_pin = EXCLUDED.lock_relay_pin,
			reader_red_led_pin = EXCLUDED.reader_red_led_pin, reader_green_led_pin = EXCLUDED.reader_green_led_pin,
			reader_buzzer_pin = EXCLUDED.reader_buzzer_pin, dsm_pin = EXCLUDED.dsm_pin, rex_pin = EXCLUDED.rex_pin,
			wiegand_timeout_ms = EXCLUDED.wiegand_timeout_ms, dho_timeout_secs = EXCLUDED.dho_timeout_secs,
			apb_strict = EXCLUDED.apb_strict, dfo_enabled = EXCLUDED.dfo_enabled, dho_enabled = EXCLUDED.dho_enabled,
			dho_pre_alarm_secs = EXCLUDED.dho_pre_alarm_secs, alarm_horn_pin = EXCLUDED.alarm_horn_pin,
			dsm_normally_closed = EXCLUDED.dsm_normally_closed;`

	_, err := dbConn.Exec(query,
		runtimeState.ControllerID, cfg.Chip, cfg.D0, cfg.D1, cfg.Rely,
		cfg.RedLed, cfg.GrnLed, cfg.Buzz, cfg.Dsm, cfg.Rex,
		cfg.Tout, cfg.DhoTimeout, cfg.ApbStrict, cfg.DfoEnabled, cfg.DhoEnabled,
		cfg.DhoPreAlarmSecs, cfg.AlarmHornPin, cfg.DsmNormallyClosed)

	if err != nil {
		edgeLogger.Printf("[DB-ERR] Remote DB configuration sync failed (%s): %v\n", syncReason, err)
	} else {
		edgeLogger.Printf("[DB-SYNC] Central PostgreSQL variables synchronized successfully (%s).\n", syncReason)
	}
}

func reportAlarm(alarmType string, details string) {
	edgeLogger.Printf("[ALARM REPORT] Type: %s | Description: %s\n", alarmType, details)
	if isOffline { return }

	// ROUTING ADAPTER LAYER: Intercept basic open/close transitions and commit them to access_logs
	if alarmType == "DOOR_OPEN" || alarmType == "DOOR_CLOSE" {
		query := "INSERT INTO access_logs (controller_id, card_id, employee_name, event_type, details) VALUES ($1, 0, 'HARDWARE_SENSOR', $2, $3)"
		_, err := dbConn.Exec(query, runtimeState.ControllerID, alarmType, details)
		if err != nil {
			edgeLogger.Printf("[DB-ERR] Failed uploading door telemetry layout to access_logs: %v\n", err)
		} else {
			edgeLogger.Printf("[DB-SYNC] Door state transition '%s' recorded in tracking registers.\n", alarmType)
		}
		return
	}

	// SECURITY ALERT LAYER: Direct genuine security breaches into system_alarms table
	_, err := dbConn.Exec("INSERT INTO system_alarms (controller_id, alarm_type, details) VALUES ($1, $2, $3)", 
		runtimeState.ControllerID, alarmType, details)
	if err != nil {
		edgeLogger.Printf("[DB-ERR] Failed uploading alarm metrics to database index: %v\n", err)
	}
}

func saveConfigurationToDisk(updatedHardware HardwareProfile) error {
	runtimeState.HardwareMapping = updatedHardware
	marshaledBytes, err := json.MarshalIndent(runtimeState, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(configPath, marshaledBytes, 0644)
}

func handleRemoteUnlockRequest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	authHeader := r.Header.Get("Authorization")
	if !strings.HasPrefix(authHeader, "Bearer ") {
		http.Error(w, "Unauthorized: Missing token profile", http.StatusUnauthorized)
		return
	}
	if strings.TrimPrefix(authHeader, "Bearer ") != runtimeState.APIToken {
		http.Error(w, "Forbidden: Invalid authorization scope", http.StatusForbidden)
		return
	}

	var req APICommandRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Bad Request: JSON decoding failure", http.StatusBadRequest)
		return
	}

	if req.ControllerID != runtimeState.ControllerID {
		edgeLogger.Printf("[API-WARNING] Command ID mismatch target configuration profile: %s\n", req.ControllerID)
		http.Error(w, "Not Found: Node identifier mismatch", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	logDetails := ""
	eventType := "API_COMMAND"

	switch req.Command {
	case "REMOTE_UNLOCK":
		edgeLogger.Println("[API] Remote unlock executed via network endpoint interface.")
		reader.ExecuteUnlockCycle()
		logDetails = "API Command executed: REMOTE_UNLOCK. Manual bypass perimeter strike authorized."
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"success", "message":"Temporary door unlock cycle activated."}`))

	case "FORCE_LOCK":
		edgeLogger.Println("[API-SECURITY] Emergency Lockdown command active. All entry access suspended.")
		reader.LockdownActive = true
		logDetails = "CRITICAL API DIRECTIVE: FORCE_LOCK. Edge processing shifted into high-security lock state."
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"success", "message":"Emergency lockdown engaged. Reader inputs ignored."}`))

	case "REMOVE_LOCKDOWN":
		edgeLogger.Println("[API-SECURITY] Emergency Lockdown retracted. Resuming standard validation cycles.")
		reader.LockdownActive = false
		logDetails = "API Command: REMOVE_LOCKDOWN. Edge controller returned to default validation behavior."
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"success", "message":"Lockdown released. Normal operations active."}`))

	case "SUSTAIN_OPEN":
		edgeLogger.Println("[API] Open Hours override activated. Relay energized indefinitely.")
		reader.SustainActive = true
		reader.relayLine.SetValue(1)
		logDetails = "API Command: SUSTAIN_OPEN. Latch relay driven high continuously for free-passage scheduling."
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"success", "message":"Sustain mode active. Door open indefinitely."}`))

	case "CLOSE_SUSTAIN":
		edgeLogger.Println("[API] Open Hours override cleared. Relocking door perimeter.")
		reader.SustainActive = false
		reader.relayLine.SetValue(0)
		logDetails = "API Command: CLOSE_SUSTAIN. Free passage scheduling terminated. Latch secured."
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"success", "message":"Sustain mode canceled. Perimeter locked."}`))

	case "CLEAR_ALARMS":
		edgeLogger.Println("[API] Clearing edge alarm output lines and buzzers.")
		reader.buzzLine.SetValue(0)
		reader.hornLine.SetValue(0)
		reader.DoorOpenedAt = time.Time{}
		reader.DhoTriggered = false
		reader.PreAlarmActive = false
		reader.DfoTriggered = false
		reader.ExpectOpen = false
		logDetails = "API Command: CLEAR_ALARMS. Edge alerting arrays returned to secure low states."
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"success", "message":"Active edge alarms cleared."}`))

	case "UPDATE_CONFIG":
		if req.NewConfig == nil {
			http.Error(w, "Bad Request: Missing new_config_payload definition block", http.StatusBadRequest)
			return
		}
		
		eventType = "API_CONFIG_CHANGE"
		oldConfigJSON, _ := json.Marshal(runtimeState.HardwareMapping)
		newConfigJSON, _ := json.Marshal(req.NewConfig)
		
		logDetails = fmt.Sprintf("DYNAMIC RECONFIGURATION ROUTINE | Previous Profile: %s -> New Execution Profile Payload: %s", string(oldConfigJSON), string(newConfigJSON))
		edgeLogger.Println("[API-RECONFIG] Inbound dynamic parameter adjustment parsed. Synchronizing profiles...")
		
		reader.CloseHardware()
		
		if err := saveConfigurationToDisk(*req.NewConfig); err != nil {
			edgeLogger.Printf("[API-ERR] Local filesystem storage configuration save failed: %v\n", err)
			http.Error(w, "Internal Server Error: Unable to store settings asset", http.StatusInternalServerError)
			return
		}
		edgeLogger.Println("[API-RECONFIG] Sync Step 1/3 Complete: Configuration written to config.json file on disk.")
		
		runtimeState.HardwareMapping = *req.NewConfig
		reader.Cfg = *req.NewConfig
		
		if err := reader.InitializeHardware(); err != nil {
			edgeLogger.Printf("[API-CRITICAL-ERR] Sync Step 2/3 Failed: Re-binding initialization crashed: %v\n", err)
			http.Error(w, fmt.Sprintf("Hardware Re-bind Failure: %v", err), http.StatusInternalServerError)
			return
		}
		edgeLogger.Println("[API-RECONFIG] Sync Step 2/3 Complete: Physical character lines reallocated and bound safely.")
		
		pushLocalConfigToDatabaseReference(*req.NewConfig, "DYNAMIC_API_CHANGE")
		edgeLogger.Println("[API-RECONFIG] Sync Step 3/3 Complete: Central PostgreSQL tables updated via event-driven hook call.")
		
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"success", "message":"Hardware configuration stored locally, applied live, and synchronized upstream instantly."}`))

	default:
		http.Error(w, "Unprocessable Entity: Unknown target command profile parameter context", http.StatusUnprocessableEntity)
		return
	}

	if !isOffline {
		_, err := dbConn.Exec("INSERT INTO access_logs (controller_id, card_id, employee_name, event_type, details) VALUES ($1, 0, 'API_OPERATOR', $2, $3)",
			runtimeState.ControllerID, eventType, logDetails)
		if err != nil {
			edgeLogger.Printf("[AUDIT-ERR] Failed logging transaction details to remote database indices: %v\n", err)
		} else {
			edgeLogger.Println("[AUDIT-SYNC] Configuration adjustment audit transaction log uploaded upstream successfully.")
		}
	}
}

func FixHardwareInversion(s string) string {
	runes := []rune(s)
	for i, r := range runes {
		if r == '0' { runes[i] = '1' } else { runes[i] = '0' }
	}
	return string(runes)
}

func AlignAndParseWiegand(rawStream string, targetBits int) (uint64, uint64, bool) {
	corrected := FixHardwareInversion(rawStream)
	currentLength := len(corrected)
	if currentLength < 12 { return 0, 0, false }
	
	if currentLength == 35 {
		fc, err1 := strconv.ParseUint(corrected[2:14], 2, 16)
		cid, err2 := strconv.ParseUint(corrected[14:34], 2, 32)
		if err1 != nil || err2 != nil { return 0, 0, false }
		return fc, cid, true
	}
	if currentLength == 34 {
		streamB := corrected + "0"
		fc, err1 := strconv.ParseUint(streamB[2:14], 2, 16)
		cid, err2 := strconv.ParseUint(streamB[14:34], 2, 32)
		if err1 != nil || err2 != nil { return 0, 0, false }
		return fc, cid, true
	}
	return 0, 0, false
}

func main() {
	initLogger()
	initLocalCache()
	
	var err error
	runtimeState, err = LoadConfig(configPath)
	if err != nil {
		edgeLogger.Fatalf("[BOOT-FATAL] Failed to parse config payload file: %v", err)
	}
	
	dbInfo := fmt.Sprintf("host=%s port=%d user=%s password=%s dbname=%s sslmode=%s",
		runtimeState.DatabaseConfig.DBHost, runtimeState.DatabaseConfig.DBPort,
		runtimeState.DatabaseConfig.DBUser, runtimeState.DatabaseConfig.DBPassword,
		runtimeState.DatabaseConfig.DBName, runtimeState.DatabaseConfig.SSLMode)
	
	dbConn, err = sql.Open("postgres", dbInfo)
	if err == nil && dbConn.Ping() == nil {
		edgeLogger.Println("[DB-ONLINE] PostgreSQL Core Engine Connected.")
		isOffline = false
		
		pushLocalConfigToDatabaseReference(runtimeState.HardwareMapping, "BOOT_INITIALIZATION")
		syncPostgresToSQLiteCache()
		syncBufferedLogsToPostgres()
		pushSystemHealthTelemetry()
	} else {
		edgeLogger.Println("[DB-OFFLINE] Activating Degraded Offline Mode Mirror Cache Engine.")
		isOffline = true
	}

	reader = NewWiegandReader(runtimeState.HardwareMapping)
	reader.SetLogger(edgeLogger) 
	if err := reader.InitializeHardware(); err != nil {
		edgeLogger.Fatalf("[HARDWARE-FATAL] Driver initialization failure: %v", err)
	}

	stopSignal := make(chan struct{})
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	reader.StartListening(stopSignal, reportAlarm)

	http.HandleFunc("/api/v1/controller/remote-unlock", handleRemoteUnlockRequest)
	serverAddress := fmt.Sprintf("0.0.0.0:%d", runtimeState.BackendPort)
	
	go func() {
		edgeLogger.Printf("[API-SERVER] Listening securely (HTTPS) on port %s\n", serverAddress)
		if err := http.ListenAndServeTLS(serverAddress, "server.crt", "server.key", nil); err != nil && err != http.ErrServerClosed {
			edgeLogger.Printf("[API-SERVER-ERR] Server listener crashed: %v\n", err)
		}
	}()

	go func() {
		ticker := time.NewTicker(60 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-stopSignal:
				return
			case <-ticker.C:
				if dbConn.Ping() != nil {
					if !isOffline {
						isOffline = true
						edgeLogger.Println("[NETWORK-ALERT] Central database connection dropped. Entering offline isolation state...")
					}
					continue
				}
				
				if isOffline {
					isOffline = false
					edgeLogger.Println("[NETWORK-RESTORED] Connection upstream restored. Syncing parameters back to server hub cluster...")
				}
				
				pushLocalConfigToDatabaseReference(runtimeState.HardwareMapping, "PERIODIC_HEARTBEAT_SYNC")
				syncPostgresToSQLiteCache()
				syncBufferedLogsToPostgres()
				pushSystemHealthTelemetry()
			}
		}
	}()

	go func() {
		for bitStream := range reader.OutputChannel {
			fc, cid, valid := AlignAndParseWiegand(bitStream, 35)
			if !valid { continue }

			edgeLogger.Printf("[SWIPE] Raw Bits caught: %d (FC:%d ID:%d)\n", len(bitStream), fc, cid)

			var empName, currentArea string
			var uAct, cAct, hasScheduleAccess, isSuperAdmin bool
			var actDate, expDate sql.NullTime
			var actDateStr, expDateStr sql.NullString

			var threatLevel string = "NORMAL"
			if !isOffline {
				dbConn.QueryRow("SELECT value FROM system_settings WHERE key = 'threat_level'").Scan(&threatLevel)
			}

			if !isOffline {
				query := `
					WITH current_day_type AS (
						SELECT CASE 
							WHEN EXISTS (SELECT 1 FROM holidays WHERE holiday_date = CURRENT_DATE) THEN 7
							ELSE EXTRACT(DOW FROM CURRENT_TIMESTAMP)
						END AS day_type
					)
					SELECT u.employee_name, u.is_active, c.is_active, COALESCE(u.last_area, 'OUTSIDE'),
					       EXISTS (
					           SELECT 1
					           FROM credential_access_levels cal
					           JOIN access_level_time_zones altz ON cal.access_level_id = altz.access_level_id
					           JOIN time_zone_intervals tzi ON altz.time_zone_id = tzi.time_zone_id
					           CROSS JOIN current_day_type cdt
					           WHERE cal.credential_id = c.id
					             AND altz.reader_id = $3
					             AND tzi.day_of_week = cdt.day_type
					             AND CURRENT_TIME BETWEEN tzi.start_time AND tzi.end_time
					       ) AS has_schedule_access,
					       c.activation_date, c.expiration_date,
					       EXISTS (
					           SELECT 1
					           FROM credential_access_levels cal
					           JOIN access_levels al ON cal.access_level_id = al.id
					           WHERE cal.credential_id = c.id AND al.name = 'Super Admin'
					       ) AS is_super_admin
					FROM credentials c 
					JOIN users u ON c.user_id = u.user_id 
					WHERE c.facility_code = $1::bigint AND c.card_id = $2::bigint`
				err = dbConn.QueryRow(query, fc, cid, runtimeState.ControllerID).Scan(&empName, &uAct, &cAct, &currentArea, &hasScheduleAccess, &actDate, &expDate, &isSuperAdmin)
			} else {
				var uActInt, cActInt int
				query := "SELECT employee_name, user_active, cred_active, last_area, activation_date, expiration_date FROM local_credentials WHERE facility_code = ? AND card_id = ?"
				err = localCache.QueryRow(query, fc, cid).Scan(&empName, &uActInt, &cActInt, &currentArea, &actDateStr, &expDateStr)
				uAct = (uActInt == 1)
				cAct = (cActInt == 1)
				hasScheduleAccess = true
				isSuperAdmin = false
			}

			if err != nil {
				edgeLogger.Printf("[DENY] Card profile unregistered or lookup failed: FC:%d ID:%d | Error: %v\n", fc, cid, err)
				reader.ExecuteBuzzerPulse(3)
				continue
			}

			// Expiry and activation validations
			nowDate := time.Now()
			if !isOffline {
				if actDate.Valid && nowDate.Before(actDate.Time) {
					edgeLogger.Printf("[DENY-DATE] Credential not yet active: %s (Activates: %s)\n", empName, actDate.Time.Format("2006-01-02"))
					reader.ExecuteBuzzerPulse(3)
					continue
				}
				if expDate.Valid && nowDate.After(expDate.Time) {
					edgeLogger.Printf("[DENY-DATE] Credential expired: %s (Expired: %s)\n", empName, expDate.Time.Format("2006-01-02"))
					reader.ExecuteBuzzerPulse(3)
					continue
				}
			} else {
				if actDateStr.Valid && actDateStr.String != "" {
					if t, parseErr := time.Parse("2006-01-02", actDateStr.String); parseErr == nil && nowDate.Before(t) {
						edgeLogger.Printf("[DENY-DATE] Credential not yet active: %s (Activates: %s)\n", empName, actDateStr.String)
						reader.ExecuteBuzzerPulse(3)
						continue
					}
				}
				if expDateStr.Valid && expDateStr.String != "" {
					if t, parseErr := time.Parse("2006-01-02", expDateStr.String); parseErr == nil && nowDate.After(t) {
						edgeLogger.Printf("[DENY-DATE] Credential expired: %s (Expired: %s)\n", empName, expDateStr.String)
						reader.ExecuteBuzzerPulse(3)
						continue
					}
				}
			}

			// System-wide threat level conditions
			if threatLevel == "LOCKDOWN" || reader.LockdownActive {
				edgeLogger.Printf("[DENY-LOCKDOWN] Lockdown active. Swipe by user %s rejected.\n", empName)
				reader.ExecuteBuzzerPulse(5)
				continue
			}

			if threatLevel == "HIGH_ALERT" && !isSuperAdmin {
				edgeLogger.Printf("[DENY-HIGH_ALERT] High Alert active. Swipe by non-super-admin %s rejected.\n", empName)
				reader.ExecuteBuzzerPulse(4)
				continue
			}

			if !hasScheduleAccess {
				edgeLogger.Printf("[DENY-SCHEDULE] Access schedule constraint active for employee %s (FC:%d ID:%d).\n", empName, fc, cid)
				reader.ExecuteBuzzerPulse(3)
				
				if !isOffline {
					denyDetails := fmt.Sprintf("Access denied due to schedule constraint. Card outside active timezone or holiday override. FC:%d ID:%d matched %s.", fc, cid, empName)
					dbConn.Exec("INSERT INTO access_logs (controller_id, card_id, employee_name, event_type, details) VALUES ($1, $2, $3, 'DENY_SCHEDULE', $4)",
						runtimeState.ControllerID, cid, empName, denyDetails)
				}
				continue
			}

			// FIXED POSTURE CHECK: Scan for boolean flags directly
			if !uAct || !cAct {
				edgeLogger.Printf("[DENY] Access profile state inactive for employee %s.\n", empName)
				reader.ExecuteBuzzerPulse(3)
				continue
			}

			targetArea := "SECURE_ZONE"
			if currentArea == targetArea {
				reportAlarm("APB_VIOLATION", fmt.Sprintf("Anti-Passback violation tracking caught for user %s.", empName))
				if runtimeState.HardwareMapping.ApbStrict {
					edgeLogger.Printf("[APB-REJECT] Strict APB active boundary blocking for user %s.\n", empName)
					reader.ExecuteBuzzerPulse(3)
					continue
				}
			}

			if !isOffline {
				dbConn.Exec("UPDATE users SET last_area = $1 WHERE employee_name = $2", targetArea, empName)
			}
			localCache.Exec("UPDATE local_credentials SET last_area = ? WHERE employee_name = ?", targetArea, empName)

			edgeLogger.Printf("[GRANT] Authorization verified: %s. Releasing latch relay strike pins.\n", empName)
			
			if !isOffline {
				grantDetails := fmt.Sprintf("Card swipe authorization successful. FC:%d ID:%d matched employee record.", fc, cid)
				dbConn.Exec("INSERT INTO access_logs (controller_id, card_id, employee_name, event_type, details) VALUES ($1, $2, $3, 'CARD_GRANT', $4)",
					runtimeState.ControllerID, cid, empName, grantDetails)
			}
			
			reader.ExecuteUnlockCycle()
		}
	}()

	<-sigChan
	close(stopSignal)
	reader.CloseHardware()
	localCache.Close()
	dbConn.Close()
	edgeLogger.Println("[SHUTDOWN] Controller offline.")
}
package main

import (
	"crypto/rand"
	"crypto/tls"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/lib/pq"
)

var (
	dbConn     *sql.DB
	clients    = make(map[chan string]bool)
	mu         sync.Mutex
	authTokens = make(map[string]time.Time) // session token -> expiry
	authMu     sync.Mutex
)

type TimeZone struct {
	ID        int                 `json:"id"`
	Name      string              `json:"name"`
	Intervals []TimeZoneInterval `json:"intervals"`
}

type TimeZoneInterval struct {
	ID         int    `json:"id,omitempty"`
	TimeZoneID int    `json:"time_zone_id,omitempty"`
	DayOfWeek  int    `json:"day_of_week"`
	StartTime  string `json:"start_time"`
	EndTime    string `json:"end_time"`
}

type Holiday struct {
	HolidayDate string `json:"holiday_date"`
	Name        string `json:"name"`
}

type Mapping struct {
	ReaderID   string `json:"reader_id"`
	TimeZoneID int    `json:"time_zone_id"`
	TZName     string `json:"timezone_name,omitempty"`
}

type AccessLevel struct {
	ID          int       `json:"id"`
	Name        string    `json:"name"`
	ReaderID    string    `json:"reader_id,omitempty"`
	TimeZoneID  int       `json:"time_zone_id,omitempty"`
	TZName      string    `json:"timezone_name,omitempty"`
	DhoOverride bool      `json:"dho_override"`
	Mappings    []Mapping `json:"mappings,omitempty"`
}

type Credential struct {
	ID             int     `json:"id"`
	UserID         int     `json:"user_id"`
	EmployeeName   string  `json:"employee_name"`
	BitLength      int     `json:"bit_length"`
	FacilityCode   int     `json:"facility_code"`
	CardID         int     `json:"card_id"`
	IsActive       bool    `json:"is_active"`
	AccessLevels   []int   `json:"access_levels,omitempty"`
	ActivationDate string  `json:"activation_date"`
	ExpirationDate string  `json:"expiration_date"`
	PinCode        *string `json:"pin_code"`
}

func main() {
	connStr := os.Getenv("DATABASE_URL")
	if connStr == "" {
		connStr = "host=192.168.0.141 port=5432 user=edge_ctrl password=Allcanget11 dbname=piacs_security sslmode=disable"
	}
	var err error
	dbConn, err = sql.Open("postgres", connStr)
	if err != nil {
		log.Fatalf("Failed to open DB: %v", err)
	}
	defer dbConn.Close()

	if err = dbConn.Ping(); err != nil {
		log.Fatalf("Failed to ping DB: %v", err)
	}
	log.Println("Successfully connected to PostgreSQL at 192.168.0.141")

	// Start PG Notification Listener
	go startPGListener(connStr)

	// Start Controller Health Poller
	go startControllerHealthPoller()

	// Static Web Assets
	fs := http.FileServer(http.Dir("./web"))
	http.Handle("/", fs)

	// API Handlers
	http.HandleFunc("/api/events", handleGetEvents)
	http.HandleFunc("/api/events/stream", handleEventsStream)
	http.HandleFunc("/api/schedules", handleSchedules)
	http.HandleFunc("/api/holidays", handleHolidays)
	http.HandleFunc("/api/credentials", handleCredentials)
	http.HandleFunc("/api/access-levels", handleAccessLevels)
	http.HandleFunc("/api/controllers", handleControllers)
	http.HandleFunc("/api/controller/command", handleControllerCommand)
	http.HandleFunc("/api/controller-logs", handleControllerLogs)
	http.HandleFunc("/api/threat-level", handleThreatLevel)
	http.HandleFunc("/api/system-health", handleSystemHealth)
	http.HandleFunc("/api/map-placements", handleMapPlacements)
	http.HandleFunc("/api/apb-status", handleAPBStatus)
	http.HandleFunc("/api/auth/login", handleAuthLogin)
	http.HandleFunc("/api/controller-config", requireAuth(handleControllerConfig))

	log.Println("Central Web Server starting on http://0.0.0.0:8000")
	if err := http.ListenAndServe("0.0.0.0:8000", nil); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}

func startPGListener(connStr string) {
	reportErr := func(event pq.ListenerEventType, err error) {
		if err != nil {
			log.Printf("Listener error: %v", err)
		}
	}

	listener := pq.NewListener(connStr, 10*time.Second, time.Minute, reportErr)
	if err := listener.Listen("access_event"); err != nil {
		log.Fatalf("Listen failed: %v", err)
	}
	log.Println("Listening for database trigger notifications...")

	for {
		select {
		case notify := <-listener.Notify:
			if notify == nil {
				continue
			}
			broadcastMessage(notify.Extra)
		}
	}
}

func broadcastMessage(msg string) {
	mu.Lock()
	defer mu.Unlock()
	for ch := range clients {
		select {
		case ch <- msg:
		default:
			// If buffer is full, skip or close to prevent blocking
		}
	}
}

func handleEventsStream(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming unsupported", http.StatusInternalServerError)
		return
	}

	ch := make(chan string, 10)
	mu.Lock()
	clients[ch] = true
	mu.Unlock()

	defer func() {
		mu.Lock()
		delete(clients, ch)
		mu.Unlock()
		close(ch)
	}()

	// Send initial connection event
	fmt.Fprintf(w, "data: {\"event_source\":\"system\",\"message\":\"connected\"}\n\n")
	flusher.Flush()

	for {
		select {
		case msg, open := <-ch:
			if !open {
				return
			}
			fmt.Fprintf(w, "data: %s\n\n", msg)
			flusher.Flush()
		case <-r.Context().Done():
			return
		}
	}
}

func handleGetEvents(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	
	// Fetch last 50 entries combining access logs and alarms
	query := `
		(SELECT 'access_logs' AS source, id::text, event_timestamp AS created_at, controller_id, event_type, details, employee_name, card_id::text FROM access_logs)
		UNION ALL
		(SELECT 'system_alarms' AS source, alarm_id::text, created_at, controller_id, alarm_type, details, '' AS employee_name, '' AS card_id FROM system_alarms)
		ORDER BY created_at DESC LIMIT 50`
	
	rows, err := dbConn.Query(query)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	type Event struct {
		Source       string    `json:"event_source"`
		ID           string    `json:"id"`
		CreatedAt    time.Time `json:"created_at"`
		ControllerID string    `json:"controller_id"`
		Type         string    `json:"event_type"`
		Details      string    `json:"details"`
		EmployeeName string    `json:"employee_name,omitempty"`
		CardID       string    `json:"card_id,omitempty"`
	}

	events := []Event{}
	for rows.Next() {
		var e Event
		var card sql.NullString
		err := rows.Scan(&e.Source, &e.ID, &e.CreatedAt, &e.ControllerID, &e.Type, &e.Details, &e.EmployeeName, &card)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if card.Valid {
			e.CardID = card.String
		}
		events = append(events, e)
	}

	json.NewEncoder(w).Encode(events)
}

func handleSchedules(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method == http.MethodGet {
		// Fetch schedules
		tzRows, err := dbConn.Query("SELECT id, name FROM time_zones ORDER BY id")
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		defer tzRows.Close()

		tzs := []TimeZone{}
		for tzRows.Next() {
			var tz TimeZone
			tzRows.Scan(&tz.ID, &tz.Name)
			tzs = append(tzs, tz)
		}

		for i := range tzs {
			intRows, err := dbConn.Query("SELECT id, day_of_week, start_time, end_time FROM time_zone_intervals WHERE time_zone_id = $1 ORDER BY day_of_week", tzs[i].ID)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			tzs[i].Intervals = []TimeZoneInterval{}
			for intRows.Next() {
				var iv TimeZoneInterval
				var start, end time.Time
				intRows.Scan(&iv.ID, &iv.DayOfWeek, &start, &end)
				iv.StartTime = start.Format("15:04:00")
				iv.EndTime = end.Format("15:04:00")
				tzs[i].Intervals = append(tzs[i].Intervals, iv)
			}
			intRows.Close()
		}
		json.NewEncoder(w).Encode(tzs)

	} else if r.Method == http.MethodPost {
		// Create schedule
		var tz TimeZone
		if err := json.NewDecoder(r.Body).Decode(&tz); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		tx, err := dbConn.Begin()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		var tzID int
		err = tx.QueryRow("INSERT INTO time_zones (name) VALUES ($1) RETURNING id", tz.Name).Scan(&tzID)
		if err != nil {
			tx.Rollback()
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		for _, iv := range tz.Intervals {
			_, err = tx.Exec("INSERT INTO time_zone_intervals (time_zone_id, day_of_week, start_time, end_time) VALUES ($1, $2, $3, $4)",
				tzID, iv.DayOfWeek, iv.StartTime, iv.EndTime)
			if err != nil {
				tx.Rollback()
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
		}

		tx.Commit()
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]interface{}{"status": "success", "id": tzID})
	}
}

func handleHolidays(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method == http.MethodGet {
		rows, err := dbConn.Query("SELECT holiday_date, name FROM holidays ORDER BY holiday_date")
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		defer rows.Close()

		holidays := []Holiday{}
		for rows.Next() {
			var h Holiday
			var t time.Time
			rows.Scan(&t, &h.Name)
			h.HolidayDate = t.Format("2006-01-02")
			holidays = append(holidays, h)
		}
		json.NewEncoder(w).Encode(holidays)

	} else if r.Method == http.MethodPost {
		var h Holiday
		if err := json.NewDecoder(r.Body).Decode(&h); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		_, err := dbConn.Exec("INSERT INTO holidays (holiday_date, name) VALUES ($1, $2) ON CONFLICT (holiday_date) DO UPDATE SET name = EXCLUDED.name", h.HolidayDate, h.Name)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]string{"status": "success"})
	}
}

func handleCredentials(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method == http.MethodGet {
		rows, err := dbConn.Query(`
			SELECT c.id, c.user_id, u.employee_name, c.bit_length, c.facility_code, c.card_id, c.is_active,
			       c.activation_date, c.expiration_date, c.pin_code
			FROM credentials c JOIN users u ON c.user_id = u.user_id ORDER BY c.id`)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		defer rows.Close()

		creds := []Credential{}
		for rows.Next() {
			var c Credential
			var actTime, expTime time.Time
			var pin sql.NullString
			err = rows.Scan(&c.ID, &c.UserID, &c.EmployeeName, &c.BitLength, &c.FacilityCode, &c.CardID, &c.IsActive, &actTime, &expTime, &pin)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			c.ActivationDate = actTime.Format("2006-01-02")
			c.ExpirationDate = expTime.Format("2006-01-02")
			if pin.Valid {
				c.PinCode = &pin.String
			}
			creds = append(creds, c)
		}

		for i := range creds {
			alRows, err := dbConn.Query("SELECT access_level_id FROM credential_access_levels WHERE credential_id = $1", creds[i].ID)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			creds[i].AccessLevels = []int{}
			for alRows.Next() {
				var alID int
				alRows.Scan(&alID)
				creds[i].AccessLevels = append(creds[i].AccessLevels, alID)
			}
			alRows.Close()
		}

		json.NewEncoder(w).Encode(creds)

	} else if r.Method == http.MethodPost {
		var c Credential
		if err := json.NewDecoder(r.Body).Decode(&c); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		tx, err := dbConn.Begin()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		var userID int
		err = tx.QueryRow("SELECT user_id FROM users WHERE employee_name = $1", c.EmployeeName).Scan(&userID)
		if err == sql.ErrNoRows {
			err = tx.QueryRow("INSERT INTO users (employee_name) VALUES ($1) RETURNING user_id", c.EmployeeName).Scan(&userID)
			if err != nil {
				tx.Rollback()
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
		} else if err != nil {
			tx.Rollback()
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		actDate := c.ActivationDate
		if actDate == "" {
			actDate = time.Now().Format("2006-01-02")
		}
		expDate := c.ExpirationDate
		if expDate == "" {
			expDate = time.Now().AddDate(1, 0, 0).Format("2006-01-02")
		}

		var credID int
		err = tx.QueryRow(`
			INSERT INTO credentials (user_id, bit_length, facility_code, card_id, is_active, activation_date, expiration_date, pin_code) 
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
			userID, c.BitLength, c.FacilityCode, c.CardID, c.IsActive, actDate, expDate, c.PinCode).Scan(&credID)
		if err != nil {
			tx.Rollback()
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		for _, alID := range c.AccessLevels {
			_, err = tx.Exec("INSERT INTO credential_access_levels (credential_id, access_level_id) VALUES ($1, $2)", credID, alID)
			if err != nil {
				tx.Rollback()
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
		}

		tx.Commit()
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]interface{}{"status": "success", "id": credID})

	} else if r.Method == http.MethodPut {
		var c Credential
		if err := json.NewDecoder(r.Body).Decode(&c); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		tx, err := dbConn.Begin()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		_, err = tx.Exec("UPDATE users SET employee_name = $1, is_active = $2 WHERE user_id = $3", c.EmployeeName, c.IsActive, c.UserID)
		if err != nil {
			tx.Rollback()
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		_, err = tx.Exec(`
			UPDATE credentials 
			SET bit_length = $1, facility_code = $2, card_id = $3, is_active = $4, 
			    activation_date = $5, expiration_date = $6, pin_code = $7
			WHERE id = $8`,
			c.BitLength, c.FacilityCode, c.CardID, c.IsActive, c.ActivationDate, c.ExpirationDate, c.PinCode, c.ID)
		if err != nil {
			tx.Rollback()
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		_, err = tx.Exec("DELETE FROM credential_access_levels WHERE credential_id = $1", c.ID)
		if err != nil {
			tx.Rollback()
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		for _, alID := range c.AccessLevels {
			_, err = tx.Exec("INSERT INTO credential_access_levels (credential_id, access_level_id) VALUES ($1, $2)", c.ID, alID)
			if err != nil {
				tx.Rollback()
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
		}

		tx.Commit()
		json.NewEncoder(w).Encode(map[string]interface{}{"status": "success"})

	} else if r.Method == http.MethodDelete {
		idStr := r.URL.Query().Get("id")
		if idStr == "" {
			http.Error(w, "Missing id", http.StatusBadRequest)
			return
		}
		id, err := strconv.Atoi(idStr)
		if err != nil {
			http.Error(w, "Invalid id", http.StatusBadRequest)
			return
		}

		tx, err := dbConn.Begin()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		_, err = tx.Exec("DELETE FROM credentials WHERE id = $1", id)
		if err != nil {
			tx.Rollback()
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		tx.Commit()
		json.NewEncoder(w).Encode(map[string]interface{}{"status": "success"})
	}
}

func handleAccessLevels(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method == http.MethodGet {
		rows, err := dbConn.Query(`
			SELECT al.id, al.name, al.dho_override, COALESCE(altz.reader_id, ''), COALESCE(altz.time_zone_id, 0), COALESCE(tz.name, '')
			FROM access_levels al
			LEFT JOIN access_level_time_zones altz ON al.id = altz.access_level_id
			LEFT JOIN time_zones tz ON altz.time_zone_id = tz.id
			ORDER BY al.id`)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		defer rows.Close()

		alMap := make(map[int]*AccessLevel)
		var alOrder []int

		for rows.Next() {
			var id int
			var name string
			var dhoOverride bool
			var readerID string
			var tzID int
			var tzName string
			
			if err := rows.Scan(&id, &name, &dhoOverride, &readerID, &tzID, &tzName); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}

			al, exists := alMap[id]
			if !exists {
				al = &AccessLevel{
					ID:          id,
					Name:        name,
					DhoOverride: dhoOverride,
					Mappings:    []Mapping{},
				}
				alMap[id] = al
				alOrder = append(alOrder, id)
			}

			if readerID != "" {
				al.Mappings = append(al.Mappings, Mapping{
					ReaderID:   readerID,
					TimeZoneID: tzID,
					TZName:     tzName,
				})
			}
		}

		als := []AccessLevel{}
		for _, id := range alOrder {
			al := alMap[id]
			if len(al.Mappings) > 0 {
				al.ReaderID = al.Mappings[0].ReaderID
				al.TimeZoneID = al.Mappings[0].TimeZoneID
				al.TZName = al.Mappings[0].TZName
			}
			als = append(als, *al)
		}
		json.NewEncoder(w).Encode(als)

	} else if r.Method == http.MethodPost {
		var al AccessLevel
		if err := json.NewDecoder(r.Body).Decode(&al); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		tx, err := dbConn.Begin()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		var alID int
		err = tx.QueryRow("INSERT INTO access_levels (name, dho_override) VALUES ($1, $2) RETURNING id", al.Name, al.DhoOverride).Scan(&alID)
		if err != nil {
			tx.Rollback()
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		if len(al.Mappings) > 0 {
			for _, m := range al.Mappings {
				if m.ReaderID != "" && m.TimeZoneID != 0 {
					_, err = tx.Exec("INSERT INTO access_level_time_zones (access_level_id, reader_id, time_zone_id) VALUES ($1, $2, $3)",
						alID, m.ReaderID, m.TimeZoneID)
					if err != nil {
						tx.Rollback()
						http.Error(w, err.Error(), http.StatusInternalServerError)
						return
					}
				}
			}
		} else if al.ReaderID != "" && al.TimeZoneID != 0 {
			_, err = tx.Exec("INSERT INTO access_level_time_zones (access_level_id, reader_id, time_zone_id) VALUES ($1, $2, $3)",
				alID, al.ReaderID, al.TimeZoneID)
			if err != nil {
				tx.Rollback()
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
		}

		tx.Commit()
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]interface{}{"status": "success", "id": alID})

	} else if r.Method == http.MethodPut {
		// Update existing access level
		idStr := r.URL.Query().Get("id")
		if idStr == "" {
			http.Error(w, "Missing id", http.StatusBadRequest)
			return
		}
		alID, err := strconv.Atoi(idStr)
		if err != nil {
			http.Error(w, "Invalid id", http.StatusBadRequest)
			return
		}

		var al AccessLevel
		if err := json.NewDecoder(r.Body).Decode(&al); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		tx, err := dbConn.Begin()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		_, err = tx.Exec("UPDATE access_levels SET name = $1, dho_override = $2 WHERE id = $3", al.Name, al.DhoOverride, alID)
		if err != nil {
			tx.Rollback()
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		// Replace all mappings
		_, err = tx.Exec("DELETE FROM access_level_time_zones WHERE access_level_id = $1", alID)
		if err != nil {
			tx.Rollback()
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		for _, m := range al.Mappings {
			if m.ReaderID != "" && m.TimeZoneID != 0 {
				_, err = tx.Exec("INSERT INTO access_level_time_zones (access_level_id, reader_id, time_zone_id) VALUES ($1, $2, $3)",
					alID, m.ReaderID, m.TimeZoneID)
				if err != nil {
					tx.Rollback()
					http.Error(w, err.Error(), http.StatusInternalServerError)
					return
				}
			}
		}

		tx.Commit()
		json.NewEncoder(w).Encode(map[string]interface{}{"status": "success"})

	} else if r.Method == http.MethodDelete {
		idStr := r.URL.Query().Get("id")
		if idStr == "" {
			http.Error(w, "Missing id", http.StatusBadRequest)
			return
		}
		alID, err := strconv.Atoi(idStr)
		if err != nil {
			http.Error(w, "Invalid id", http.StatusBadRequest)
			return
		}

		tx, err := dbConn.Begin()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		// Remove credential links first to avoid FK violation
		_, err = tx.Exec("DELETE FROM credential_access_levels WHERE access_level_id = $1", alID)
		if err != nil {
			tx.Rollback()
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		_, err = tx.Exec("DELETE FROM access_level_time_zones WHERE access_level_id = $1", alID)
		if err != nil {
			tx.Rollback()
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		_, err = tx.Exec("DELETE FROM access_levels WHERE id = $1", alID)
		if err != nil {
			tx.Rollback()
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		tx.Commit()
		json.NewEncoder(w).Encode(map[string]string{"status": "success"})
	}
}

func handleControllers(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	type Controller struct {
		ID           string `json:"controller_id"`
		FriendlyName string `json:"friendly_name"`
		IP           string `json:"server_ip"`
		IsOnline     bool   `json:"is_online"`
	}

	if r.Method == http.MethodGet || r.Method == "" {
		rows, err := dbConn.Query("SELECT controller_id, friendly_name, server_ip, is_online FROM controllers ORDER BY controller_id")
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		defer rows.Close()
		ctrls := []Controller{}
		for rows.Next() {
			var c Controller
			rows.Scan(&c.ID, &c.FriendlyName, &c.IP, &c.IsOnline)
			ctrls = append(ctrls, c)
		}
		json.NewEncoder(w).Encode(ctrls)

	} else if r.Method == http.MethodPost {
		var c Controller
		if err := json.NewDecoder(r.Body).Decode(&c); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if c.ID == "" || c.IP == "" {
			http.Error(w, "controller_id and server_ip are required", http.StatusBadRequest)
			return
		}
		if c.FriendlyName == "" {
			c.FriendlyName = c.ID
		}
		_, err := dbConn.Exec(`INSERT INTO controllers (controller_id, friendly_name, server_ip, is_online, token_hash)
			VALUES ($1, $2, $3, false, '')
			ON CONFLICT (controller_id) DO UPDATE SET friendly_name = EXCLUDED.friendly_name, server_ip = EXCLUDED.server_ip`,
			c.ID, c.FriendlyName, c.IP)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]string{"status": "success"})

	} else if r.Method == http.MethodDelete {
		controllerID := r.URL.Query().Get("controller_id")
		if controllerID == "" {
			http.Error(w, "Missing controller_id", http.StatusBadRequest)
			return
		}
		tx, err := dbConn.Begin()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		// Remove from dependent tables first
		tx.Exec("DELETE FROM map_placements WHERE controller_id = $1", controllerID)
		tx.Exec("DELETE FROM controller_configs WHERE controller_id = $1", controllerID)
		tx.Exec("DELETE FROM access_level_time_zones WHERE reader_id = $1", controllerID)
		_, err = tx.Exec("DELETE FROM controllers WHERE controller_id = $1", controllerID)
		if err != nil {
			tx.Rollback()
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		tx.Commit()
		json.NewEncoder(w).Encode(map[string]string{"status": "success"})
	}
}

func handleControllerCommand(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	type CmdReq struct {
		ControllerID string `json:"controller_id"`
		Command      string `json:"command"`
	}

	var req CmdReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	type ControllerInfo struct {
		ID    string
		IP    string
		Token string
	}
	var targets []ControllerInfo

	if req.ControllerID == "ALL" {
		rows, err := dbConn.Query("SELECT controller_id, server_ip, token_hash FROM controllers")
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		defer rows.Close()
		for rows.Next() {
			var c ControllerInfo
			rows.Scan(&c.ID, &c.IP, &c.Token)
			targets = append(targets, c)
		}
	} else {
		var c ControllerInfo
		err := dbConn.QueryRow("SELECT controller_id, server_ip, token_hash FROM controllers WHERE controller_id = $1", req.ControllerID).Scan(&c.ID, &c.IP, &c.Token)
		if err != nil {
			http.Error(w, "Controller not found", http.StatusNotFound)
			return
		}
		targets = append(targets, c)
	}

	// Proxy commands concurrently
	tr := &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
	}
	client := &http.Client{Transport: tr, Timeout: 4 * time.Second}

	var wg sync.WaitGroup
	errChan := make(chan string, len(targets))

	for _, t := range targets {
		wg.Add(1)
		go func(c ControllerInfo) {
			defer wg.Done()
			url := fmt.Sprintf("https://%s:8080/api/v1/controller/remote-unlock", c.IP)
			body, _ := json.Marshal(map[string]string{
				"controller_id": c.ID,
				"command":       req.Command,
			})
			proxyReq, err := http.NewRequest("POST", url, strings.NewReader(string(body)))
			if err != nil {
				errChan <- fmt.Sprintf("controller %s request build error", c.ID)
				return
			}
			proxyReq.Header.Set("Content-Type", "application/json")
			proxyReq.Header.Set("Authorization", "Bearer "+c.Token)

			resp, err := client.Do(proxyReq)
			if err != nil {
				errChan <- fmt.Sprintf("controller %s connection failed: %v", c.ID, err)
				return
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				errChan <- fmt.Sprintf("controller %s returned status %d", c.ID, resp.StatusCode)
			}
		}(t)
	}
	wg.Wait()
	close(errChan)

	var errors []string
	for e := range errChan {
		errors = append(errors, e)
	}

	if len(errors) > 0 {
		w.WriteHeader(http.StatusMultiStatus)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"status": "partial_failure",
			"errors": errors,
		})
	} else {
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]string{"status": "success", "message": "All commands executed successfully."})
	}
}

type ControllerLog struct {
	ID           int       `json:"id"`
	Timestamp    time.Time `json:"log_timestamp"`
	ControllerID string    `json:"controller_id"`
	Level        string    `json:"level"`
	Message      string    `json:"message"`
}

func handleControllerLogs(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	w.Header().Set("Content-Type", "application/json")

	if r.Method != http.MethodGet {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	controllerID := r.URL.Query().Get("controller_id")
	level := r.URL.Query().Get("level")
	limitStr := r.URL.Query().Get("limit")

	limit := 200
	if limitStr != "" {
		if val, err := strconv.Atoi(limitStr); err == nil && val > 0 && val <= 1000 {
			limit = val
		}
	}

	query := "SELECT id, log_timestamp, controller_id, level, message FROM controller_logs"
	var args []interface{}
	var conditions []string
	argIndex := 1

	if controllerID != "" {
		conditions = append(conditions, fmt.Sprintf("controller_id = $%d", argIndex))
		args = append(args, controllerID)
		argIndex++
	}
	if level != "" {
		conditions = append(conditions, fmt.Sprintf("level = $%d", argIndex))
		args = append(args, level)
		argIndex++
	}

	if len(conditions) > 0 {
		query += " WHERE " + strings.Join(conditions, " AND ")
	}

	query += fmt.Sprintf(" ORDER BY log_timestamp DESC LIMIT $%d", argIndex)
	args = append(args, limit)

	rows, err := dbConn.Query(query, args...)
	if err != nil {
		log.Printf("Query error: %v", err)
		http.Error(w, "Database error", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	logs := []ControllerLog{}
	for rows.Next() {
		var l ControllerLog
		if err := rows.Scan(&l.ID, &l.Timestamp, &l.ControllerID, &l.Level, &l.Message); err == nil {
			logs = append(logs, l)
		}
	}

	json.NewEncoder(w).Encode(logs)
}

func handleThreatLevel(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method == http.MethodGet {
		var val string
		err := dbConn.QueryRow("SELECT value FROM system_settings WHERE key = 'threat_level'").Scan(&val)
		if err != nil {
			val = "NORMAL"
		}
		json.NewEncoder(w).Encode(map[string]string{"threat_level": val})
	} else if r.Method == http.MethodPost {
		var req struct {
			ThreatLevel string `json:"threat_level"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		_, err := dbConn.Exec("INSERT INTO system_settings (key, value) VALUES ('threat_level', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", req.ThreatLevel)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		// Broadcast new threat level to client SSE streams
		payload, _ := json.Marshal(map[string]interface{}{
			"event_source": "system",
			"event_type":   "THREAT_LEVEL_CHANGE",
			"details":      fmt.Sprintf("System threat level updated to: %s", req.ThreatLevel),
			"threat_level": req.ThreatLevel,
		})
		broadcastMessage(string(payload))

		json.NewEncoder(w).Encode(map[string]string{"status": "success"})
	}
}

type HealthTelemetry struct {
	ControllerID string  `json:"controller_id"`
	IP           string  `json:"server_ip"`
	FriendlyName string  `json:"friendly_name"`
	IsOnline     bool    `json:"is_online"`
	CPU          float64 `json:"cpu_usage"`
	Memory       float64 `json:"memory_usage"`
	BufferedLogs int     `json:"buffered_logs"`
	PingMs       int     `json:"last_ping_ms"`
	ServerPing   int     `json:"server_ping_ms"`
	APIStatus    string  `json:"api_status"`
}

func handleSystemHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodGet {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	rows, err := dbConn.Query(`
		SELECT controller_id, server_ip, friendly_name, is_online, 
		       cpu_usage, memory_usage, buffered_logs, last_ping_ms,
		       server_ping_ms, api_status
		FROM controllers ORDER BY controller_id`)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	list := []HealthTelemetry{}
	for rows.Next() {
		var h HealthTelemetry
		rows.Scan(&h.ControllerID, &h.IP, &h.FriendlyName, &h.IsOnline, &h.CPU, &h.Memory, &h.BufferedLogs, &h.PingMs, &h.ServerPing, &h.APIStatus)
		list = append(list, h)
	}
	json.NewEncoder(w).Encode(list)
}

type MapPlacement struct {
	ControllerID string `json:"controller_id"`
	PosX         int    `json:"pos_x"`
	PosY         int    `json:"pos_y"`
}

func handleMapPlacements(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method == http.MethodGet {
		rows, err := dbConn.Query(`
			SELECT mp.controller_id, mp.pos_x, mp.pos_y, c.friendly_name, c.is_online
			FROM map_placements mp
			JOIN controllers c ON mp.controller_id = c.controller_id`)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		defer rows.Close()

		type RichPlacement struct {
			ControllerID string  `json:"controller_id"`
			PosX         float64 `json:"pos_x"`
			PosY         float64 `json:"pos_y"`
			FriendlyName string  `json:"friendly_name"`
			IsOnline     bool    `json:"is_online"`
		}
		list := []RichPlacement{}
		for rows.Next() {
			var p RichPlacement
			rows.Scan(&p.ControllerID, &p.PosX, &p.PosY, &p.FriendlyName, &p.IsOnline)
			list = append(list, p)
		}
		json.NewEncoder(w).Encode(list)

	} else if r.Method == http.MethodPost {
		var p MapPlacement
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		_, err := dbConn.Exec(`
			INSERT INTO map_placements (controller_id, pos_x, pos_y) 
			VALUES ($1, $2, $3)
			ON CONFLICT (controller_id) DO UPDATE SET pos_x = EXCLUDED.pos_x, pos_y = EXCLUDED.pos_y`,
			p.ControllerID, p.PosX, p.PosY)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		json.NewEncoder(w).Encode(map[string]string{"status": "success"})

	} else if r.Method == http.MethodDelete {
		controllerID := r.URL.Query().Get("controller_id")
		if controllerID == "" {
			http.Error(w, "Missing controller_id", http.StatusBadRequest)
			return
		}
		_, err := dbConn.Exec("DELETE FROM map_placements WHERE controller_id = $1", controllerID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		json.NewEncoder(w).Encode(map[string]string{"status": "success"})
	}
}

// APB status: last seen controller per cardholder
func handleAPBStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodGet {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	type APBEntry struct {
		UserID           int       `json:"user_id"`
		EmployeeName     string    `json:"employee_name"`
		LastControllerID string    `json:"last_controller_id"`
		LastEventType    string    `json:"last_event_type"`
		LastSeen         time.Time `json:"last_seen"`
		APBViolation     bool      `json:"apb_violation"`
	}

	rows, err := dbConn.Query(`
		SELECT DISTINCT ON (ae.user_id)
			ae.user_id, u.employee_name, ae.controller_id, ae.event_type, ae.event_timestamp,
			ae.event_type = 'APB_VIOLATION' AS apb_violation
		FROM access_events ae
		JOIN users u ON ae.user_id = u.user_id
		WHERE ae.event_type IN ('CARD_GRANT', 'APB_VIOLATION')
		ORDER BY ae.user_id, ae.event_timestamp DESC`)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	entries := []APBEntry{}
	for rows.Next() {
		var e APBEntry
		rows.Scan(&e.UserID, &e.EmployeeName, &e.LastControllerID, &e.LastEventType, &e.LastSeen, &e.APBViolation)
		entries = append(entries, e)
	}
	json.NewEncoder(w).Encode(entries)
}

// ---- Authentication ----

func generateToken() string {
	b := make([]byte, 32)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Allow CORS preflight
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			w.WriteHeader(http.StatusOK)
			return
		}

		authHeader := r.Header.Get("Authorization")
		if !strings.HasPrefix(authHeader, "Bearer ") {
			http.Error(w, `{"error":"Unauthorized: Missing or invalid token"}`, http.StatusUnauthorized)
			return
		}
		token := strings.TrimPrefix(authHeader, "Bearer ")

		authMu.Lock()
		expiry, exists := authTokens[token]
		if exists && time.Now().After(expiry) {
			delete(authTokens, token)
			exists = false
		}
		authMu.Unlock()

		if !exists {
			http.Error(w, `{"error":"Forbidden: Session expired or invalid"}`, http.StatusForbidden)
			return
		}

		next(w, r)
	}
}

func handleAuthLogin(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"Method Not Allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"Bad Request"}`, http.StatusBadRequest)
		return
	}

	// Retrieve admin password from system_settings, default to 'Allcanget11'
	var storedPassword string
	err := dbConn.QueryRow("SELECT value FROM system_settings WHERE key = 'admin_password'").Scan(&storedPassword)
	if err != nil {
		storedPassword = "Allcanget11"
	}

	if req.Password != storedPassword {
		http.Error(w, `{"error":"Invalid password"}`, http.StatusUnauthorized)
		return
	}

	token := generateToken()
	authMu.Lock()
	authTokens[token] = time.Now().Add(24 * time.Hour)
	authMu.Unlock()

	json.NewEncoder(w).Encode(map[string]string{
		"token":   token,
		"expires": time.Now().Add(24 * time.Hour).Format(time.RFC3339),
	})
}

// ---- Controller Configuration ----

type ControllerConfig struct {
	ControllerID     string `json:"controller_id"`
	FriendlyName     string `json:"friendly_name"`
	ServerIP         string `json:"server_ip"`
	GpioChipDevice   string `json:"gpio_chip_device"`
	WiegandD0Pin     int    `json:"wiegand_d0_pin"`
	WiegandD1Pin     int    `json:"wiegand_d1_pin"`
	LockRelayPin     int    `json:"lock_relay_pin"`
	ReaderRedLedPin  int    `json:"reader_red_led_pin"`
	ReaderGreenLedPin int   `json:"reader_green_led_pin"`
	ReaderBuzzerPin  int    `json:"reader_buzzer_pin"`
	DsmPin           int    `json:"dsm_pin"`
	RexPin           int    `json:"rex_pin"`
	WiegandTimeoutMs int    `json:"wiegand_timeout_ms"`
	DhoTimeoutSecs   int    `json:"dho_timeout_secs"`
	ApbStrict        bool   `json:"apb_strict"`
	DfoEnabled       bool   `json:"dfo_enabled"`
	DhoEnabled       bool   `json:"dho_enabled"`
	DhoPreAlarmSecs  int    `json:"dho_pre_alarm_secs"`
	AlarmHornPin     int    `json:"alarm_horn_pin"`
	DsmNormallyClosed bool  `json:"dsm_normally_closed"`
}

func handleControllerConfig(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
	w.Header().Set("Access-Control-Allow-Methods", "GET, PUT, OPTIONS")

	if r.Method == http.MethodGet {
		controllerID := r.URL.Query().Get("controller_id")
		var query string
		var args []interface{}

		if controllerID != "" {
			query = `SELECT c.controller_id, c.friendly_name, c.server_ip,
				COALESCE(cc.gpio_chip_device, 'gpiochip0'), COALESCE(cc.wiegand_d0_pin, 0), COALESCE(cc.wiegand_d1_pin, 0),
				COALESCE(cc.lock_relay_pin, 0), COALESCE(cc.reader_red_led_pin, 0), COALESCE(cc.reader_green_led_pin, 0),
				COALESCE(cc.reader_buzzer_pin, 0), COALESCE(cc.dsm_pin, 0), COALESCE(cc.rex_pin, 0),
				COALESCE(cc.wiegand_timeout_ms, 50), COALESCE(cc.dho_timeout_secs, 60),
				COALESCE(cc.apb_strict, false), COALESCE(cc.dfo_enabled, false), COALESCE(cc.dho_enabled, true),
				COALESCE(cc.dho_pre_alarm_secs, 15), COALESCE(cc.alarm_horn_pin, 0), COALESCE(cc.dsm_normally_closed, false)
			FROM controllers c
			LEFT JOIN controller_configs cc ON c.controller_id = cc.controller_id
			WHERE c.controller_id = $1
			ORDER BY c.controller_id`
			args = append(args, controllerID)
		} else {
			query = `SELECT c.controller_id, c.friendly_name, c.server_ip,
				COALESCE(cc.gpio_chip_device, 'gpiochip0'), COALESCE(cc.wiegand_d0_pin, 0), COALESCE(cc.wiegand_d1_pin, 0),
				COALESCE(cc.lock_relay_pin, 0), COALESCE(cc.reader_red_led_pin, 0), COALESCE(cc.reader_green_led_pin, 0),
				COALESCE(cc.reader_buzzer_pin, 0), COALESCE(cc.dsm_pin, 0), COALESCE(cc.rex_pin, 0),
				COALESCE(cc.wiegand_timeout_ms, 50), COALESCE(cc.dho_timeout_secs, 60),
				COALESCE(cc.apb_strict, false), COALESCE(cc.dfo_enabled, false), COALESCE(cc.dho_enabled, true),
				COALESCE(cc.dho_pre_alarm_secs, 15), COALESCE(cc.alarm_horn_pin, 0), COALESCE(cc.dsm_normally_closed, false)
			FROM controllers c
			LEFT JOIN controller_configs cc ON c.controller_id = cc.controller_id
			ORDER BY c.controller_id`
		}

		rows, err := dbConn.Query(query, args...)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		defer rows.Close()

		configs := []ControllerConfig{}
		for rows.Next() {
			var cc ControllerConfig
			rows.Scan(&cc.ControllerID, &cc.FriendlyName, &cc.ServerIP,
				&cc.GpioChipDevice, &cc.WiegandD0Pin, &cc.WiegandD1Pin,
				&cc.LockRelayPin, &cc.ReaderRedLedPin, &cc.ReaderGreenLedPin,
				&cc.ReaderBuzzerPin, &cc.DsmPin, &cc.RexPin,
				&cc.WiegandTimeoutMs, &cc.DhoTimeoutSecs,
				&cc.ApbStrict, &cc.DfoEnabled, &cc.DhoEnabled,
				&cc.DhoPreAlarmSecs, &cc.AlarmHornPin, &cc.DsmNormallyClosed)
			configs = append(configs, cc)
		}
		json.NewEncoder(w).Encode(configs)

	} else if r.Method == http.MethodPut {
		var cc ControllerConfig
		if err := json.NewDecoder(r.Body).Decode(&cc); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		// 1. Update the database config
		_, err := dbConn.Exec(`
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
				dsm_normally_closed = EXCLUDED.dsm_normally_closed`,
			cc.ControllerID, cc.GpioChipDevice, cc.WiegandD0Pin, cc.WiegandD1Pin, cc.LockRelayPin,
			cc.ReaderRedLedPin, cc.ReaderGreenLedPin, cc.ReaderBuzzerPin, cc.DsmPin, cc.RexPin,
			cc.WiegandTimeoutMs, cc.DhoTimeoutSecs, cc.ApbStrict, cc.DfoEnabled, cc.DhoEnabled,
			cc.DhoPreAlarmSecs, cc.AlarmHornPin, cc.DsmNormallyClosed)
		if err != nil {
			http.Error(w, fmt.Sprintf("DB error: %v", err), http.StatusInternalServerError)
			return
		}

		// 2. Push live config update to the Pi via UPDATE_CONFIG command
		var serverIP, tokenHash string
		err = dbConn.QueryRow("SELECT server_ip, token_hash FROM controllers WHERE controller_id = $1", cc.ControllerID).
			Scan(&serverIP, &tokenHash)
		if err != nil {
			// DB saved but couldn't find controller to push to
			json.NewEncoder(w).Encode(map[string]string{"status": "saved", "push": "controller_not_found"})
			return
		}

		pushPayload := map[string]interface{}{
			"controller_id": cc.ControllerID,
			"command":       "UPDATE_CONFIG",
			"new_config_payload": map[string]interface{}{
				"gpio_chip_device":   cc.GpioChipDevice,
				"wiegand_d0_pin":     cc.WiegandD0Pin,
				"wiegand_d1_pin":     cc.WiegandD1Pin,
				"lock_relay_pin":     cc.LockRelayPin,
				"reader_red_led_pin": cc.ReaderRedLedPin,
				"reader_green_led_pin": cc.ReaderGreenLedPin,
				"reader_buzzer_pin":  cc.ReaderBuzzerPin,
				"dsm_pin":           cc.DsmPin,
				"rex_pin":           cc.RexPin,
				"wiegand_timeout_ms": cc.WiegandTimeoutMs,
				"dho_timeout_secs":  cc.DhoTimeoutSecs,
				"apb_strict":        cc.ApbStrict,
				"dfo_enabled":       cc.DfoEnabled,
				"dho_enabled":       cc.DhoEnabled,
				"dho_pre_alarm_secs": cc.DhoPreAlarmSecs,
				"alarm_horn_pin":    cc.AlarmHornPin,
				"dsm_normally_closed": cc.DsmNormallyClosed,
			},
		}
		body, _ := json.Marshal(pushPayload)

		tr := &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}
		client := &http.Client{Transport: tr, Timeout: 6 * time.Second}

		url := fmt.Sprintf("https://%s:8080/api/v1/controller/remote-unlock", serverIP)
		proxyReq, _ := http.NewRequest("POST", url, strings.NewReader(string(body)))
		proxyReq.Header.Set("Content-Type", "application/json")
		proxyReq.Header.Set("Authorization", "Bearer "+tokenHash)

		resp, err := client.Do(proxyReq)
		pushStatus := "pushed"
		if err != nil {
			pushStatus = fmt.Sprintf("push_failed: %v", err)
			log.Printf("[CONFIG-PUSH] Failed to push config to %s: %v", cc.ControllerID, err)
		} else {
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				pushStatus = fmt.Sprintf("push_rejected: HTTP %d", resp.StatusCode)
			}
		}

		json.NewEncoder(w).Encode(map[string]string{"status": "saved", "push": pushStatus})
	} else {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
	}
}

func startControllerHealthPoller() {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	tr := &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
	}
	client := &http.Client{Transport: tr, Timeout: 2 * time.Second}

	for range ticker.C {
		rows, err := dbConn.Query("SELECT controller_id, server_ip, token_hash FROM controllers")
		if err != nil {
			log.Printf("[HEALTH-POLLER-ERR] Failed to fetch controllers: %v", err)
			continue
		}

		type Target struct {
			ID    string
			IP    string
			Token string
		}
		var targets []Target
		for rows.Next() {
			var t Target
			if err := rows.Scan(&t.ID, &t.IP, &t.Token); err == nil {
				targets = append(targets, t)
			}
		}
		rows.Close()

		for _, t := range targets {
			go func(tgt Target) {
				start := time.Now()
				addr := fmt.Sprintf("%s:8080", tgt.IP)
				conn, err := net.DialTimeout("tcp", addr, 2*time.Second)
				pingMs := int(time.Since(start).Milliseconds())

				if err != nil {
					_, dbErr := dbConn.Exec(`
						UPDATE controllers 
						SET is_online = false, server_ping_ms = 999, api_status = 'OFFLINE', cpu_usage = 0, memory_usage = 0 
						WHERE controller_id = $1`, tgt.ID)
					if dbErr != nil {
						log.Printf("[HEALTH-POLLER-ERR] Failed to update offline state: %v", dbErr)
					}
					return
				}
				conn.Close()

				url := fmt.Sprintf("https://%s:8080/api/v1/health", tgt.IP)
				req, reqErr := http.NewRequest("GET", url, nil)
				if reqErr != nil {
					dbConn.Exec(`
						UPDATE controllers 
						SET is_online = true, server_ping_ms = $1, api_status = 'API_ERROR', last_heartbeat = NOW() 
						WHERE controller_id = $2`, pingMs, tgt.ID)
					return
				}
				req.Header.Set("Authorization", "Bearer "+tgt.Token)

				resp, respErr := client.Do(req)
				if respErr != nil {
					dbConn.Exec(`
						UPDATE controllers 
						SET is_online = true, server_ping_ms = $1, api_status = 'API_UNREACHABLE', last_heartbeat = NOW() 
						WHERE controller_id = $2`, pingMs, tgt.ID)
					return
				}
				defer resp.Body.Close()

				if resp.StatusCode != http.StatusOK {
					dbConn.Exec(`
						UPDATE controllers 
						SET is_online = true, server_ping_ms = $1, api_status = 'API_FORBIDDEN', last_heartbeat = NOW() 
						WHERE controller_id = $2`, pingMs, tgt.ID)
					return
				}

				var metrics struct {
					CPUUsage     float64 `json:"cpu_usage"`
					MemoryUsage  float64 `json:"memory_usage"`
					BufferedLogs int     `json:"buffered_logs"`
				}
				if decodeErr := json.NewDecoder(resp.Body).Decode(&metrics); decodeErr != nil {
					dbConn.Exec(`
						UPDATE controllers 
						SET is_online = true, server_ping_ms = $1, api_status = 'API_DECODE_ERROR', last_heartbeat = NOW() 
						WHERE controller_id = $2`, pingMs, tgt.ID)
					return
				}

				_, dbErr := dbConn.Exec(`
					UPDATE controllers 
					SET is_online = true, server_ping_ms = $1, api_status = 'HEALTHY', cpu_usage = $2, memory_usage = $3, 
					    buffered_logs = $4, last_heartbeat = NOW() 
					WHERE controller_id = $5`, 
					pingMs, metrics.CPUUsage, metrics.MemoryUsage, metrics.BufferedLogs, tgt.ID)
				if dbErr != nil {
					log.Printf("[HEALTH-POLLER-ERR] Failed to update healthy metrics: %v", dbErr)
				}
			}(t)
		}
	}
}

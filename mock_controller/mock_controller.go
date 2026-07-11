package main

import (
	"crypto/tls"
	"database/sql"
	"encoding/json"
	"log"
	"math/rand"
	"net/http"
	"time"

	_ "github.com/lib/pq"
)

func main() {
	dbConnStr := "host=192.168.0.141 port=5432 user=edge_ctrl password=Allcanget11 dbname=piacs_security sslmode=disable"
	db, err := sql.Open("postgres", dbConnStr)
	if err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}
	defer db.Close()

	if err := db.Ping(); err != nil {
		log.Fatalf("Failed to ping database: %v", err)
	}
	log.Println("[MOCK] Connected to PostgreSQL at 192.168.0.141")

	// Register our mock controller
	controllerID := "MOCK-CTRL-01"
	localIP := "192.168.1.189"
	token := "mock-auth-token-123"

	_, err = db.Exec(`
		INSERT INTO controllers (controller_id, friendly_name, server_ip, is_online, token_hash)
		VALUES ($1, 'Simulated Edge Node', $2, true, $3)
		ON CONFLICT (controller_id) DO UPDATE 
		SET server_ip = EXCLUDED.server_ip, token_hash = EXCLUDED.token_hash`,
		controllerID, localIP, token)
	if err != nil {
		log.Fatalf("Failed to register mock controller: %v", err)
	}
	log.Printf("[MOCK] Registered %s with IP %s in DB\n", controllerID, localIP)

	// Periodically insert random swipes to test DB triggers & SSE
	go func() {
		r := rand.New(rand.NewSource(time.Now().UnixNano()))
		users := []struct {
			ID   int
			Name string
			Card int
		}{
			{1, "Alice Admin", 10001},
			{2, "Bob Developer", 10002},
		}

		for {
			time.Sleep(10 * time.Second)
			user := users[r.Intn(len(users))]
			eventType := "CARD_GRANT"
			if r.Float32() < 0.2 {
				eventType = "APB_VIOLATION"
			}

			_, err := db.Exec(`
				INSERT INTO access_logs (controller_id, card_id, employee_name, event_type, details)
				VALUES ($1, $2, $3, $4, $5)`,
				controllerID, user.Card, user.Name, eventType, "Simulated swipe via mock_controller_test")
			if err != nil {
				log.Printf("[MOCK] Failed to insert access log: %v", err)
			} else {
				log.Printf("[MOCK] Inserted %s swipe event for %s\n", eventType, user.Name)
			}
		}
	}()

	// Handlers for Central Server override requests
	http.HandleFunc("/api/v1/health", func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if auth != "Bearer "+token {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			log.Println("[MOCK] Health check received - UNAUTHORIZED")
			return
		}

		w.Header().Set("Content-Type", "application/json")
		metrics := map[string]interface{}{
			"cpu_usage":     12.8,
			"memory_usage":  41.5,
			"buffered_logs": 0,
		}
		json.NewEncoder(w).Encode(metrics)
		log.Println("[MOCK] Health check poll received and responded successfully")
	})

	http.HandleFunc("/api/v1/controller/remote-unlock", func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if auth != "Bearer "+token {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			log.Println("[MOCK] Remote unlock command received - UNAUTHORIZED")
			return
		}

		var payload map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			http.Error(w, "Bad Request", http.StatusBadRequest)
			return
		}

		log.Printf("[MOCK] REMOTE UNLOCK COMMAND RECEIVED! Command: %v, Controller: %v\n", payload["command"], payload["controller_id"])
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "success", "message": "Door unlocked"})
	})

	serverAddr := "0.0.0.0:8080"
	log.Printf("[MOCK] Starting HTTPS Server on %s\n", serverAddr)

	server := &http.Server{
		Addr: serverAddr,
		TLSConfig: &tls.Config{
			InsecureSkipVerify: true,
		},
	}

	err = server.ListenAndServeTLS("../central_server/server.crt", "../central_server/server.key")
	if err != nil {
		log.Fatalf("Server ListenAndServeTLS failed: %v", err)
	}
}

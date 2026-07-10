package main

import (
	"database/sql"
	"os"
	"testing"

	_ "github.com/mattn/go-sqlite3"
)

func TestAlignAndParseWiegand(t *testing.T) {
	tests := []struct {
		name       string
		rawStream  string
		targetBits int
		wantFC     uint64
		wantCID    uint64
		wantValid  bool
	}{
		{
			name:       "Valid 35-bit stream (all ones/zeros inverted check)",
			rawStream:  "11000000000000000000000000000000000", // Will invert 1->0, 0->1
			targetBits: 35,
			wantFC:     4095, // inverted: 0011111111111100000...
			wantCID:    1048575,
			wantValid:  true,
		},
		{
			name:       "Valid 34-bit stream (appended zero)",
			rawStream:  "1100000000000000000000000000000000", // length 34
			targetBits: 35,
			wantFC:     4095,
			wantCID:    1048575,
			wantValid:  true,
		},
		{
			name:       "Too short stream",
			rawStream:  "101",
			targetBits: 35,
			wantFC:     0,
			wantCID:    0,
			wantValid:  false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fc, cid, valid := AlignAndParseWiegand(tt.rawStream, tt.targetBits)
			if valid != tt.wantValid {
				t.Fatalf("AlignAndParseWiegand() valid = %v, want %v", valid, tt.wantValid)
			}
			if valid {
				if fc != tt.wantFC {
					t.Errorf("AlignAndParseWiegand() fc = %v, want %v", fc, tt.wantFC)
				}
				if cid != tt.wantCID {
					t.Errorf("AlignAndParseWiegand() cid = %v, want %v", cid, tt.wantCID)
				}
			}
		})
	}
}

func TestLocalOfflineCacheLookup(t *testing.T) {
	// Setup temporary SQLite DB for testing
	dbPath := "./test_edge_cache.db"
	defer os.Remove(dbPath)

	db, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		t.Fatalf("Failed to open test SQLite DB: %v", err)
	}
	defer db.Close()

	statement := `
	CREATE TABLE local_credentials (
		facility_code INT,
		card_id INT,
		employee_name TEXT,
		user_active INT,
		cred_active INT,
		last_area TEXT,
		PRIMARY KEY(facility_code, card_id)
	);`
	if _, err := db.Exec(statement); err != nil {
		t.Fatalf("Failed to create table: %v", err)
	}

	// Insert test credentials
	// 1. Active User, Active Credential
	// 2. Inactive User
	// 3. Inactive Credential
	_, err = db.Exec(`
		INSERT INTO local_credentials VALUES (100, 1001, 'John Doe', 1, 1, 'OUTSIDE');
		INSERT INTO local_credentials VALUES (100, 1002, 'Jane InactiveUser', 0, 1, 'OUTSIDE');
		INSERT INTO local_credentials VALUES (100, 1003, 'Bob InactiveCred', 1, 0, 'OUTSIDE');
	`)
	if err != nil {
		t.Fatalf("Failed to insert mock data: %v", err)
	}

	tests := []struct {
		fc        int
		cid       int
		wantName  string
		wantUAct  bool
		wantCAct  bool
		wantErr   bool
	}{
		{100, 1001, "John Doe", true, true, false},
		{100, 1002, "Jane InactiveUser", false, true, false},
		{100, 1003, "Bob InactiveCred", true, false, false},
		{100, 9999, "", false, false, true}, // Unregistered
	}

	for _, tt := range tests {
		var name string
		var uActInt, cActInt int
		var area string
		query := "SELECT employee_name, user_active, cred_active, last_area FROM local_credentials WHERE facility_code = ? AND card_id = ?"
		err = db.QueryRow(query, tt.fc, tt.cid).Scan(&name, &uActInt, &cActInt, &area)

		if tt.wantErr {
			if err == nil {
				t.Errorf("Expected lookup error for FC %d CID %d, got nil", tt.fc, tt.cid)
			}
		} else {
			if err != nil {
				t.Fatalf("Unexpected lookup error for FC %d CID %d: %v", tt.fc, tt.cid, err)
			}
			uAct := (uActInt == 1)
			cAct := (cActInt == 1)

			if name != tt.wantName {
				t.Errorf("employee_name = %q, want %q", name, tt.wantName)
			}
			if uAct != tt.wantUAct {
				t.Errorf("user_active = %v, want %v", uAct, tt.wantUAct)
			}
			if cAct != tt.wantCAct {
				t.Errorf("cred_active = %v, want %v", cAct, tt.wantCAct)
			}
		}
	}
}

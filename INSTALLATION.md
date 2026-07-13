# PiACS-EDGE Installation & Configuration Guide

This document provides step-by-step instructions to deploy, configure, and verify the PiACS-EDGE access control ecosystem.

---

## Architecture Setup Diagram

```
       [ACS-DB VM]                     [ACS-FRONTEND VM]                 [EDGE CONTROLLER]
    (PostgreSQL 5432)                 (Central Server 8000)            (Raspberry Pi 8080)
           ▲                                   ▲                                ▲
           │                                   │                                │
     1. Set listen_addresses             1. Set Environment               1. Wire GPIO pins
     2. Edit pg_hba.conf                    DATABASE_URL &                2. Generate TLS certs
     3. Create user & DB                    ADMIN_PASSWORD                3. Configure config.json
     4. Import schemas & triggers        2. Build central-server          4. Compile CGO binary
     5. Verify connections               3. Run Systemd service           5. Run Systemd service
```

---

## 1. Database Server Deployment (ACS-DB)

### Step 1.1: Install PostgreSQL
On your target database server host (Debian/Ubuntu recommended):
```bash
sudo apt update
sudo apt install -y postgresql postgresql-contrib
```

### Step 1.2: Enable Network Connectivity
By default, PostgreSQL is secured to only listen on localhost (`127.0.0.1`). To allow connections from the Central Server and Edge Nodes:

1. Open `/etc/postgresql/<version>/main/postgresql.conf` in an editor:
   ```ini
   # Listen on all network interface IPs
   listen_addresses = '*'
   ```
2. Open `/etc/postgresql/<version>/main/pg_hba.conf` and authorize your subnets/hosts:
   ```text
   # TYPE  DATABASE        USER            ADDRESS                 METHOD
   # Allow Central Server VM (192.168.0.140)
   host    piacs_security  edge_ctrl       192.168.0.140/32        scram-sha-256

   # Allow Edge Controller Subnet (e.g. 192.168.1.0/24)
   host    piacs_security  edge_ctrl       192.168.1.0/24          scram-sha-256
   ```
3. Restart PostgreSQL to apply changes:
   ```bash
   sudo systemctl restart postgresql
   ```

### Step 1.3: Initialize User & Database
Log in as the database administrator:
```bash
sudo -u postgres psql
```
Create the secure access role and database:
```sql
-- Create the dedicated user
CREATE USER edge_ctrl WITH PASSWORD 'YOUR_DB_PASSWORD';

-- Create the security database owned by the new role
CREATE DATABASE piacs_security OWNER edge_ctrl;

-- Connect and assign permissions
GRANT CONNECT ON DATABASE piacs_security TO edge_ctrl;
\q
```

### Step 1.4: Apply Relational Schemas & Triggers
Execute these schema imports sequentially from the codebase directory:
```bash
# 1. Base Schedules & Timezone mappings
psql -h <DB_IP> -U edge_ctrl -d piacs_security -f db_schema_schedules.sql

# 2. LenelS2 Enterprise features (threat levels, credentials, PINs, maps)
psql -h <DB_IP> -U edge_ctrl -d piacs_security -f db_schema_lenels2.sql

# 3. Real-time PostgreSQL NOTIFY event triggers
psql -h <DB_IP> -U edge_ctrl -d piacs_security -f triggers.sql
```

### Step 1.5: Verify Database Setup
* **Port Listener check**: Verify PostgreSQL is listening on port `5432`:
  ```bash
  ss -nlt | grep 5432
  # Expected: LISTEN 0 244 0.0.0.0:5432
  ```
* **Client connectivity check**: Connect from the Central Server VM using `pg_isready`:
  ```bash
  pg_isready -h <DB_IP> -p 5432 -U edge_ctrl
  # Expected: <DB_IP>:5432 - accepting connections
  ```
* **Verify Table Structures**: Check if tables are correctly loaded:
  ```bash
  psql -h <DB_IP> -U edge_ctrl -d piacs_security -c "\dt"
  ```

---

## 2. Central Server & Frontend Setup (ACS-FRONTEND)

### Step 2.1: Configuration Setup
The Central Server must be configured using either environment variables or a local `config.json` file in its working directory.

#### Option A: Using `.env` Environment Variables (Recommended)
Create `/root/central_server/.env`:
```env
# Database connection string
DATABASE_URL=host=YOUR_DB_IP port=5432 user=edge_ctrl password=YOUR_DB_PASSWORD dbname=piacs_security sslmode=disable

# Admin control panel login password
ADMIN_PASSWORD=YOUR_ADMIN_PASSWORD
```

##### Option B: Using `config.json`
Alternatively, create `/root/central_server/config.json`:
```json
{
  "database_url": "host=YOUR_DB_IP port=5432 user=edge_ctrl password=YOUR_DB_PASSWORD dbname=piacs_security sslmode=disable",
  "admin_password": "YOUR_ADMIN_PASSWORD"
}
```

### Step 2.2: Compile Server
Compile the Go central server binary:
```bash
cd central_server
go build -o central-server .
```

### Step 2.3: Systemd Daemon Installation
Create the Systemd service file at `/etc/systemd/system/central-server.service`:
```ini
[Unit]
Description=PiACS Access Control Central Web Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/root/central_server
# If using Option A, pass variables directly:
Environment="DATABASE_URL=host=YOUR_DB_IP port=5432 user=edge_ctrl password=YOUR_DB_PASSWORD dbname=piacs_security sslmode=disable"
Environment="ADMIN_PASSWORD=YOUR_ADMIN_PASSWORD"
ExecStart=/root/central_server/central-server
Restart=always
RestartSec=5
StandardOutput=append:/var/log/central_server_stdout.log
StandardError=append:/var/log/central_server_stderr.log

[Install]
WantedBy=multi-user.target
```
Enable, start, and verify the service:
```bash
sudo systemctl daemon-reload
sudo systemctl enable central-server.service
sudo systemctl start central-server.service
```

### Step 2.4: Verify Central Server Uptime
* **Active Status check**:
  ```bash
  sudo systemctl status central-server
  # Expected: Active: active (running)
  ```
* **API Health endpoint check**:
  ```bash
  curl -I http://localhost:8000/api/threat-level
  # Expected: HTTP/1.1 200 OK
  ```

---

## 3. Edge Controller Node Setup (Raspberry Pi)

### Step 3.1: Hardware Peripheral Wiring
Connect your access control peripherals directly to the Raspberry Pi GPIO headers:

| Component | Pi GPIO Pin | Connection Notes |
|:---|:---:|:---|
| **Wiegand D0** | GPIO 14 (Pin 8) | Green Wire (Card swipe 0 pulse) |
| **Wiegand D1** | GPIO 15 (Pin 10) | White Wire (Card swipe 1 pulse) |
| **Lock Relay** | GPIO 18 (Pin 12) | High pulses relay to trigger door release |
| **Red LED** | GPIO 23 (Pin 16) | Controls card reader's red status light |
| **Green LED** | GPIO 24 (Pin 18) | Controls green unlock indication light |
| **Buzzer** | GPIO 25 (Pin 22) | Controls card reader feedback beep |
| **DSM Pin** | GPIO 8 (Pin 24) | Door Status Monitor switch (Detects open/closed) |
| **REX Pin** | GPIO 7 (Pin 26) | Request-to-Exit motion sensor/button |
| **Alarm Horn** | GPIO 12 (Pin 32) | Auxiliary siren alert driver |

> [!IMPORTANT]
> The Raspberry Pi and the Wiegand card reader **MUST** share a common ground (GND) connection.

### Step 3.2: Install System Dependencies
On the Raspberry Pi:
```bash
sudo apt update
sudo apt install -y build-essential golang-go git
```

### Step 3.3: Generate Secure TLS Certificates
The override command API (e.g. Remote Unlock) operates over secure HTTPS. Generate self-signed certificates on the Pi:
```bash
openssl req -x509 -newkey rsa:2048 -keyout server.key -out server.crt -sha256 -days 3650 -nodes -subj "/CN=<PI_IP_ADDRESS>"
```
*Make sure `server.key` and `server.crt` reside in the same directory as the controller executable.*

### Step 3.4: Configure `config.json`
Create a local `config.json` configuration file on the Pi:
```json
{
  "controller_id": "LOBBY-EDGE-01",
  "api_token": "YOUR_SECURE_API_BEARER_TOKEN",
  "backend_port": 8080,
  "database_config": {
    "db_host": "YOUR_DATABASE_IP",
    "db_port": 5432,
    "db_user": "edge_ctrl",
    "db_password": "YOUR_DB_PASSWORD",
    "db_name": "piacs_security",
    "ssl_mode": "disable"
  },
  "hardware_mapping": {
    "gpio_chip_device": "/dev/gpiochip4",
    "wiegand_d0_pin": 14,
    "wiegand_d1_pin": 15,
    "lock_relay_pin": 18,
    "reader_red_led_pin": 23,
    "reader_green_led_pin": 24,
    "reader_buzzer_pin": 25,
    "dsm_pin": 8,
    "rex_pin": 7,
    "wiegand_timeout_ms": 50,
    "dho_timeout_secs": 60,
    "dho_pre_alarm_secs": 15,
    "alarm_horn_pin": 12,
    "apb_enabled": true,
    "dfo_enabled": true,
    "dho_enabled": true,
    "dsm_normally_closed": true
  }
}
```

### Step 3.5: Build Engine (CGO Enabled)
The local failover SQLite cache requires CGO compilation:
```bash
CGO_ENABLED=1 GOOS=linux go build -ldflags="-s -w" -o piacs-edge-engine .
```

### Step 3.6: Systemd Service Installation
Create the Systemd service configuration `/etc/systemd/system/piacs-edge.service` on the Pi:
```ini
[Unit]
Description=PiACS Access Control Edge Engine
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/admin/PiACS-EDGE
ExecStart=/home/admin/PiACS-EDGE/piacs-edge-engine
Restart=always
RestartSec=5
StandardOutput=append:/var/log/piacs_edge_stdout.log
StandardError=append:/var/log/piacs_edge_stderr.log

[Install]
WantedBy=multi-user.target
```
Enable and start the engine:
```bash
sudo systemctl daemon-reload
sudo systemctl enable piacs-edge.service
sudo systemctl start piacs-edge.service
```

### Step 3.7: Verify Edge Controller
* **Active Status check**:
  ```bash
  sudo systemctl status piacs-edge
  # Expected: Active: active (running)
  ```
* **Verify GPIO Mappings**:
  Inspect that the GPIO lines are correctly requested by the driver:
  ```bash
  sudo gpioinfo | grep -E "wiegand|lock|dsm|rex"
  ```
* **API Health Test**:
  Test the local HTTPS override interface:
  ```bash
  curl -k https://localhost:8080/api/v1/health
  # Expected: {"status":"healthy"}
  ```

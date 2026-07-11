# PiACS-EDGE: Physical Access Control System Edge & Enterprise Management Platform

PiACS-EDGE is an enterprise-grade Physical Access Control System (PACS) engineered for distributed edge execution, local resilience, and centralized management. 

---

## 1. Architectural Layout

```
                         +-----------------------------------+
                         |  Central Management Web Dashboard |
                         |       (HTML5 / CSS3 / JS SPA)     |
                         +-----------------------------------+
                                           ^
                                           | WebSockets / SSE / REST
                                           v
                         +-----------------------------------+
                         |  Central Go Web Server (Port 8000) |
                         +-----------------------------------+
                                    /              \
         Command Overrides (HTTPS) /                \ Sync & Audit logs
                                  v                  v
                       +-------------------+   +--------------------+
                       | PiACS-EDGE Engine |<->| PostgreSQL Database|
                       |  (Raspberry Pi)   |   |   (Port 5432)      |
                       +-------------------+   +--------------------+
                           /           \
                 Local IO /             \ Fallback Lookups
                         v               v
            [Peripherals, Readers]   [Local SQLite Cache]
```

---

## 2. Advanced Network Deployment & Traversal Strategies

To support deployment across diverse enterprise topologies, subnets, firewalls, and isolated dynamic IP boundaries, PiACS-EDGE supports three distinct networking models.

### Deployment Model A: Direct Routing (Standard Subnet)
Used when the Central Management Server and all Edge Controllers reside in routeable subnets with no blockages on standard communication ports.

```
+------------------------------------+              +------------------------------------+
|       Central Server VM            |              |      Edge Node (Raspberry Pi)      |
|       IP: 192.168.0.140            |              |      IP: 192.168.1.200             |
|  - REST/SSE Server (Port 8000)     |<============>|  - HTTPS Override API (Port 8080)   |
|  - PostgreSQL DB (Port 5432)       |              |  - Local Hardware Engine           |
+------------------------------------+              +------------------------------------+
```
* **Traffic Flow (Node -> DB)**: Edge nodes query the central PostgreSQL instance directly via TCP `5432`.
* **Traffic Flow (Server -> Node)**: The central server issues command overrides (Remote Unlock, Lockdown, config sync) by sending secure HTTPS requests directly to the edge node's API at `https://192.168.1.200:8080`.

---

### Deployment Model B: Secure NAT / Firewall Traversal (Reverse SSH Tunnel)
Used when Edge Controllers are placed behind strict local NAT routers or firewalls that prevent incoming connections to `port 8080` (preventing central server override requests), while outgoing TCP ports are allowed.

```
+------------------------------------+              +------------------------------------+
|       Central Server VM            |              |      Edge Node (Raspberry Pi)      |
|       Public IP: 192.168.0.140     |              |      Private IP (NAT): 10.0.8.4    |
|                                    |              |                                    |
|   Receives Tunnel on Port 18080    |<=============|--- Establishes outbound SSH tunnel |
|   (Proxies to Pi's port 8080)      |              |    to root@192.168.0.140           |
+------------------------------------+              +------------------------------------+
```

#### Step 1: Configure sshd on the Central Server
Ensure gateway ports are allowed so loopback bindings are reachable. In `/etc/ssh/sshd_config` on the Central Server:
```text
GatewayPorts yes
ClientAliveInterval 30
ClientAliveCountMax 3
```
Then restart the SSH service: `sudo systemctl restart ssh`

#### Step 2: Configure systemd Tunnel Service on the Edge Node (Pi)
Create `/etc/systemd/system/piacs-tunnel.service` on the edge node to automatically maintain the connection:
```ini
[Unit]
Description=PiACS-EDGE Reverse SSH Tunnel Gateway
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/ssh -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -N -R 18080:localhost:8080 root@192.168.0.140
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```
Enable and start the tunnel on the Pi:
```bash
sudo systemctl daemon-reload
sudo systemctl enable piacs-tunnel.service
sudo systemctl start piacs-tunnel.service
```

#### Step 3: Register the Controller
On the management dashboard, register the controller with the loopback routing address as its server IP:
* **Controller ID**: `EDGE-NODE-01`
* **IP Address**: `127.0.0.1:18080` (The central server will target its local port `18080` which routes directly through the tunnel to the Pi's port `8080`).

---

### Deployment Model C: Flat Virtual Mesh Network (WireGuard VPN)
Used when deploying controllers across multiple remote, dynamic IP networks. This is the **most secure** and robust architecture for enterprise environments.

```
       +-------------------------------------------------------------+
       |                        WireGuard VPN                        |
       |                        Subnet: 10.8.0.0/24                  |
       +-------------------------------------------------------------+
                            /                           \
                           v                             v
            +-----------------------------+       +-----------------------------+
            |      Central Server VM      |       |    Edge Node (Raspberry Pi) |
            |      Virtual IP: 10.8.0.1   |       |    Virtual IP: 10.8.0.2     |
            +-----------------------------+       +-----------------------------+
```

#### Central Server WireGuard Setup (`/etc/wireguard/wg0.conf`)
```ini
[Interface]
PrivateKey = <CENTRAL_SERVER_PRIVATE_KEY>
Address = 10.8.0.1/24
ListenPort = 51820
PostUp = iptables -A FORWARD -i %i -j ACCEPT; iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
PostDown = iptables -D FORWARD -i %i -j ACCEPT; iptables -t nat -D POSTROUTING -o eth0 -j MASQUERADE

# Edge Node 1
[Peer]
PublicKey = <EDGE_NODE_01_PUBLIC_KEY>
AllowedIPs = 10.8.0.2/32
```

#### Edge Node WireGuard Setup (`/etc/wireguard/wg0.conf`)
```ini
[Interface]
PrivateKey = <EDGE_NODE_01_PRIVATE_KEY>
Address = 10.8.0.2/24

[Peer]
PublicKey = <CENTRAL_SERVER_PUBLIC_KEY>
Endpoint = 192.168.0.140:51820
AllowedIPs = 10.8.0.0/24
Keepalive = 25
```
Start WireGuard on both endpoints: `sudo wg-quick up wg0`

#### Configuration Mapping:
* **Central Database Host** (in the Pi's `config.json`): Set to `10.8.0.1` (the database is reached via the secure VPN address).
* **Controller IP Address** (on the Central Dashboard): Set to `10.8.0.2` (the override API is invoked via the secure VPN address).

---

## 3. Core System Architecture & Event Loops

### A. Autonomous Evaluation & SQLite Caching Flow (Node Uptime Uptime)

When a cardholder swipes their badge, the local dynamic controller follows a strict failover hierarchy to guarantee access authorization even during a complete network or database outage.

```mermaid
sequenceDiagram
    autonumber
    actor User as Cardholder (Swipe)
    participant HW as Wiegand Reader (GPIO)
    participant E as PiACS-EDGE Engine
    participant DB as Central PostgreSQL
    participant L as Local SQLite Cache
    participant R as Door Lock Relay

    User->>HW: Swipe Card (Data0 / Data1 stream)
    HW->>E: GPIO Pin Interrupts triggered
    E->>E: Parse Wiegand bitstream (Card ID / Facility Code)
    
    alt Central Database is Reachable (ONLINE MODE)
        E->>DB: Query authorization schemas (Timezones/Schedules/Holidays)
        DB-->>E: Returns Auth Status (GRANTED / DENIED)
        
        alt Authorization GRANTED
            E->>R: Pulse Lock Relay (Open Door)
            E->>DB: Write event Log "CARD_GRANT"
        else Authorization DENIED
            E->>DB: Write event Log "DENY_SCHEDULE" or "DENY"
        end
        
    else Central Database Offline (OFFLINE FALLBACK MODE)
        E->>E: Detect PostgreSQL Connection Timeout
        E->>L: Query offline cache database (edge_cache.db)
        L-->>E: Returns Local Active Status
        
        alt User is ACTIVE in local cache
            E->>R: Pulse Lock Relay (Open Door)
            E->>L: Queue event log in local buffer tables
        else User is INACTIVE / Absent
            E->>L: Queue deny event log in local buffer tables
        end
    end
```

#### Offline Logging Queue & Dynamic Upload Sync
While the edge node is offline, event records are logged directly inside the local SQLite database. Once the network is restored, a background worker thread (`syncBufferedLogsToPostgres`) executes:
1. Queries all unsynced logs inside the local SQLite queue.
2. Performs a batch insertion transaction to push them to the central PostgreSQL database.
3. Deletes successfully pushed rows from the local SQLite queue.

Similarly, a background caching thread (`syncPostgresToSQLiteCache`) pulls database records from PostgreSQL hourly and overwrites `edge_cache.db` to keep localized validation credentials fresh.

---

### B. Real-time Live Event Telemetry Loop

The dashboard updates instantly when events occur, eliminating the need for periodic HTTP polling.

```mermaid
graph TD
    A[Card Swipe or Sensor Alert] -->|Edge Node Event| B(PostgreSQL DB Insert)
    B -->|Database Commit| C{Triggers fired}
    C -->|INSERT ON access_logs| D[notify_access_event trigger]
    C -->|INSERT ON system_alarms| D
    D -->|pg_notify payload| E[PostgreSQL Listen channel: access_event]
    E -->|pq.Listener notified| F[Central Go Server]
    F -->|Multiplex Event| G[SSE Client Streams: /api/events/stream]
    G -->|Server-Sent Events| H[Web Browser SPA Dashboard]
    H -->|Dynamic JS DOM repaint| I[Update door icons, alarm cards, audit logs]
```

---

### C. Edge Controller Auto-Registration

Adding a new controller requires zero manual SQL database queries or prepopulated schemas.

```
[New Edge Node boots up]
          │
          ▼
Get outbound network interface IP dynamically
          │
          ▼
Connects to PostgreSQL database
          │
          ▼
Check: Does controller_id exist in table "controllers"?
         ├─── YES ───► Update transient state only (server_ip, is_online, last_heartbeat)
         └─── NO  ───► Insert new row with default name & server_ip
                         │
                         ▼
                       Insert default pin map schemas into "controller_configs"
```

---

## 4. Hardware Configuration & Wiring Specs

The edge engine utilizes the native Linux GPIO character device interface (`/dev/gpiochip*`) via the `gpiocdev` framework for direct, real-time peripheral control.

### Default GPIO Pin Out Mapping (Configurable in `config.json`)

| Peripheral Component | Pin Mapping | Type | Connection Notes |
|:---|:---:|:---:|:---|
| **Wiegand Data 0 (D0)** | GPIO 14 | Input | Pulse line for 0 bits |
| **Wiegand Data 1 (D1)** | GPIO 15 | Input | Pulse line for 1 bits |
| **Lock Strike Relay** | GPIO 18 | Output | High triggers transistor/driver to activate lock |
| **Reader Red LED** | GPIO 23 | Output | Controls reader LED status feedback |
| **Reader Green LED** | GPIO 24 | Output | Controls green grant feedback |
| **Reader Buzzer** | GPIO 25 | Output | Audio notification driver |
| **Door Status Monitor (DSM)** | GPIO 8 | Input | Detects door closed (Normally Closed sensor recommended) |
| **Request to Exit (REX)** | GPIO 7 | Input | Motion sensor or push button input |
| **Alarm Siren Horn** | GPIO 12 | Output | High engages external security siren relay |

### Physical Peripheral Wiring Overview

```text
               +----------------------------------------+
               |         Raspberry Pi Edge Node         |
               +----------------------------------------+
                  |    |     |      |     |     |     |
            14(In) 15(In) 18(Out) 23(Out) 24(Out) 8(In)  7(In)
              |      |     |      |     |     |     |
              |      |     |      |     |     |     +--- [ REX Exit Button ]
              |      |     |      |     |     +--------- [ DSM Door Sensor ]
              |      |     |      |     +--------------- [ Green Reader LED ]
              |      |     |      +--------------------- [ Red Reader LED ]
              |      +---------------------------- [ Lock Relay Board ]
              |      +---------------------------------- [ Card Reader Wiegand D1 ]
              +----------------------------------------- [ Card Reader Wiegand D0 ]
```

> [!IMPORTANT]
> Ensure common ground (GND) is shared between the Raspberry Pi, the external Wiegand reader power supply, and the relay boards to prevent floating voltage references.

---

## 5. Quick Installation & Execution Guide

### A. Database Network & Security Setup (ACS-DB)

When deploying PostgreSQL on a different host/IP from the Central Server or Edge Nodes, you must configure PostgreSQL to accept remote TCP connections.

#### 1. Enable Listener Interface
By default, PostgreSQL only listens on the local loopback interface (`127.0.0.1`). To change this, edit `/etc/postgresql/<version>/main/postgresql.conf` on the database server:
```ini
# Listen on all network interface IPs
listen_addresses = '*'
```

#### 2. Configure Client Authentication (`pg_hba.conf`)
You must allow your specific Central Server and Edge IP addresses (or subnets) to connect with credentials. Edit `/etc/postgresql/<version>/main/pg_hba.conf`:
```text
# TYPE  DATABASE        USER            ADDRESS                 METHOD
# Allow Central Server VM (192.168.0.140) to connect:
host    piacs_security  edge_ctrl       192.168.0.140/32        scram-sha-256

# Allow Edge Controller Subnet (e.g. 192.168.1.0/24) to connect:
host    piacs_security  edge_ctrl       192.168.1.0/24          scram-sha-256
```
After editing both files, restart PostgreSQL:
```bash
sudo systemctl restart postgresql
```

#### 3. Initialize the PostgreSQL schemas:
Ensure the database and user `edge_ctrl` exist, then run:
```bash
psql -d piacs_security -f db_schema_schedules.sql
psql -d piacs_security -f db_schema_lenels2.sql
psql -d piacs_security -f triggers.sql
```

---

### B. Central Server Deployment (ACS-FRONTEND)

The Central Management Server supports database routing overrides via the `DATABASE_URL` environment variable.

#### 1. Build the server binary:
```bash
cd central_server
go build -o central-server .
```

#### 2. Run with Custom IP Environment Variables:
If your database is hosted at `192.168.1.50`, specify the connection string inline:
```bash
DATABASE_URL="host=192.168.1.50 port=5432 user=edge_ctrl password=YOUR_DB_PASSWORD dbname=piacs_security sslmode=disable" ./central-server
```

#### 3. Systemd Service Configuration
If deploying as a systemd service, configure `/etc/systemd/system/central-server.service` to include the environment variables:
```ini
[Unit]
Description=PiACS Access Control Central Web Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/root
Environment="DATABASE_URL=host=YOUR_DB_IP port=5432 user=edge_ctrl password=YOUR_DB_PASSWORD dbname=piacs_security sslmode=disable"
ExecStart=/root/central-server
Restart=always
RestartSec=5
StandardOutput=append:/var/log/central_server_stdout.log
StandardError=append:/var/log/central_server_stderr.log

[Install]
WantedBy=multi-user.target
```

---

### C. Edge Controller Deployment (Raspberry Pi)

Each Edge node reads its target database IP from its local `config.json` configuration file.

#### 1. Create the `config.json` Configuration File
On the Raspberry Pi, create a file named `config.json` in the same directory as the executable:
```json
{
  "controller_id": "LOBBY-EDGE-01",
  "api_token": "YOUR_SECURE_API_BEARER_TOKEN",
  "backend_port": 8080,
  "database_config": {
    "db_host": "192.168.0.141",
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
    "apb_strict": true,
    "dfo_enabled": true,
    "dho_enabled": true,
    "dsm_normally_closed": true
  }
}
```
*Simply change the `"db_host"` field to match the IP address of your PostgreSQL database host.*

#### 2. Compile and Run:
Make sure to build with `CGO_ENABLED=1` for the embedded SQLite driver:
```bash
CGO_ENABLED=1 go build -ldflags="-s -w" -o piacs-edge-engine .
sudo ./piacs-edge-engine
```


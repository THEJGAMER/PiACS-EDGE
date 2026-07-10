# PiACS-EDGE: Physical Access Control System Edge & Enterprise Management Platform

PiACS-EDGE is an enterprise-grade physical access control system (PACS) engineered for distributed target execution. It contains two main components:
1. **PiACS-EDGE Engine (Edge Node)**: An autonomous controller written in Go that runs directly on a Raspberry Pi, interfacing with card readers, strike relays, and sensors over Linux's dynamic GPIO character device interface. It features local SQLite database failover survivability.
2. **PiACS Management Console (Central Server)**: A high-performance central Go web server and dark-themed, glassmorphic Single Page Application (SPA) dashboard that provides real-time event telemetry (swipes, door status, DFO/DHO alarms) via WebSockets/SSE and supports timezone schedule mapping, holiday calendars, and sitewide command overrides.

---

## Architectural Layout

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

## Key Features

1. **Autonomous Failover Survivability**:
   - **Online Mode**: Swipes are fully evaluated against PostgreSQL, checking user active posture, timezone active hours, and holiday schedules using the database server's time zone.
   - **Offline Mode**: If the PostgreSQL network is lost, the Pi seamlessly falls back to the internal `edge_cache.db` (SQLite) database cache to process swipes using basic active/inactive validation to guarantee perimeter uptime.
2. **Dynamic Timezones & Holidays Calendar**:
   - Normalized relational tables allow configuring time windows for weekdays (0-6) and holiday exceptions (day type 7).
   - Swiping during a holiday requires the credential to hold a Holiday-specific timezone override interval, preventing un-escorted access during closed schedules.
3. **Real-time Push Telemetry**:
   - PostgreSQL triggers fire `NOTIFY` events immediately upon log insertions.
   - The central web server listens using `pq.Listener` and streams log records instantly to the frontend using Server-Sent Events (SSE), eliminating browser polling latency.
4. **Sitewide and Local Directives**:
   - Support for triggering actions (Remote Unlock, Emergency Lockdown, Clear Alarm Siren) on individual doors or concurrently across all active nodes in the facility.
5. **Interactive Door Visualizer & Console**:
   - SVG visual representations of doors that swing open, secure, or blink red dynamically in response to state transitions (open/closed) and alarms (Door Forced Open - DFO, Door Held Open - DHO, Anti-Passback - APB).
   - Searchable audit logs with CSV exporting capabilities.

---

## Setup & Deployment Guide

### Prerequisites
- **Raspberry Pi**: Running a Debian-based OS (ARM64) with `go` (v1.24.4+ recommended) and `openssl`.
- **Database Server**: PostgreSQL database instance.
- **Frontend Server**: Standard Linux VM (x86_64 or ARM64) to serve the management portal.

---

### Step 1: Database Setup (ACS-DB)
1. Log in to your PostgreSQL instance and create the security database:
   ```sql
   CREATE DATABASE piacs_security;
   ```
2. Apply the database schemas defined in `db_schema_schedules.sql`:
   ```bash
   psql -d piacs_security -f db_schema_schedules.sql
   ```
3. Apply the real-time notification triggers defined in `triggers.sql`:
   ```bash
   psql -d piacs_security -f triggers.sql
   ```

---

### Step 2: Edge Node Setup (Raspberry Pi)
1. Transfer the codebase to the Pi (e.g. `/home/admin/PiACS-EDGE`).
2. Generate local self-signed TLS certificates for the secure override API:
   ```bash
   openssl req -x509 -newkey rsa:2048 -keyout server.key -out server.crt -sha256 -days 3650 -nodes -subj "/CN=192.168.1.200"
   ```
3. Update `config.json` to configure the target database connection, API security tokens, and hardware pin mappings.
4. Compile the engine directly on the Pi:
   ```bash
   CGO_ENABLED=1 go build -ldflags="-s -w" -o piacs-edge-engine .
   ```
5. Deploy as a background systemd service:
   - Copy `piacs-edge.service` to `/etc/systemd/system/piacs-edge.service`.
   - Reload systemd and start the daemon:
     ```bash
     sudo systemctl daemon-reload
     sudo systemctl enable piacs-edge.service
     sudo systemctl start piacs-edge.service
     ```

---

### Step 3: Central Server & Frontend Setup
1. From the repository root, compile the central server binary:
   ```bash
   go build -o central-server central_server/server.go
   ```
2. Transfer the `central-server` binary and the `central_server/web` folder to the frontend host (e.g. `/root/`).
3. Deploy as a background systemd service:
   - Copy `central-server.service` to `/etc/systemd/system/central-server.service`.
   - Reload and start:
     ```bash
     sudo systemctl daemon-reload
     sudo systemctl enable central-server.service
     sudo systemctl start central-server.service
     ```
4. Access the administration portal via your web browser at `http://<FRONTEND_IP>:8000`.

---

## Technical Specifications & DB Schemas

- **Holidays Table (`holidays`)**: Holds date exceptions (`holiday_date DATE PRIMARY KEY`).
- **Time Zones Table (`time_zones`)**: Named schedules.
- **Intervals Table (`time_zone_intervals`)**: Defines start/end windows for weekdays (0-6) and holidays (7).
- **Access Level Time Zones (`access_level_time_zones`)**: Maps access levels to readers and timezones.
- **Credentials (`credentials` & `users`)**: Holds active statuses and badge IDs.
- **Access Logs (`access_logs`)**: Records `CARD_GRANT`, `DENY`, `DENY_SCHEDULE`, `DOOR_OPEN`, `DOOR_CLOSE`, `APB_VIOLATION`.
- **System Alarms (`system_alarms`)**: Records active hardware breaches (`DFO`, `DHO`).

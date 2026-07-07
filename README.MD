# PIACS Edge – Distributed Industrial Access Control Engine

PIACS Edge is a high-performance, ultra-resilient, event-driven access control daemon engineered in Go. It interfaces directly with low-level Linux kernel character device frameworks via `gpiocdev` to drive physical access control hardware assemblies on the edge (e.g., Raspberry Pi Compute Module 4, custom industrial single-board computers). 

The engine handles sub-millisecond Wiegand bitstream packet decoding, enforces local Anti-Passback (APB) conditions, processes physical Request-to-Exit (REX) input loops, monitors door positions via Door Status Monitors (DSM), and executes state-machine-driven alerts for security anomalies.
```
---

## 🏗️ Core Architecture Blueprint

       +-------------------------------------------------------+
       |                PIACS Central Management               |
       |             (Centralized PostgreSQL Cluster)          |
       +-------------------------------------------------------+
                                   ▲
                                   | TLS Stream Session (TCP 5432)
                                   | (Bi-directional Heartbeats & Auditing)
                                   ▼
+----------------------------------------------------------------------------------+| PIACS Industrial Edge Node Assembly                                              ||                                                                                  ||   +----------------------------+      +-------------------+   +---------------+  ||   |       Go Core Engine       |◄====►|  SQLite Cache VFS |   | NVMe/EMMC Storage||   |  Async State Machine Loop  |      | (Offline Fallback)|   | (config.json) |  ||   +-------------▲--------------+      +-------------------+   +---------------+  ||                 |                                                                ||                 | (Native Kernel Line Events & IOCTL Descriptor Invocations)     ||                 ▼                                                                ||   +----------------------------------------------------------------------------+ ||   |               Physical I/O Character Device Interface Layer                | ||   |                                                                            | ||   |  [Wiegand D0/D1]  [DSM Sensor]  [REX Intercept]  [Strike Relay Controller] | ||   |  [Piezo Buzzer]   [Alarm Siren Driver (12V High-Side Line Driver)]         | ||   +----------------------------------------------------------------------------+ |+----------------------------------------------------------------------------------+
---
```
## 🚀 Advanced Subsystem Features

### 1. Zero-Lockout Local Survivability (Dual-Layer VFS Cache)
The system operates on an online-first architecture backed by a local SQLite embedded database engine. 
* **Online Mode:** Card swipes query the parent PostgreSQL repository instantly using optimized database indices. Background loops continuously keep local memory matrices matching remote schemas.
* **Offline Fallback Mode:** Background tickers monitor upstream ping failures. If the master network fails, the runtime environment cleanly swaps to local SQLite cache operations within 50ms, handling lookups and logging transactions locally. This ensures no building occupants are locked out. When the connection heals, the edge engine pushes stored logs upstream automatically.

### 2. Event-Driven Telemetry Isolation Routing
The logging subsystem divides alerts into separate database engines based on severity:
* **`access_logs`:** Tracks standard activity trends like valid entry grants, rejected invalid cards, and raw hardware position changes (`DOOR_OPEN` / `DOOR_CLOSE`).
* **`system_alarms`:** Only tracks true security risks like perimeter breaches, door forced open events, or prolonged entries. This lets security centers filter out noise.

### 3. Hot-Swappable Runtime Reconfiguration
The integrated HTTP API listener allows administrators to change hardware configurations on a running controller without stopping the process. Receiving an `UPDATE_CONFIG` network payload triggers an atomic routine:
1. Closes current open file handles and character device locks cleanly.
2. Rewrites the updated parameters directly to the local configuration file on disk.
3. Requests new file descriptors from the Linux kernel and applies new debounce configurations.
4. Updates the central management databases, completing the change in milliseconds.

### 4. Advanced Anti-Passback (APB) Integration
To prevent users from passing their credentials backward to unauthorized personnel, the engine enforces strict or soft Anti-Passback rules. The controller validates individual badge movements against their last recorded area, blocking sequential entries until an exit is processed.

---

## 📡 Native Linux Kernel System Dependencies

The application uses native C extensions (`CGO`) to interact directly with hardware pins and database engines. Your edge operating system must provide low-level access to the standard Linux GPIO character device subsystem.

> ⚠️ **CRITICAL CAPABILITY WARNING:** The legacy sysfs GPIO subsystem (`/sys/class/gpio`) is **not supported**. The hardware framework requires the modern Linux character device engine (`/dev/gpiochipX`) to ensure high-accuracy timestamp capture on falling signal edges.

To install the necessary compilation libraries, compilers, and device headers on a Debian/Raspberry Pi OS distribution, execute:

```bash
sudo apt-get update
sudo apt-get install -y \
    build-essential \
    gcc \
    libc6-dev \
    libgpiod-dev \
    sqlite3 \
    libsqlite3-dev
🛠️ Compilation & Compilation Feature FlagsBecause this program handles critical native runtime drivers, compile it using explicit target definitions.Standard Local CompilationTo compile the architecture directly on the physical hardware deployment node:Bash# Enable CGO wrapper systems to bind SQLite and libgpiod libraries
export CGO_ENABLED=1

# Compile with performance optimizations and drop debugging tracking symbols
go build -ldflags="-s -w" -o piacs-edge main.go config.go reader.go
Cross-Compilation for ARM64 Architectures (From x86_64 Build Machines)To build the binary on a desktop computer or CI/CD environment for target deployment on modern 64-bit single-board processors:Bash# Install the cross-compilation cross-compiler toolchain tool definitions
sudo apt-get install -y gcc-aarch64-linux-gnu

# Export cross-compilation target environment variables
export CGO_ENABLED=1
export GOOS=linux
export GOARCH=arm64
export CC=aarch64-linux-gnu-gcc

# Build optimized binary executable
go build -ldflags="-s -w" -o piacs-edge main.go config.go reader.go
🔧 Hardware Configuration Schema (config.json)The edge daemon reads its configuration profile at boot time from the project root directory.JSON{
  "controller_id": "BEDRM-1",
  "backend_port": 8080,
  "api_token": "p4ssw0rd_t0k3n_strt_12345",
  "database_config": {
    "db_host": "192.168.0.141",
    "db_port": 5432,
    "db_user": "edge_ctrl",
    "db_password": "your_secure_postgres_password",
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
    "dsm_pin": 16,
    "rex_pin": 17,
    "alarm_horn_pin": 27,
    "wiegand_timeout_ms": 50,
    "dho_timeout_secs": 30,
    "dho_pre_alarm_secs": 15,
    "apb_strict": true,
    "dfo_enabled": false,
    "dho_enabled": true,
    "dsm_normally_closed": true
  }
}
🗄️ Relational Database Layout (PostgreSQL Server)The central PostgreSQL tracking cluster uses optimized data types to handle fast verification passes under high traffic loads.SQL-- 1. Node Registration Master Inventory Table
CREATE TABLE controllers (
    controller_id VARCHAR(50) PRIMARY KEY,
    friendly_name VARCHAR(100) NOT NULL,
    token_hash VARCHAR(64) NOT NULL,
    server_ip VARCHAR(45) NOT NULL,
    is_online BOOLEAN DEFAULT false,
    last_heartbeat TIMESTAMP WITHOUT TIME ZONE,
    created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Hardware Synchronization Target Mirror Tables
CREATE TABLE controller_configs (
    controller_id VARCHAR(50) PRIMARY KEY REFERENCES controllers(controller_id) ON DELETE CASCADE,
    gpio_chip_device VARCHAR(50) NOT NULL,
    wiegand_d0_pin INT NOT NULL,
    wiegand_d1_pin INT NOT NULL,
    lock_relay_pin INT NOT NULL,
    reader_red_led_pin INT NOT NULL,
    reader_green_led_pin INT NOT NULL,
    reader_buzzer_pin INT NOT NULL,
    dsm_pin INT NOT NULL,
    rex_pin INT NOT NULL,
    wiegand_timeout_ms INT NOT NULL,
    dho_timeout_secs INT NOT NULL,
    apb_strict BOOLEAN NOT NULL,
    dfo_enabled BOOLEAN NOT NULL,
    dho_enabled BOOLEAN NOT NULL,
    dho_pre_alarm_secs INT NOT NULL,
    alarm_horn_pin INT NOT NULL,
    dsm_normally_closed BOOLEAN NOT NULL
);

-- 3. Access Auditing Table Index
CREATE TABLE access_logs (
    log_id SERIAL PRIMARY KEY,
    controller_id VARCHAR(50) REFERENCES controllers(controller_id) ON DELETE CASCADE,
    card_id BIGINT NOT NULL,
    employee_name VARCHAR(100) NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    details TEXT,
    created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. Perimeter Breach Exception Table Index
CREATE TABLE system_alarms (
    alarm_id SERIAL PRIMARY KEY,
    controller_id VARCHAR(50) REFERENCES controllers(controller_id) ON DELETE CASCADE,
    alarm_type VARCHAR(50) NOT NULL,
    details TEXT,
    created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
📡 Administrative API Command referenceInbound operational API payloads require a secure Bearer token verification signature inside the HTTP request header configuration: Authorization: Bearer <api_token>.Endpoint RouteHTTPPOST /api/v1/controller/remote-unlock
1. Execute Remote Bypass (Pulse Door Strike)Temporarily unlocks the door lock line driver for standard unlock cycle durations (e.g., 4 seconds).JSON{
  "controller_id": "BEDRM-1",
  "command": "REMOTE_UNLOCK"
}
2. Engage Emergency Facility LockdownImmediately suspends all standard access verification. Any subsequent card access requests are rejected regardless of user authorization status.JSON{
  "controller_id": "BEDRM-1",
  "command": "FORCE_LOCK"
}
3. Clear Active AlarmsSilences active alerting sirens, shuts off piezo buzzer pulsing loops, and resets internal alarm flags.JSON{
  "controller_id": "BEDRM-1",
  "command": "CLEAR_ALARMS"
}
4. Live Hot Reconfiguration InjectionJSON{
  "controller_id": "BEDRM-1",
  "command": "UPDATE_CONFIG",
  "new_config_payload": {
    "gpio_chip_device": "/dev/gpiochip4",
    "wiegand_d0_pin": 14,
    "wiegand_d1_pin": 15,
    "lock_relay_pin": 18,
    "reader_red_led_pin": 23,
    "reader_green_led_pin": 24,
    "reader_buzzer_pin": 25,
    "dsm_pin": 16,
    "rex_pin": 17,
    "alarm_horn_pin": 27,
    "wiegand_timeout_ms": 50,
    "dho_timeout_secs": 45,
    "dho_pre_alarm_secs": 20,
    "apb_strict": true,
    "dfo_enabled": true,
    "dho_enabled": true,
    "dsm_normally_closed": true
  }
}
🚀 Deployment & Production OperationsStep 1: Initializing Local EnvironmentClone this project repository directly onto the deployment destination folder layer of your hardware:Bashgit clone [https://github.com/your-org/piacs-edge.git](https://github.com/your-org/piacs-edge.git)
cd piacs-edge
Step 2: Enforce Local Secret IsolationBecause the configurations handle sensitive security tokens, database connection hashes, and environment credentials, you must prevent git from tracking local environment variations. Create your .gitignore profile:Bashecho "config.json" >> .gitignore
echo "edge_cache.db" >> .gitignore
echo "*.log" >> .gitignore
Step 3: Run the Controller DaemonTo allow the executable file to claim direct access to kernel character device descriptors and pin interrupts, start the engine with elevated system privileges:Bashsudo ./piacs-edge
📋 State Machine Operational Logic RulesTo aid field testing, the edge engine works according to these strict rules:State Trigger EventSystem PreconditionImmediate Output ActionsResulting Log EventCard Swipe CaughtCard valid, User Active, Lockdown InactiveEnergizes lock relay for 4 seconds, pulses green LED status line.CARD_GRANT -> access_logsCard Swipe CaughtCard valid, Facility Locked downKeeps relay locked, flashes red LED status line, chirps buzzer 5 times.DENY_LOCKDOWN -> access_logsDoor Position OpensAuthorized access cycle active (ExpectOpen == true)Starts internal timer tracking array metrics.DOOR_OPEN -> access_logsDoor Position OpensUnauthorized access cycle active (ExpectOpen == false)Checks configuration; if dfo_enabled is active, immediately trips siren output lines.DFO -> system_alarmsDoor Position Stays OpenOpened duration exceeds dho_pre_alarm_secs parameterStarts pulsing the local reader piezo buzzer array to warn nearby users.PRE_ALARM -> system_alarmsDoor Position Stays OpenOpened duration exceeds dho_timeout_secs parameterLatches the high-voltage alarm siren circuit into a high state.DHO -> system_alarms

# PIACS Edge – Distributed Access Control Engine

PIACS Edge is a high-performance, resilient, event-driven access control daemon written in Go. It is designed to run directly on physical edge hardware (such as a Raspberry Pi) utilizing low-level kernel character device drivers (`gpiocdev`) to interface with physical Wiegand badge readers, door status monitors (DSM), request-to-exit (REX) sensors, solid-state locking relays, and signaling matrices.

## 🏗️ Core Architecture Blueprint

   +-------------------------------------------------------+
   |                  PIACS Security Server                |
   |                   (Central PostgreSQL)                |
   +-------------------------------------------------------+
                               ▲
                               | (Bi-directional Sync / TLS)
                               ▼
+----------------------------------------------------------------------+
|                           PIACS Edge Node                            |
|                                                                      |
|  +-------------------+    +-------------------+    +--------------+  |
|  |     Go Engine     |◄==►|   Local SQLite    |    | Local Disk   |  |
|  |   State Machine   |    | (Offline Mirror)  |    | (config.json)|  |
|  +---------▲---------+    +-------------------+    +--------------+  |
|            |                                                         |
|            | (Low-level gpiocdev Kernel Line Mappings)               |
|            ▼                                                         |
|  +----------------------------------------------------------------+  |
|  |                         Physical I/O                           |  |
|  |  [Wiegand D0/D1]  [DSM Contact]  [REX Switch]  [Lock Relay]    |  |
|  |  [Reader Buzzer]  [Alarm Siren]                                |  |
|  +----------------------------------------------------------------+  |
+----------------------------------------------------------------------+


### Key Engineering Features
* **Dual-Layer Failover Isolation:** Leverages a live relational PostgreSQL connection when online. Shifts seamlessly into a localized SQLite survivability mirror if network routes drop, ensuring zero processing interruption or entry lockout.
* **Synchronized Event Handlers:** Directs hardware telemetry into distinct monitoring pipelines (`access_logs` for credential audits and door position shifts, `system_alarms` for actionable security breaches like forced or held entries).
* **Dynamic Hot Re-binding:** Exposes a secure network command API allowing remote administrative operators to alter runtime parameters, drop active alerts, or push a complete structural profile adjust that reallocates physical GPIO bindings on the fly without stopping the daemon.

---

## 🔧 Hardware Interface Configuration (`config.json`)

The edge engine evaluates its identity markers and physical pin layout configurations straight from a local file on disk. 

```json
{
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
🗄️ Relational Database Layout (PostgreSQL Server)
Ensure the centralized database engine exposes these explicit data schemas. Note that the system leverages strict native boolean flags and bigint parameters to support massive scaling constraints.

SQL
-- 1. Node Registration Master Inventory Table
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
📡 Administrative Network Command Interface
The edge daemon opens a globally listening HTTP endpoint API to accept signed operational requests. All inbound operations must present a valid authentication token profile signature header (Authorization: Bearer <api_token>).

Endpoint Target Route
HTTP
POST /api/v1/controller/remote-unlock
1. Execute Remote Bypass (Manual Gate Release)
JSON
{
  "controller_id": "BEDRM-1",
  "command": "REMOTE_UNLOCK"
}
2. Force Global Lockdown Override (Suspends Input Validation Engine)
JSON
{
  "controller_id": "BEDRM-1",
  "command": "FORCE_LOCK"
}
3. Clear Active Alerts (Brings Sirens and Buzzers Low)
JSON
{
  "controller_id": "BEDRM-1",
  "command": "CLEAR_ALARMS"
}
4. Dynamic Parameter Injection (Live Hot Re-config)
Modifies the physical properties on disk, tears down active kernel descriptors, maps the new hardware boundaries live, and pushes changes upstream to PostgreSQL.

JSON
{
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
🚀 Deployment Operations
Prerequisite System Libraries
The system relies on native C bindings for SQLite and requires local Linux kernel GPIO lines available via the character device subsystem (libgpiod). Install build essentials on your Raspberry Pi:

Bash
sudo apt-get update
sudo apt-get install -y build-essential libgpiod-dev
Compiling and Initializing the Binary Workspaces
Clone the codebase onto the target environment architecture filesystem and run compilation routines:

Bash
# Compile optimized edge executable
go build -o piacs-edge main.go config.go reader.go

# Start the application engine with elevated system privileges (required for direct device line locking)
sudo ./piacs-edge

---

### 🛡️ Don't Forget to Verify Your Git Exclusion File!
Since this document layout references secret tokens and raw production structural passwords inside `config.json`, make sure you have added your environment paths into your project's tracking exclusions. If your `.gitignore` isn't active yet, execute this snippet in your workspace directory:

```bash
echo "config.json" >> .gitignore
echo "edge_cache.db" >> .gitignore
echo "*.log" >> .gitignore
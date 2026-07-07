PiACS-EDGE: Physical Access Control System Edge EnginePiACS-EDGE is a high-performance, ultra-detailed access control engine written in Go. Engineered for distributed security architecture, it functions as an autonomous edge controller interfacing directly with physical hardware peripherals (Wiegand card readers, door status monitors, request-to-exit buttons, strike relays, and alarm horns) via the Linux gpio2 character device interface (gpiocdev).Featuring local SQLite survivability database mirrors, it guarantees uninterrupted fallback authentication during network isolation while transparently maintaining upstream tracking and configuration replication to a central PostgreSQL cluster.Architecture Overview
```
                        +----------------------------+
                        |  Central PostgreSQL Cluster|
                        +----------------------------+
                                      ^
                                      | Heartbeat / Sync / Audit Logs
                                      v
                        +----------------------------+
                        |     PiACS-EDGE Engine      |
                        +----------------------------+
                          /         |            \
                         /          |             \
                        v           v              v
         +-----------------+  +------------+  +-------------------+
         | Local SQLite DB |  | REST API   |  | Linux GPIO Chardev|
         | (Failover Cache)|  | Control V1 |  | (warthog618/gpio) |
         +-----------------+  +------------+  +-------------------+
                                                /   |    |    |   \
                                               v    v    v    v    v
                                              D0   D1  DSM  REX  Relay/Horn
```
Core Operational Mechanics1. Dual-Loop State Machine Perimeter WatcherThe core architecture decouples high-speed hardware interrupts from state monitoring using isolated asynchronous Go routines:Wiegand Bitstream Assembler (Loop A): Microsecond-level falling-edge event handlers sample incoming $D0$ and $D1$ lines. Collected bitstreams are automatically framed and dispatched via a buffered channel using a sliding window packet assembler driven by a configurable milliseconds timeout.Perimeter Status Tracker (Loop B): Monitors the Door Status Monitor (DSM) lines. It evaluates real-time telemetry to implement complex alarm scenarios:Door Forced Open (DFO): Fires immediately if a physical door breach occurs without a prior valid authorization strike or Request-To-Exit (REX) assertion.Door Held Open (DHO): Handles a staged timed alert sequence. If an authorized door remains open past dho_pre_alarm_secs, it begins pulsing local reader buzzers. If it remains open past dho_timeout_secs, it transitions into a critical alarm state, asserting physical alarm sirens.2. High Survivability Network Failover MirrorThe engine prioritizes perimeter uptime. During standard operation, credential validation uses a relational database pattern targeting a remote PostgreSQL infrastructure.If a database connection or network failure is detected, the engine enters a degraded offline mode. It seamlessly transfers localized authorization lookups to an internal SQLite mirror file database (edge_cache.db). A background synchronization routine executes continuous network health checks, automatically restoring parameters and pushing backlogged local transaction audits back to the main PostgreSQL cluster once connection status stabilizes.3. Comprehensive Anti-Passback (APB) EnforcementThe platform contains state-tracking state tables that log previous user regions. If a badge is scanned within an area where the badge holder is already physically tracked, the engine issues an APB_VIOLATION. In ApbStrict mode, the controller locks out access, protecting the perimeter against systemic badge-sharing breaches.4. Resilient Hardware Signal ManagementAnti-Chatter Electrical Latches: Lockout cycles rely on Mutex structures and active cooldown timers to avoid hardware damage caused by rapid relay re-activation or mechanical contact bounce.Debounced Sensor Lines: Input signals on critical sensory pins (DSM and REX) use hardware-level or kernel-space 25ms debounce constraints to ensure clean state machine transitions.Pinout Mapping & Hardware ConfigurationThe system loads its entire configuration topology from a localized config.json payload structure.config.json Schema Reference
JSON
```
{
  "controller_id": "CONTROLLER-HQ-01",
  "api_token": "super-secure-bearer-token-here",
  "backend_port": 8080,
  "database_config": {
    "db_host": "10.0.0.5",
    "db_port": 5432,
    "db_user": "piacs_edge_node",
    "db_password": "securepassword",
    "db_name": "piacs_access_db",
    "ssl_mode": "require"
  },
  "hardware_mapping": {
    "gpio_chip_device": "/dev/gpiochip4",
    "wiegand_d0_pin": 4,
    "wiegand_d1_pin": 5,
    "lock_relay_pin": 12,
    "reader_red_led_pin": 13,
    "reader_green_led_pin": 14,
    "reader_buzzer_pin": 15,
    "dsm_pin": 22,
    "rex_pin": 23,
    "wiegand_timeout_ms": 50,
    "dho_timeout_secs": 30,
    "apb_strict": true,
    "dfo_enabled": true,
    "dho_enabled": true,
    "dho_pre_alarm_secs": 15,
    "alarm_horn_pin": 26,
    "dsm_normally_closed": true
  }
}
```
Network API API Interface (v1)The application mounts a secure HTTP REST gateway to provide dynamic controller adjustments and real-time remote commands. All endpoints mandate a string matching the configured api_token sent via HTTP standard Bearer header validation: Authorization: Bearer <api_token>.Request Control Route: POST /api/v1/controller/remote-unlock1. Remote Unlock Strike BypassBypasses typical credential processing validation to trigger a direct mechanical release cycle.
JSON
```
{
  "controller_id": "CONTROLLER-HQ-01",
  "command": "REMOTE_UNLOCK"
}
2. Master Emergency Lockdown DeploymentBlocks all active badge-swipe access rules instantly across the local reader.JSON{
  "controller_id": "CONTROLLER-HQ-01",
  "command": "FORCE_LOCK"
}
3. Dynamic Hardware Profile UpdateReallocates internal memory structures, cleanly releases physical character device file handles, re-binds pins on-the-fly, updates local disk records, and mirrors profiles to the core infrastructure database without losing application state.JSON{
  "controller_id": "CONTROLLER-HQ-01",
  "command": "UPDATE_CONFIG",
  "new_config_payload": {
    "gpio_chip_device": "/dev/gpiochip4",
    "wiegand_d0_pin": 4,
    "wiegand_d1_pin": 5,
    "lock_relay_pin": 12,
    "dsm_pin": 22,
    "rex_pin": 23,
    "wiegand_timeout_ms": 60,
    "dho_timeout_secs": 45,
    "apb_strict": false,
    "dfo_enabled": true,
    "dho_enabled": true,
    "dho_pre_alarm_secs": 20,
    "alarm_horn_pin": 26,
    "dsm_normally_closed": false
  }
}
```
Note: Additional values supported by the command structure include REMOVE_LOCKDOWN, SUSTAIN_OPEN, CLOSE_SUSTAIN, and CLEAR_ALARMS.Local Compilation & DeploymentEnvironment PrerequisitesGo Compiler Platform Toolchain (v1.24.4 or newer recommended).CGO_ENABLED=1 is required for the application to compile the C-backed native SQLite subsystem wrapper interface (go-sqlite3).Linux target runtime kernel equipped with standard /dev/gpiochipX layout nodes.Compilation CommandsBash# Clone repository and navigate to entry root directory
cd PiACS-EDGE

# Download and tidy upstream dependency modules
go mod download
go mod tidy

# Compile production binary optimized for edge platform execution
CGO_ENABLED=1 GOOS=linux go build -ldflags="-s -w" -o piacs-edge-engine .
Process Management SetupTo run the executable as a managed background system daemon, configure a systemd unit profile: /etc/systemd/system/piacs-edge.service.Ini, TOML[Unit]
```
Description=PiACS Access Control Edge Engine
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/piacs
ExecStart=/opt/piacs/piacs-edge-engine
Restart=always
RestartSec=5
StandardOutput=append:/var/log/piacs_engine_stdout.log
StandardError=append:/var/log/piacs_engine_stderr.log

[Install]
WantedBy=multi-user.target
Bash# Register and start the system service
sudo systemctl daemon-reload
sudo systemctl enable piacs-edge.service
sudo systemctl start piacs-edge.service
```
System Diagnostics & TroubleshootingThe controller routes system errors to a rolling disk log (edge_engine.log).Critical Resource Lockout MatrixIf an engine thread attempts to claim exclusive pin reservations on a GPIO offset currently held by a separate kernel worker or alternative runtime system application, PiACS-EDGE generates a detailed hardware lockout warning matrix:
```
--------------------------------------------------------------------------------
[RESOURCE LOCKOUT ERROR]
Target Subsystem Element : D0
Physical Board Setting   : GPIO Offset 4
Kernel Error Reason      : device or resource busy
Current Active Consumer  : legacy-sysfs-daemon-app
--------------------------------------------------------------------------------\
```
Resolution Steps:Check the active consumer line noted in the diagnostic message.Terminate competing services targeting the corresponding peripheral line interfaces (lsof /dev/gpiochip*).Verify line settings inside config.json against your hardware schematic documentation.

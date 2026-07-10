# Project-Scoped Rules for PiACS-EDGE

## 1. Build and Compilation Requirements
- **CGO Required**: Always build the binary with `CGO_ENABLED=1` because the native SQLite driver (`go-sqlite3`) relies on C library mappings.
- **Optimized Compilation Flag**: For edge target execution, use:
  ```bash
  CGO_ENABLED=1 GOOS=linux go build -ldflags="-s -w" -o piacs-edge-engine .
  ```

## 2. GPIO & Hardware Constraints
- **Resource Cleanup**: When modifying the dynamic configuration flow or closing the application, make sure to call `CloseHardware()` to free all GPIO line handles. Unreleased handles lead to `[RESOURCE LOCKOUT ERROR]`.
- **Interrupt Decoupling**: Do not block the primary Wiegand bitstream reading interrupt routine. Decouple it asynchronously via Go channels and ticker intervals.
- **Sensor Line Debouncing**: Sensory pins (such as Door Status Monitor - DSM, and Request-to-Exit - REX) must be debounced with a minimum configuration of `25ms` in gpiocdev settings.

## 3. Database Failover & Schema Continuity
- **SQLite Fallback Compatibility**: Any changes to access queries must be compatible with both PostgreSQL and SQLite. Keep data mappings aligned (e.g., PostgreSQL booleans map to SQLite integers 0/1).
- **Audit Logging**: Ensure logs for card authorizations (`CARD_GRANT`, `APB_VIOLATION`, `DENY`) are recorded locally when offline, and synced upstream to PostgreSQL when the system is online.

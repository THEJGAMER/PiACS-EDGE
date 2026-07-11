-- LenelS2 Advanced Enterprise Features Database Schema

-- 1. Extend Credentials with Expiry and PIN Codes
ALTER TABLE credentials 
ADD COLUMN IF NOT EXISTS activation_date DATE DEFAULT CURRENT_DATE,
ADD COLUMN IF NOT EXISTS expiration_date DATE DEFAULT (CURRENT_DATE + INTERVAL '1 year'),
ADD COLUMN IF NOT EXISTS pin_code VARCHAR(8) DEFAULT NULL;

-- 2. System Settings (Threat Levels) Table
CREATE TABLE IF NOT EXISTS system_settings (
    key VARCHAR(50) PRIMARY KEY,
    value VARCHAR(255) NOT NULL
);
INSERT INTO system_settings (key, value) VALUES ('threat_level', 'NORMAL') ON CONFLICT DO NOTHING;

-- 3. Dynamic Health Telemetry Columns in Controllers
ALTER TABLE controllers
ADD COLUMN IF NOT EXISTS cpu_usage REAL DEFAULT 0.0,
ADD COLUMN IF NOT EXISTS memory_usage REAL DEFAULT 0.0,
ADD COLUMN IF NOT EXISTS buffered_logs INT DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_ping_ms INT DEFAULT 0,
ADD COLUMN IF NOT EXISTS server_ping_ms INT DEFAULT 0,
ADD COLUMN IF NOT EXISTS api_status VARCHAR(50) DEFAULT 'UNKNOWN';

-- 4. Interactive Door Map Placements Table
CREATE TABLE IF NOT EXISTS map_placements (
    controller_id VARCHAR(50) PRIMARY KEY REFERENCES controllers(controller_id) ON DELETE CASCADE,
    pos_x INT NOT NULL,
    pos_y INT NOT NULL
);

-- 5. Access Levels DHO Override feature
ALTER TABLE access_levels 
ADD COLUMN IF NOT EXISTS dho_override BOOLEAN DEFAULT FALSE;

-- 6. Controller Location Column
ALTER TABLE controllers
ADD COLUMN IF NOT EXISTS location VARCHAR(255) DEFAULT '';

-- 7. Add Relock on Open column to controller_configs
ALTER TABLE controller_configs
ADD COLUMN IF NOT EXISTS relock_on_open BOOLEAN DEFAULT FALSE;

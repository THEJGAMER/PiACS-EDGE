-- 1. Holidays Table
CREATE TABLE IF NOT EXISTS holidays (
    holiday_date DATE PRIMARY KEY,
    name VARCHAR(100) NOT NULL
);

-- 2. Time Zones Table
CREATE TABLE IF NOT EXISTS time_zones (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL
);

-- 3. Time Zone Intervals Table
CREATE TABLE IF NOT EXISTS time_zone_intervals (
    id SERIAL PRIMARY KEY,
    time_zone_id INT NOT NULL REFERENCES time_zones(id) ON DELETE CASCADE,
    day_of_week INT NOT NULL CHECK (day_of_week BETWEEN 0 AND 7), -- 0=Sunday, 1=Monday... 6=Saturday, 7=Holiday
    start_time TIME NOT NULL,
    end_time TIME NOT NULL
);

-- 4. Access Levels Table
CREATE TABLE IF NOT EXISTS access_levels (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL
);

-- 5. Access Level Time Zones Mapping Table
CREATE TABLE IF NOT EXISTS access_level_time_zones (
    access_level_id INT NOT NULL REFERENCES access_levels(id) ON DELETE CASCADE,
    reader_id VARCHAR(50) NOT NULL, -- Maps to controller_id
    time_zone_id INT NOT NULL REFERENCES time_zones(id),
    PRIMARY KEY (access_level_id, reader_id)
);

-- 6. Credential Access Levels Mapping Table
CREATE TABLE IF NOT EXISTS credential_access_levels (
    credential_id INT NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
    access_level_id INT NOT NULL REFERENCES access_levels(id) ON DELETE CASCADE,
    PRIMARY KEY (credential_id, access_level_id)
);

-- Grant privileges to edge_ctrl user
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO edge_ctrl;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO edge_ctrl;

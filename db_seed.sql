-- Clean old seed data if any
DELETE FROM credential_access_levels;
DELETE FROM access_level_time_zones;
DELETE FROM access_levels;
DELETE FROM time_zone_intervals;
DELETE FROM time_zones;
DELETE FROM holidays;

-- 1. Insert Holidays
-- Let's add 2026-07-10 (current date) as a test holiday
INSERT INTO holidays (holiday_date, name) VALUES ('2026-07-10', 'Dev Test Holiday');

-- 2. Insert Time Zones
-- ID 1: Business Hours (Mon-Fri 08:00 - 17:00, closed on weekends and holidays)
-- ID 2: 24/7 Access (All days including weekends/holidays)
INSERT INTO time_zones (id, name) VALUES (1, 'Business Hours');
INSERT INTO time_zones (id, name) VALUES (2, '24/7 Access');

-- 3. Insert Time Zone Intervals
-- Mon-Fri (1-5) for Business Hours (08:00:00 - 17:00:00)
INSERT INTO time_zone_intervals (time_zone_id, day_of_week, start_time, end_time) VALUES
(1, 1, '08:00:00', '17:00:00'),
(1, 2, '08:00:00', '17:00:00'),
(1, 3, '08:00:00', '17:00:00'),
(1, 4, '08:00:00', '17:00:00'),
(1, 5, '08:00:00', '17:00:00');

-- 24/7 Access (0-7: Sunday-Saturday and Holidays, 00:00:00 - 23:59:59)
INSERT INTO time_zone_intervals (time_zone_id, day_of_week, start_time, end_time) VALUES
(2, 0, '00:00:00', '23:59:59'),
(2, 1, '00:00:00', '23:59:59'),
(2, 2, '00:00:00', '23:59:59'),
(2, 3, '00:00:00', '23:59:59'),
(2, 4, '00:00:00', '23:59:59'),
(2, 5, '00:00:00', '23:59:59'),
(2, 6, '00:00:00', '23:59:59'),
(2, 7, '00:00:00', '23:59:59');

-- 4. Insert Access Levels
INSERT INTO access_levels (id, name) VALUES (1, 'Standard Staff');
INSERT INTO access_levels (id, name) VALUES (2, 'Super Admin');

-- 5. Insert Access Level Time Zones Mapping
-- Standard Staff has Business Hours on BEDRM-1
INSERT INTO access_level_time_zones (access_level_id, reader_id, time_zone_id) VALUES (1, 'BEDRM-1', 1);
-- Super Admin has 24/7 Access on BEDRM-1
INSERT INTO access_level_time_zones (access_level_id, reader_id, time_zone_id) VALUES (2, 'BEDRM-1', 2);

-- 6. Map existing credentials to Access Levels
-- Credential 2 (card_id 669653) -> Super Admin
INSERT INTO credential_access_levels (credential_id, access_level_id) VALUES (2, 2);
-- Credential 3 (card_id 289749) -> Standard Staff
INSERT INTO credential_access_levels (credential_id, access_level_id) VALUES (3, 1);

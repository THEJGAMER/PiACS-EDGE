-- Centralized Controller Diagnostic Logging Schema Setup

CREATE TABLE IF NOT EXISTS controller_logs (
    id SERIAL PRIMARY KEY,
    log_timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    controller_id VARCHAR(50) NOT NULL REFERENCES controllers(controller_id) ON DELETE CASCADE,
    level VARCHAR(10) NOT NULL, -- INFO, WARN, ERROR, FATAL
    message TEXT NOT NULL
);

-- Trigger function to push logs via pg_notify
CREATE OR REPLACE FUNCTION notify_controller_log()
RETURNS TRIGGER AS $$
DECLARE
    payload TEXT;
BEGIN
    payload := json_build_object(
        'event_source', 'controller_logs',
        'id', NEW.id,
        'log_timestamp', NEW.log_timestamp,
        'controller_id', NEW.controller_id,
        'level', NEW.level,
        'message', NEW.message
    )::text;
    PERFORM pg_notify('access_event', payload);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Bind trigger to table
DROP TRIGGER IF EXISTS controller_log_trigger ON controller_logs;
CREATE TRIGGER controller_log_trigger
AFTER INSERT ON controller_logs
FOR EACH ROW
EXECUTE FUNCTION notify_controller_log();

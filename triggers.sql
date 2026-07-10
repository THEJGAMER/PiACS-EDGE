CREATE OR REPLACE FUNCTION notify_access_event() RETURNS trigger AS $$
DECLARE
    payload json;
BEGIN
    -- Check if it's access_logs or system_alarms and assemble standard notification payload
    IF TG_TABLE_NAME = 'access_logs' THEN
        payload := json_build_object(
            'event_source', 'access_logs',
            'id', NEW.id,
            'event_timestamp', NEW.event_timestamp,
            'controller_id', NEW.controller_id,
            'card_id', NEW.card_id,
            'employee_name', NEW.employee_name,
            'event_type', NEW.event_type,
            'details', NEW.details
        );
    ELSIF TG_TABLE_NAME = 'system_alarms' THEN
        payload := json_build_object(
            'event_source', 'system_alarms',
            'alarm_id', NEW.alarm_id,
            'controller_id', NEW.controller_id,
            'alarm_type', NEW.alarm_type,
            'details', NEW.details,
            'is_cleared', NEW.is_cleared,
            'created_at', NEW.created_at
        );
    END IF;

    PERFORM pg_notify('access_event', payload::text);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply triggers
DROP TRIGGER IF EXISTS access_event_trigger ON access_logs;
CREATE TRIGGER access_event_trigger
AFTER INSERT ON access_logs
FOR EACH ROW EXECUTE FUNCTION notify_access_event();

DROP TRIGGER IF EXISTS alarm_event_trigger ON system_alarms;
CREATE TRIGGER alarm_event_trigger
AFTER INSERT ON system_alarms
FOR EACH ROW EXECUTE FUNCTION notify_access_event();

-- Retain the before and after write override with each connection lifecycle event.
ALTER TABLE connector_lifecycle_events ADD COLUMN before_value jsonb;
ALTER TABLE connector_lifecycle_events ADD COLUMN after_value jsonb;

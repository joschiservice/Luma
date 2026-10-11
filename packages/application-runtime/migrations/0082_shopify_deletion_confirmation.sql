-- Keep the source ledger and immutable evidence after a confirmed retirement.
ALTER TABLE commerce_sync_items DROP CONSTRAINT commerce_sync_items_status_check;
ALTER TABLE commerce_sync_items ADD CONSTRAINT commerce_sync_items_status_check CHECK(status IN ('current','pending','failed','retired'));
ALTER TABLE commerce_sync_items ADD COLUMN confirmation_checked_at timestamptz;

ALTER TABLE connector_refresh_hints ADD COLUMN reconcile boolean NOT NULL DEFAULT false;

-- Data sync reads one stream's latest runs; runs are retained, so a tenant-wide scan grows unbounded.
CREATE INDEX commerce_sync_run_stream ON commerce_sync_runs(tenant_id,stream_id,started_at DESC);
-- Data sync pages through records full reads no longer find in source key order. They are few
-- among a stream's records, which the primary key would otherwise scan to fill a page.
CREATE INDEX commerce_sync_item_missing ON commerce_sync_items(tenant_id,connection_id,record_type,resource,scope_key,external_id)
 WHERE missing_since IS NOT NULL AND status<>'retired';

-- Returns and refunds are order children owned by the orders owner, imported per source.
ALTER TABLE connector_source_mappings DROP CONSTRAINT connector_source_mappings_resource_check;
ALTER TABLE connector_source_mappings ADD CONSTRAINT connector_source_mappings_resource_check
 CHECK(resource IN ('order','order_line','fulfillment','sku','location','product','return','refund'));
ALTER TABLE orders_entities DROP CONSTRAINT orders_entities_kind_check;
ALTER TABLE orders_entities ADD CONSTRAINT orders_entities_kind_check
 CHECK(kind IN ('order','order_line','fulfillment','return','refund'));
ALTER TABLE orders_snapshots DROP CONSTRAINT orders_status;
ALTER TABLE orders_snapshots ADD CONSTRAINT orders_status
 CHECK(status IN ('open','completed','cancelled','unknown','pending','processing','shipped','delivered','failed',
  'requested','closed','declined'));

ALTER TABLE connector_read_checks DROP CONSTRAINT connector_read_checks_capability_check;
ALTER TABLE connector_read_checks ADD CONSTRAINT connector_read_checks_capability_check
 CHECK(capability IN ('orders.read','products.read','inventory.read','fulfillment.read','customers.read',
  'returns.read','orders.shipping-method.read'));
ALTER TABLE commerce_sync_streams DROP CONSTRAINT commerce_sync_streams_record_type_check;
ALTER TABLE commerce_sync_streams ADD CONSTRAINT commerce_sync_streams_record_type_check
 CHECK(record_type IN ('orders','fulfillments','products','inventory','customers','returns'));
ALTER TABLE commerce_sync_items DROP CONSTRAINT commerce_sync_items_record_type_check;
ALTER TABLE commerce_sync_items ADD CONSTRAINT commerce_sync_items_record_type_check
 CHECK(record_type IN ('orders','fulfillments','products','inventory','customers','returns'));

-- One row per current return, and per refund that no current return of its source settles.
-- Stage, refund state and amounts are derived by the orders owner in the projection
-- transaction; money counts as refunded only through successful refund payments.
CREATE TABLE orders_returns (
 tenant_id uuid NOT NULL, entity_id uuid NOT NULL, connection_id uuid NOT NULL,
 snapshot_id uuid NOT NULL, order_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('return','refund')),
 name text, order_number text, status text,
 stage text NOT NULL CHECK(stage IN ('requested','awaiting_items','awaiting_refund','refund_pending','refund_failed',
  'ready_to_close','closed','declined','cancelled','refunded','refund_recorded','unknown')),
 stage_group text NOT NULL CHECK(stage_group IN ('action','waiting','done')),
 refund_state text NOT NULL CHECK(refund_state IN ('none','recorded','pending','failed','partial','refunded')),
 quantity numeric(20,6), received numeric(20,6), refunded_units numeric(20,6),
 value_amount numeric(20,6), value_currency text CHECK(value_currency ~ '^[A-Z]{3}$'),
 currency text CHECK(currency ~ '^[A-Z]{3}$'),
 refunded_amount numeric(20,6), pending_amount numeric(20,6),
 failed_attempts integer NOT NULL CHECK(failed_attempts >= 0),
 reasons text[] NOT NULL,
 requested_at timestamptz, requested_key timestamptz NOT NULL, activity_at timestamptz NOT NULL,
 observed_at timestamptz NOT NULL, source_updated_at timestamptz, deleted boolean NOT NULL,
 PRIMARY KEY(tenant_id,entity_id,connection_id),
 CHECK((value_amount IS NULL) = (value_currency IS NULL)),
 FOREIGN KEY(tenant_id,entity_id,connection_id,snapshot_id)
  REFERENCES orders_snapshots(tenant_id,entity_id,connection_id,id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders_entities(tenant_id,id)
);
CREATE INDEX orders_returns_order ON orders_returns(tenant_id,order_id);
CREATE INDEX orders_returns_requested ON orders_returns(tenant_id,requested_key,entity_id);
CREATE INDEX orders_returns_activity ON orders_returns(tenant_id,activity_at,entity_id);
CREATE INDEX orders_returns_stage ON orders_returns(tenant_id,stage);
GRANT SELECT,INSERT,UPDATE,DELETE ON orders_returns TO luma_orders;
GRANT SELECT ON orders_returns TO luma_case_reader;
ALTER TABLE orders_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders_returns FORCE ROW LEVEL SECURITY;
CREATE POLICY list_owner ON orders_returns TO luma_orders
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY list_reader ON orders_returns FOR SELECT TO luma_case_reader
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

-- Sync scopes include the returns stream.
CREATE OR REPLACE FUNCTION commerce_sync_scopes() RETURNS TABLE(tenant_id uuid)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT DISTINCT t.tenant_id FROM (
  SELECT s.tenant_id FROM public.commerce_sync_streams s WHERE NOT s.paused AND s.blocked IS NULL
   AND (s.lease_until IS NULL OR s.lease_until < now()) AND (s.due_at <= now() OR s.hint_at <= now())
  UNION ALL SELECT h.tenant_id FROM public.connector_refresh_hints h WHERE h.consumed_at IS NULL
  UNION ALL SELECT i.tenant_id FROM public.connector_installations i WHERE i.document->>'status'='active'
   AND EXISTS (SELECT 1 FROM public.connector_lifecycle_events e WHERE e.tenant_id=i.tenant_id AND e.connection_id=i.id)
   AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(i.document->'granted') g(capability)
    WHERE g.capability IN ('orders.read','fulfillment.read','products.read','inventory.read','customers.read','returns.read')
    AND i.document->'permissions' ? g.capability
    AND NOT EXISTS (SELECT 1 FROM public.commerce_sync_streams s WHERE s.tenant_id=i.tenant_id AND s.connection_id=i.id
     AND s.record_type=CASE g.capability WHEN 'orders.read' THEN 'orders' WHEN 'fulfillment.read' THEN 'fulfillments'
      WHEN 'products.read' THEN 'products' WHEN 'inventory.read' THEN 'inventory' WHEN 'returns.read' THEN 'returns'
      ELSE 'customers' END))
  UNION ALL SELECT s.tenant_id FROM public.commerce_sync_streams s WHERE s.blocked IN ('connection_inactive','capability_removed')
   AND EXISTS (SELECT 1 FROM public.connector_installations i WHERE i.tenant_id=s.tenant_id AND i.id=s.connection_id
    AND i.document->>'status'='active'
    AND i.document->'granted' ? CASE s.record_type WHEN 'orders' THEN 'orders.read' WHEN 'fulfillments' THEN 'fulfillment.read'
     WHEN 'products' THEN 'products.read' WHEN 'inventory' THEN 'inventory.read' WHEN 'returns' THEN 'returns.read'
     ELSE 'customers.read' END
    AND i.document->'permissions' ? CASE s.record_type WHEN 'orders' THEN 'orders.read' WHEN 'fulfillments' THEN 'fulfillment.read'
     WHEN 'products' THEN 'products.read' WHEN 'inventory' THEN 'inventory.read' WHEN 'returns' THEN 'returns.read'
     ELSE 'customers.read' END)
  UNION ALL SELECT s.tenant_id FROM public.commerce_sync_streams s WHERE s.blocked IS NULL AND NOT s.paused
   AND EXISTS (SELECT 1 FROM public.connector_installations i WHERE i.tenant_id=s.tenant_id AND i.id=s.connection_id
    AND (i.document->>'status'<>'active' OR NOT (i.document->'granted' ? CASE s.record_type WHEN 'orders' THEN 'orders.read'
     WHEN 'fulfillments' THEN 'fulfillment.read' WHEN 'products' THEN 'products.read' WHEN 'inventory' THEN 'inventory.read'
     WHEN 'returns' THEN 'returns.read' ELSE 'customers.read' END)))
  UNION ALL SELECT l.tenant_id FROM public.commerce_identity_links l WHERE l.state='requested'
   OR (l.state='running' AND l.lease_until < now())
 ) t LIMIT 1000
$$;

-- One row per current fulfillment source projection with its operational facts in plain
-- columns. Fulfillment workspace filters compare these columns because row security prevents
-- index use on JSON expressions. The orders owner rewrites an order's rows with its projection
-- pointers; order facts come from the same connection's current order projection.
CREATE TABLE orders_fulfillment_list (
 tenant_id uuid NOT NULL, entity_id uuid NOT NULL, connection_id uuid NOT NULL,
 snapshot_id uuid NOT NULL, order_id uuid NOT NULL,
 kind text CHECK (kind IN ('fulfillment_order','shipment')),
 status text NOT NULL, deleted boolean NOT NULL,
 -- Null when the source does not report holds; empty when it reports none.
 hold_reasons text[],
 location_id uuid, location_name text,
 method_type text, method_name text,
 fulfill_at timestamptz, fulfill_by timestamptz, estimated_delivery_at timestamptz,
 last_progress_at timestamptz, delivery text, failure_code text,
 tracking_numbers text[] NOT NULL,
 units numeric NOT NULL, unit text,
 order_number text, order_status text, order_placed_at timestamptz,
 observed_at timestamptz NOT NULL, source_updated_at timestamptz,
 -- Work is still expected: pending or processing, not removed, and its order is not cancelled.
 open boolean NOT NULL,
 -- When the source last reported progress, falling back to its update or read time.
 progress_at timestamptz NOT NULL,
 deadline_at timestamptz,
 PRIMARY KEY(tenant_id,entity_id,connection_id),
 FOREIGN KEY(tenant_id,entity_id,connection_id,snapshot_id)
 REFERENCES orders_snapshots(tenant_id,entity_id,connection_id,id)
);
CREATE INDEX orders_fulfillment_list_order ON orders_fulfillment_list(tenant_id,order_id);
CREATE INDEX orders_fulfillment_list_open ON orders_fulfillment_list(tenant_id,open,progress_at,entity_id);
CREATE INDEX orders_fulfillment_list_progress ON orders_fulfillment_list(tenant_id,progress_at,entity_id,connection_id);
CREATE INDEX orders_fulfillment_list_location ON orders_fulfillment_list(tenant_id,location_id) WHERE location_id IS NOT NULL;

GRANT SELECT,INSERT,UPDATE,DELETE ON orders_fulfillment_list TO luma_orders;
GRANT SELECT ON orders_fulfillment_list TO luma_case_reader;
ALTER TABLE orders_fulfillment_list ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders_fulfillment_list FORCE ROW LEVEL SECURITY;
CREATE POLICY list_owner ON orders_fulfillment_list TO luma_orders
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY list_reader ON orders_fulfillment_list FOR SELECT TO luma_case_reader
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

INSERT INTO orders_fulfillment_list(tenant_id,entity_id,connection_id,snapshot_id,order_id,kind,status,deleted,
 hold_reasons,location_id,location_name,method_type,method_name,fulfill_at,fulfill_by,estimated_delivery_at,
 last_progress_at,delivery,failure_code,tracking_numbers,units,unit,order_number,order_status,order_placed_at,
 observed_at,source_updated_at,open,progress_at,deadline_at)
SELECT p.tenant_id,p.entity_id,p.connection_id,s.id,s.order_id,NULL,s.status,(s.document->>'deleted')::boolean,
 NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,
 (s.document->'data'->>'lastProgressAt')::timestamptz,NULL,s.document->'data'->>'failureCode','{}',
 COALESCE((SELECT sum((l->>'quantity')::numeric) FROM jsonb_array_elements(s.document->'data'->'lines') l),0),
 (SELECT CASE WHEN count(DISTINCT l->>'unit')=1 THEN min(l->>'unit') END FROM jsonb_array_elements(s.document->'data'->'lines') l),
 o.display_number,o.status,(o.document->'data'->>'placedAt')::timestamptz,
 s.observed_at,s.source_updated_at,
 s.status IN ('pending','processing') AND NOT (s.document->>'deleted')::boolean
  AND COALESCE(o.status,'unknown')<>'cancelled' AND NOT COALESCE((o.document->>'deleted')::boolean,false),
 COALESCE((s.document->'data'->>'lastProgressAt')::timestamptz,s.source_updated_at,s.observed_at),NULL
FROM orders_projections p
JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id AND s.kind='fulfillment'
LEFT JOIN orders_projections op ON op.tenant_id=p.tenant_id AND op.entity_id=s.order_id AND op.connection_id=p.connection_id
LEFT JOIN orders_snapshots o ON o.tenant_id=op.tenant_id AND o.id=op.snapshot_id;

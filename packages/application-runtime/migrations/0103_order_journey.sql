-- Milestones index owned snapshots; they do not replace commerce records or claim source update times as event times.
CREATE TABLE orders_journey_events (
 tenant_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),order_id uuid NOT NULL,part_id uuid NOT NULL,
 order_line_id uuid NOT NULL,connection_id uuid NOT NULL,stage text NOT NULL CHECK(stage IN('placed','paid','reserved','picked','shipped','delivered','returned')),
 snapshot_id uuid NOT NULL,observation_id uuid NOT NULL,occurred_at timestamptz,observed_at timestamptz NOT NULL,
 quantity numeric(24,6),unit text,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,connection_id,part_id,order_line_id,stage),
 FOREIGN KEY(tenant_id,snapshot_id) REFERENCES orders_snapshots(tenant_id,id),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES connector_installations(tenant_id,id)
);
CREATE INDEX orders_journey_order ON orders_journey_events(tenant_id,order_id,observed_at,id);
CREATE INDEX orders_journey_timing_window ON orders_journey_events(tenant_id,stage,occurred_at,part_id,connection_id,order_line_id) WHERE occurred_at IS NOT NULL;
CREATE INDEX orders_journey_timing ON orders_journey_events(tenant_id,stage,part_id,order_line_id,connection_id,occurred_at) WHERE occurred_at IS NOT NULL;
ALTER TABLE orders_journey_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders_journey_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON orders_journey_events TO luma_orders USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY workspace_read ON orders_journey_events FOR SELECT TO luma_case_reader USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON orders_journey_events TO luma_orders;
GRANT SELECT ON orders_journey_events TO luma_case_reader;

CREATE FUNCTION orders_index_journey(snapshot public.orders_snapshots) RETURNS void LANGUAGE sql SET search_path=pg_catalog,public AS $$
 INSERT INTO public.orders_journey_events(tenant_id,order_id,part_id,order_line_id,connection_id,stage,snapshot_id,observation_id,occurred_at,observed_at,quantity,unit)
 SELECT (snapshot).tenant_id,
 CASE WHEN (snapshot).kind='order' THEN (snapshot).entity_id ELSE ((snapshot).document->'data'->>'orderId')::uuid END,
 (snapshot).entity_id,COALESCE(line->>'id',line->>'orderLineId')::uuid,(snapshot).connection_id,m.stage,
 (snapshot).id,(snapshot).observation_id,m.occurred_at,(snapshot).observed_at,m.quantity,line->>'unit'
 FROM jsonb_array_elements((snapshot).document->'data'->'lines') line
 CROSS JOIN LATERAL (
  SELECT 'placed'::text stage,((snapshot).document->'data'->>'placedAt')::timestamptz occurred_at,(line->>'quantity')::numeric quantity
   WHERE (snapshot).kind='order' AND (snapshot).document->'data'->>'placedAt' IS NOT NULL
  UNION ALL SELECT 'paid',NULL,(line->>'quantity')::numeric
   WHERE (snapshot).kind='order' AND (snapshot).document->'data'->>'paymentStatus'='paid'
  UNION ALL SELECT 'picked',((snapshot).document->'data'->'milestones'->>'pickedAt')::timestamptz,(line->>'quantity')::numeric
   WHERE (snapshot).kind='fulfillment' AND (snapshot).document->'data'->'milestones'->>'pickedAt' IS NOT NULL
  UNION ALL SELECT 'shipped',((snapshot).document->'data'->'milestones'->>'shippedAt')::timestamptz,(line->>'quantity')::numeric
   WHERE (snapshot).kind='fulfillment' AND (snapshot).document->'data'->>'kind'='shipment'
    AND (snapshot).document->'data'->>'status' IN('shipped','delivered') AND (line->>'quantity')::numeric>0
  UNION ALL SELECT 'delivered',((snapshot).document->'data'->'milestones'->>'deliveredAt')::timestamptz,(line->>'quantity')::numeric
   WHERE (snapshot).kind='fulfillment' AND (snapshot).document->'data'->>'kind'='shipment'
    AND (snapshot).document->'data'->>'status'='delivered' AND (line->>'quantity')::numeric>0
  UNION ALL SELECT 'returned',((snapshot).document->'data'->>'receivedAt')::timestamptz,(line->>'receivedQuantity')::numeric
   WHERE (snapshot).kind='return' AND (line->>'receivedQuantity')::numeric>0
 ) m
 WHERE NOT COALESCE(((snapshot).document->>'deleted')::boolean,false)
  AND COALESCE(line->>'id',line->>'orderLineId') IS NOT NULL
 ON CONFLICT(tenant_id,connection_id,part_id,order_line_id,stage) DO UPDATE
 SET occurred_at=EXCLUDED.occurred_at,snapshot_id=EXCLUDED.snapshot_id,observation_id=EXCLUDED.observation_id,
 observed_at=EXCLUDED.observed_at,quantity=EXCLUDED.quantity,unit=EXCLUDED.unit
 WHERE orders_journey_events.occurred_at IS NULL AND EXCLUDED.occurred_at IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION orders_index_journey(public.orders_snapshots) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION orders_index_journey(public.orders_snapshots) TO luma_orders;
CREATE FUNCTION orders_journey_snapshot() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN PERFORM public.orders_index_journey(NEW); RETURN NEW; END $$;
CREATE TRIGGER orders_journey_snapshot AFTER INSERT ON orders_snapshots FOR EACH ROW EXECUTE FUNCTION orders_journey_snapshot();
DO $$ DECLARE snapshot public.orders_snapshots; BEGIN
 FOR snapshot IN SELECT * FROM public.orders_snapshots ORDER BY observed_at,id LOOP
  PERFORM public.orders_index_journey(snapshot);
 END LOOP;
END $$;
CREATE TRIGGER metric_change AFTER INSERT OR UPDATE OR DELETE ON orders_journey_events FOR EACH ROW EXECUTE FUNCTION notify_metric_change('orders');

-- New local holds retain their initiating actor; old holds keep unknown attribution.
ALTER TABLE inventory_native_reservations ADD COLUMN created_by text;

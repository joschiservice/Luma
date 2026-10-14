-- Carriers and the reported shipping stage of each current fulfillment as plain list columns,
-- so the Fulfillment list can filter and group by them without reading snapshot JSON.
-- Carriers are the distinct, trimmed carrier names of the tracking entries; a shipment
-- without tracking has none. The stage is null when the source reports no handoff evidence.
ALTER TABLE orders_fulfillment_list
 ADD COLUMN carriers text[] NOT NULL DEFAULT '{}',
 ADD COLUMN shipping_stage text CHECK (shipping_stage IN ('merchant','warehouse','carrier','delivered','unknown'));

UPDATE orders_fulfillment_list l SET
 carriers=ARRAY(SELECT DISTINCT left(btrim(t->>'carrier'),200)
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.document->'data'->'tracking')='array'
   THEN s.document->'data'->'tracking' ELSE '[]'::jsonb END) t
  WHERE btrim(COALESCE(t->>'carrier',''))<>'' ORDER BY 1),
 shipping_stage=CASE WHEN s.document->'data'->'shipping'->>'stage' IN ('merchant','warehouse','carrier','delivered','unknown')
  THEN s.document->'data'->'shipping'->>'stage' END
FROM orders_snapshots s
WHERE s.tenant_id=l.tenant_id AND s.id=l.snapshot_id;

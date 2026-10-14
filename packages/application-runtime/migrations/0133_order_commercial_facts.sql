-- Commercial facts of an order snapshot as plain list columns and value postings, so Orders
-- can filter and group by them with indexes that row security can use. Unreported facts stay
-- NULL or absent; they never become empty strings or false.

-- Tags, discount codes and shipping methods a snapshot reports, trimmed and deduplicated.
CREATE FUNCTION orders_commercial_facets(data jsonb)
RETURNS TABLE(kind text, value text) LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT DISTINCT f.kind,left(btrim(f.value),500) FROM (
  SELECT 'tag' AS kind,t #>> '{}' AS value
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(data->'tags')='array' THEN data->'tags' ELSE '[]'::jsonb END) t
  WHERE jsonb_typeof(t)='string'
  UNION ALL
  SELECT 'discount_code',d->>'label'
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(data->'discounts')='array' THEN data->'discounts' ELSE '[]'::jsonb END) d
  WHERE jsonb_typeof(d)='object' AND d->>'kind'='code'
  UNION ALL
  SELECT 'shipping_method',s->>'title'
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(data->'shippingLines')='array' THEN data->'shippingLines' ELSE '[]'::jsonb END) s
  WHERE jsonb_typeof(s)='object'
 ) f WHERE btrim(COALESCE(f.value,''))<>''
$$;

-- Scalar facts: sales channel, shop currency, test order and cancel reason.
CREATE FUNCTION orders_commercial_scalars(data jsonb)
RETURNS TABLE(channel text, currency text, test boolean, cancel_reason text)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT NULLIF(left(btrim(data->'attributes'->>'channel'),200),''),
  CASE WHEN COALESCE(data->'currencies'->>'shop',data->'total'->>'currency') ~ '^[A-Z]{3}$'
   THEN COALESCE(data->'currencies'->>'shop',data->'total'->>'currency') END,
  CASE WHEN jsonb_typeof(data->'attributes'->'test')='boolean' THEN (data->'attributes'->>'test')::boolean END,
  NULLIF(left(btrim(data->'attributes'->>'cancelReason'),200),'')
$$;

ALTER TABLE orders_list
 ADD COLUMN channel text,
 ADD COLUMN currency text,
 ADD COLUMN test boolean,
 ADD COLUMN cancel_reason text;
CREATE INDEX orders_list_channel ON orders_list(tenant_id,channel,entity_id) WHERE channel IS NOT NULL;
CREATE INDEX orders_list_currency ON orders_list(tenant_id,currency,entity_id) WHERE currency IS NOT NULL;
CREATE INDEX orders_list_test ON orders_list(tenant_id,test,entity_id) WHERE test IS NOT NULL;

CREATE TABLE orders_list_facets (
 tenant_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('tag','discount_code','shipping_method')),
 value text NOT NULL CHECK(length(value) BETWEEN 1 AND 500),
 entity_id uuid NOT NULL, connection_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,kind,value,entity_id,connection_id),
 FOREIGN KEY(tenant_id,entity_id,connection_id) REFERENCES orders_list(tenant_id,entity_id,connection_id) ON DELETE CASCADE
);
CREATE INDEX orders_list_facets_order ON orders_list_facets(tenant_id,entity_id,connection_id,kind);
GRANT SELECT,INSERT,UPDATE,DELETE ON orders_list_facets TO luma_orders;
GRANT SELECT ON orders_list_facets TO luma_case_reader;
ALTER TABLE orders_list_facets ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders_list_facets FORCE ROW LEVEL SECURITY;
CREATE POLICY list_owner ON orders_list_facets TO luma_orders
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY list_reader ON orders_list_facets FOR SELECT TO luma_case_reader
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

UPDATE orders_list l SET channel=f.channel,currency=f.currency,test=f.test,cancel_reason=f.cancel_reason
FROM orders_snapshots s CROSS JOIN LATERAL orders_commercial_scalars(s.document->'data') f
WHERE s.tenant_id=l.tenant_id AND s.id=l.snapshot_id;

INSERT INTO orders_list_facets(tenant_id,kind,value,entity_id,connection_id)
SELECT DISTINCT l.tenant_id,f.kind,f.value,l.entity_id,l.connection_id
FROM orders_list l JOIN orders_snapshots s ON s.tenant_id=l.tenant_id AND s.id=l.snapshot_id
CROSS JOIN LATERAL orders_commercial_facets(s.document->'data') f
WHERE NOT l.deleted;

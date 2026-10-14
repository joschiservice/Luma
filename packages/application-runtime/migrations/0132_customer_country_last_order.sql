-- Customer country and last order date as plain, indexed profile columns for the Customers
-- list. The country is the shared address's country as the source reports it, upper-cased; it
-- is null when the source shares no address, which the list treats as unknown rather than empty.
-- The last order date is the latest placed date among the source orders that the profile's own
-- connection attributes to the customer; orders without a reported placed date do not count.
ALTER TABLE customer_profiles
 ADD COLUMN country text GENERATED ALWAYS AS (NULLIF(upper(btrim(address->>'country')),'')) STORED,
 ADD COLUMN last_order_at timestamptz;
ALTER TABLE customer_orders ADD COLUMN placed_at timestamptz;

CREATE INDEX customer_profile_country ON customer_profiles(tenant_id,country,id);
CREATE INDEX customer_profile_last_order ON customer_profiles(tenant_id,last_order_at,id);

UPDATE customer_orders c SET placed_at=(
 SELECT (s.document->'data'->>'placedAt')::timestamptz FROM connector_source_mappings m
 JOIN orders_projections p ON p.tenant_id=m.tenant_id AND p.entity_id=m.canonical_id AND p.connection_id=m.connection_id
 JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
 WHERE m.tenant_id=c.tenant_id AND m.connection_id=c.connection_id AND m.resource='order'
  AND m.scope_key=c.order_scope_key AND m.external_id=c.order_external_id
 ORDER BY m.created_at,m.id LIMIT 1);

UPDATE customer_profiles p SET last_order_at=(
 SELECT max(c.placed_at) FROM customer_orders c
 WHERE c.tenant_id=p.tenant_id AND c.connection_id=p.connection_id AND c.customer_external_id=p.external_id);

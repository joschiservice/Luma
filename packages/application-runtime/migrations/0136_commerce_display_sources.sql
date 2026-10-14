-- Shipping evidence remains available without counting it as an additional commercial order.
UPDATE orders_list SET selected=false WHERE selected;
WITH chosen AS (
 SELECT DISTINCT ON(o.tenant_id,o.entity_id) o.tenant_id,o.entity_id,o.connection_id
 FROM orders_list o LEFT JOIN connector_installations c ON c.tenant_id=o.tenant_id AND c.id=o.connection_id
 WHERE COALESCE(c.document->>'provider',c.document->'target'->>'kind','')<>'starshipit'
 ORDER BY o.tenant_id,o.entity_id,o.deleted,o.source_updated_at DESC NULLS LAST,o.observed_at DESC,o.connection_id
)
UPDATE orders_list o SET selected=true FROM chosen c
 WHERE o.tenant_id=c.tenant_id AND o.entity_id=c.entity_id AND o.connection_id=c.connection_id;

-- One source view per linked order and work kind; split shipments in that view stay separate.
ALTER TABLE orders_fulfillment_list ADD COLUMN selected boolean NOT NULL DEFAULT false;
WITH sources AS (
 SELECT DISTINCT f.tenant_id,f.order_id,f.kind,f.connection_id,
  CASE WHEN f.kind='shipment' AND COALESCE(c.document->>'provider',c.document->'target'->>'kind')='starshipit' THEN 0
   WHEN COALESCE(c.document->>'provider',c.document->'target'->>'kind')='shopify' THEN 1 ELSE 2 END AS priority
 FROM orders_fulfillment_list f LEFT JOIN connector_installations c ON c.tenant_id=f.tenant_id AND c.id=f.connection_id
 WHERE NOT f.deleted
), chosen AS (
 SELECT DISTINCT ON(tenant_id,order_id,kind) * FROM sources ORDER BY tenant_id,order_id,kind,priority,connection_id
)
UPDATE orders_fulfillment_list f SET selected=f.connection_id=c.connection_id FROM chosen c
 WHERE f.tenant_id=c.tenant_id AND f.order_id=c.order_id AND f.kind=c.kind;
CREATE INDEX fulfillment_list_selected ON orders_fulfillment_list(tenant_id,order_id,kind,entity_id) WHERE selected;

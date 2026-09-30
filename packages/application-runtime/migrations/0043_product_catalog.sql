-- Catalog rows repeat each current product snapshot's listing facts for its SKUs. Products
-- workspace reads compare plain columns because row security prevents index use on JSON
-- expressions. Inventory maintains the rows with the projection pointer.
ALTER TABLE inventory_product_skus
 ADD COLUMN snapshot_id uuid,
 ADD COLUMN product_title text,
 ADD COLUMN product_status text,
 ADD COLUMN vendor text,
 ADD COLUMN published boolean,
 ADD COLUMN variant_title text,
 ADD COLUMN barcode text,
 ADD COLUMN price_amount numeric,
 ADD COLUMN price_currency text,
 ADD COLUMN unit text,
 ADD COLUMN observed_at timestamptz,
 ADD COLUMN source_updated_at timestamptz;

UPDATE inventory_product_skus k SET
 snapshot_id=s.id,
 product_title=s.document->'data'->>'title',
 product_status=s.document->'data'->>'status',
 unit=COALESCE((SELECT v->>'unit' FROM jsonb_array_elements(s.document->'data'->'skus') v
  WHERE v->>'skuId'=k.sku_id::text LIMIT 1),'unknown'),
 observed_at=s.observed_at,
 source_updated_at=s.source_updated_at
FROM inventory_projections p
JOIN inventory_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
WHERE p.tenant_id=k.tenant_id AND p.entity_id=k.product_id AND p.connection_id=k.connection_id;

ALTER TABLE inventory_product_skus
 ALTER COLUMN snapshot_id SET NOT NULL,
 ALTER COLUMN product_status SET NOT NULL,
 ALTER COLUMN unit SET NOT NULL,
 ALTER COLUMN observed_at SET NOT NULL,
 ADD CONSTRAINT inventory_product_sku_status
  CHECK (product_status IN ('active','draft','archived','unknown')),
 ADD CONSTRAINT inventory_product_sku_currency
  CHECK (price_currency IS NULL OR price_currency ~ '^[A-Z]{3}$'),
 ADD CONSTRAINT inventory_product_sku_snapshot
  FOREIGN KEY(tenant_id,snapshot_id) REFERENCES inventory_snapshots(tenant_id,id);

-- Comparison keys ignore case, spacing and punctuation in titles and leading zeros in barcodes.
ALTER TABLE inventory_product_skus
 ADD COLUMN title_key text COLLATE "C" GENERATED ALWAYS AS (CASE WHEN product_title IS NOT NULL THEN
  lower(regexp_replace(product_title||' '||COALESCE(variant_title,''),'[^[:alnum:]]+','','g')) END) STORED,
 ADD COLUMN barcode_key text COLLATE "C" GENERATED ALWAYS AS (NULLIF(ltrim(btrim(barcode),'0'),'')) STORED;

CREATE INDEX inventory_product_sku_connection ON inventory_product_skus(tenant_id,connection_id,sku_id);

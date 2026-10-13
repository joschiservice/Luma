-- Merchandising identity is separate from the inventory item and its physical balances.
ALTER TABLE inventory_product_skus ADD COLUMN requires_components boolean;
ALTER TABLE inventory_product_skus ADD COLUMN component_count integer CHECK(component_count BETWEEN 0 AND 5000);
ALTER TABLE inventory_product_skus ADD COLUMN variant_source_id text;
CREATE INDEX inventory_product_variant_source ON inventory_product_skus(tenant_id,connection_id,variant_source_id) WHERE variant_source_id IS NOT NULL;

-- Component dependencies let an explicit SKU remap replay its owning product recipe.
CREATE TABLE inventory_bundle_components (
 tenant_id uuid NOT NULL, product_id uuid NOT NULL, connection_id uuid NOT NULL,
 parent_sku_id uuid NOT NULL, snapshot_id uuid NOT NULL,
 source_component_id text NOT NULL, source_scope_key text NOT NULL,
 component_sku_id uuid,
 PRIMARY KEY(tenant_id,product_id,connection_id,parent_sku_id,source_component_id,source_scope_key),
 FOREIGN KEY(tenant_id,product_id,connection_id,parent_sku_id) REFERENCES inventory_product_skus(tenant_id,product_id,connection_id,sku_id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,snapshot_id) REFERENCES inventory_snapshots(tenant_id,id),
 FOREIGN KEY(tenant_id,component_sku_id) REFERENCES inventory_entities(tenant_id,id)
);
CREATE INDEX inventory_bundle_component_target ON inventory_bundle_components(tenant_id,component_sku_id,connection_id,product_id) WHERE component_sku_id IS NOT NULL;
GRANT SELECT,INSERT,DELETE ON inventory_bundle_components TO luma_inventory;
GRANT SELECT ON inventory_bundle_components TO luma_case_reader;
ALTER TABLE inventory_bundle_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_bundle_components FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON inventory_bundle_components TO luma_inventory
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY workspace_read ON inventory_bundle_components FOR SELECT TO luma_case_reader
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

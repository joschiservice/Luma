-- Supplier observations and human overrides are append-only; a new version preserves price history.
CREATE TABLE procurement_supplier_terms (
 tenant_id uuid NOT NULL, id uuid NOT NULL, supplier_id uuid NOT NULL, sku_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision > 0), document jsonb NOT NULL,
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,supplier_id,sku_id,revision),
 FOREIGN KEY(tenant_id,sku_id) REFERENCES inventory_entities(tenant_id,id),
 FOREIGN KEY(tenant_id,supplier_id) REFERENCES procurement_suppliers(tenant_id,id),
 CHECK(document->>'supplierId'=supplier_id::text AND document->>'skuId'=sku_id::text)
);
CREATE TABLE procurement_terms_commands (
 tenant_id uuid NOT NULL REFERENCES organizations(id), id uuid NOT NULL, digest text NOT NULL, result jsonb NOT NULL,
 PRIMARY KEY(tenant_id,id)
);
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['procurement_supplier_terms','procurement_terms_commands'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO luma_desk USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',relation);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO luma_desk',relation);
 END LOOP;
END $$;
-- The sync worker needs the owner service and its audit transaction, never direct updates.
GRANT SELECT ON procurement_suppliers TO luma_commerce_sync;
CREATE POLICY terms_supplier_sync ON procurement_suppliers FOR SELECT TO luma_commerce_sync
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT ON inventory_entities,inventory_product_skus TO luma_desk;
CREATE POLICY purchasing_terms_identity ON inventory_entities FOR SELECT TO luma_desk
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY purchasing_terms_catalog ON inventory_product_skus FOR SELECT TO luma_desk
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

-- Latest read freshness is separate from immutable value history.
CREATE TABLE procurement_terms_reads (
 tenant_id uuid NOT NULL,supplier_id uuid NOT NULL,sku_id uuid NOT NULL,
 observed_at timestamptz NOT NULL,complete boolean NOT NULL,
 PRIMARY KEY(tenant_id,supplier_id,sku_id),
 FOREIGN KEY(tenant_id,supplier_id) REFERENCES procurement_suppliers(tenant_id,id),
 FOREIGN KEY(tenant_id,sku_id) REFERENCES inventory_entities(tenant_id,id)
);
ALTER TABLE procurement_terms_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE procurement_terms_reads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON procurement_terms_reads TO luma_desk
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE(observed_at,complete) ON procurement_terms_reads TO luma_desk;

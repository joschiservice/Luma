-- Procurement owns selected business records independently of connector projections.
CREATE TABLE procurement_suppliers (
 tenant_id uuid NOT NULL REFERENCES organizations(id),
 id uuid NOT NULL,
 document jsonb NOT NULL,
 PRIMARY KEY(tenant_id,id),
 CHECK(COALESCE(document->>'tenantId'=tenant_id::text AND document->>'id'=id::text,false))
);
CREATE TABLE procurement_purchase_orders (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 supplier_id uuid NOT NULL,
 document jsonb NOT NULL,
 created_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,supplier_id) REFERENCES procurement_suppliers(tenant_id,id),
 CHECK(COALESCE(document->>'tenantId'=tenant_id::text AND document->>'id'=id::text AND document->>'supplierId'=supplier_id::text,false)),
 CHECK(document->>'status' IN ('draft','open','closed','cancelled')),
 CHECK(document->>'authority' IN ('luma','external')),
 CHECK(jsonb_array_length(document->'lines') BETWEEN 1 AND 100)
);
CREATE INDEX procurement_orders_recent ON procurement_purchase_orders(tenant_id,created_at DESC,id);
CREATE TABLE procurement_commands (
 tenant_id uuid NOT NULL REFERENCES organizations(id),
 id uuid NOT NULL,
 digest text NOT NULL,
 result jsonb NOT NULL,
 PRIMARY KEY(tenant_id,id)
);
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['procurement_suppliers','procurement_purchase_orders','procurement_commands'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO luma_desk USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',relation);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO luma_desk',relation);
 END LOOP;
END $$;
GRANT UPDATE(document) ON procurement_purchase_orders TO luma_desk;

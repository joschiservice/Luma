CREATE TABLE shopify_inventory_corrections (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 connection_id uuid NOT NULL,
 position_id uuid NOT NULL,
 revision text NOT NULL,
 document jsonb NOT NULL,
 decision_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES connector_installations(tenant_id,id),
 CHECK(document->>'tenantId'=tenant_id::text AND document->>'id'=id::text)
);
CREATE INDEX shopify_inventory_corrections_target ON shopify_inventory_corrections(tenant_id,connection_id,position_id,created_at DESC);
CREATE TABLE shopify_inventory_claims (
 tenant_id uuid NOT NULL,
 connection_id uuid NOT NULL,
 target_key text NOT NULL,
 revision text NOT NULL,
 run_id uuid NOT NULL,
 settled boolean NOT NULL DEFAULT false,
 PRIMARY KEY(tenant_id,connection_id,target_key,revision),
 FOREIGN KEY(tenant_id,run_id) REFERENCES shopify_inventory_corrections(tenant_id,id)
);
CREATE TABLE shopify_inventory_evidence (
 tenant_id uuid NOT NULL,
 connection_id uuid NOT NULL,
 id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('observation','acceptance')),
 observed_at timestamptz NOT NULL,
 document jsonb NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES connector_installations(tenant_id,id)
);
GRANT SELECT,INSERT ON shopify_inventory_corrections,shopify_inventory_evidence,shopify_inventory_claims TO luma_connectors;
GRANT UPDATE(settled) ON shopify_inventory_claims TO luma_connectors;
GRANT UPDATE(decision_id) ON shopify_inventory_corrections TO luma_connectors;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['shopify_inventory_corrections','shopify_inventory_evidence','shopify_inventory_claims'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format($policy$CREATE POLICY tenant_scope ON %I TO luma_connectors USING (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid)$policy$,name);
 END LOOP;
END $$;

-- Shopify's correction query reads canonical stock; inventory remains the sole writer.
GRANT SELECT ON inventory_projections,inventory_snapshots TO luma_connectors;
CREATE POLICY shopify_correction_read ON inventory_projections FOR SELECT TO luma_connectors
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY shopify_correction_read ON inventory_snapshots FOR SELECT TO luma_connectors
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

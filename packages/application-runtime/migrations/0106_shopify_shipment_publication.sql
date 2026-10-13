CREATE TABLE shopify_shipment_publications (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 connection_id uuid NOT NULL,
 order_id text NOT NULL,
 revision text NOT NULL,
 document jsonb NOT NULL,
 decision_id uuid,
 sent_at timestamptz,
 closed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES connector_installations(tenant_id,id),
 CHECK(document->>'tenantId'=tenant_id::text AND document->>'id'=id::text)
);
CREATE INDEX shopify_shipment_publications_target ON shopify_shipment_publications(tenant_id,connection_id,order_id,created_at DESC);
CREATE TABLE shopify_shipment_claims (
 tenant_id uuid NOT NULL,
 connection_id uuid NOT NULL,
 order_id text NOT NULL,
 revision text NOT NULL,
 run_id uuid NOT NULL,
 settled boolean NOT NULL DEFAULT false,
 PRIMARY KEY(tenant_id,connection_id,order_id,revision),
 FOREIGN KEY(tenant_id,run_id) REFERENCES shopify_shipment_publications(tenant_id,id)
);
CREATE TABLE shopify_shipment_evidence (
 tenant_id uuid NOT NULL,
 connection_id uuid NOT NULL,
 id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('observation','acceptance')),
 observed_at timestamptz NOT NULL,
 document jsonb NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES connector_installations(tenant_id,id)
);
GRANT SELECT,INSERT ON shopify_shipment_publications,shopify_shipment_evidence,shopify_shipment_claims TO luma_connectors;
GRANT UPDATE(settled) ON shopify_shipment_claims TO luma_connectors;
GRANT UPDATE(decision_id,sent_at,closed_at) ON shopify_shipment_publications TO luma_connectors;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['shopify_shipment_publications','shopify_shipment_evidence','shopify_shipment_claims'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format($policy$CREATE POLICY tenant_scope ON %I TO luma_connectors USING (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid)$policy$,name);
 END LOOP;
END $$;

CREATE TABLE shopify_shipment_source_claims (
 tenant_id uuid NOT NULL,
 connection_id uuid NOT NULL,
 dispatch_key text NOT NULL,
 run_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,connection_id,dispatch_key),
 FOREIGN KEY(tenant_id,run_id) REFERENCES shopify_shipment_publications(tenant_id,id)
);
GRANT SELECT,INSERT,DELETE ON shopify_shipment_source_claims TO luma_connectors;
ALTER TABLE shopify_shipment_source_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopify_shipment_source_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON shopify_shipment_source_claims TO luma_connectors
 USING (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid);

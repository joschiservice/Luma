-- A complete read of one order does not establish completeness of a provider collection.
CREATE TABLE connector_order_read_checks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 connection_id uuid NOT NULL,
 order_external_id text NOT NULL,
 order_scope_key text NOT NULL,
 capability text NOT NULL CHECK(capability IN ('orders.read','fulfillment.read')),
 observed_at timestamptz NOT NULL,
 complete boolean NOT NULL,
 observation_ids uuid[] NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES connector_installations(tenant_id,id)
);
CREATE INDEX connector_order_read_checks_latest ON connector_order_read_checks
 (tenant_id,connection_id,order_external_id,order_scope_key,capability,observed_at DESC,created_at DESC,id DESC);
GRANT SELECT,INSERT ON connector_order_read_checks TO luma_connectors;
GRANT SELECT ON connector_order_read_checks TO luma_case_reader;
ALTER TABLE connector_order_read_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_order_read_checks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON connector_order_read_checks TO luma_connectors,luma_case_reader
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

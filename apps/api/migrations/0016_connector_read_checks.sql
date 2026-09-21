-- Read outcomes include successful empty pages and failures without inventing resource records.
CREATE TABLE connector_read_checks (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 tenant_id uuid NOT NULL,
 connection_id uuid NOT NULL,
 capability text NOT NULL CHECK(capability IN ('orders.read','products.read','inventory.read','fulfillment.read','orders.shipping-method.read')),
 observed_at timestamptz NOT NULL,
 succeeded boolean NOT NULL,
 document jsonb NOT NULL,
 FOREIGN KEY(tenant_id,connection_id) REFERENCES connector_installations(tenant_id,id)
);
CREATE INDEX connector_read_checks_latest ON connector_read_checks(tenant_id,connection_id,capability,observed_at DESC,id DESC);
GRANT SELECT,INSERT ON connector_read_checks TO luma_connectors;
GRANT USAGE ON SEQUENCE connector_read_checks_id_seq TO luma_connectors;
GRANT SELECT ON connector_read_checks TO luma_case_reader;
ALTER TABLE connector_read_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_read_checks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON connector_read_checks TO luma_connectors
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY overview_reads ON connector_read_checks FOR SELECT TO luma_case_reader
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

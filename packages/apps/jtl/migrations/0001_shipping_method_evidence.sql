-- Shipping-method corrections cite a verification read and a write receipt. The correction's
-- binding stores both here before execution cites their IDs, so every cited ID resolves to the
-- evidence itself through the JTL app's evidence reader. A read keeps its source identity,
-- freshness, completeness and allowlisted method snapshot; a receipt keeps the normalized
-- acceptance without the provider payload. Corrections cited before this table existed stay
-- unresolved. Rows are append-only. The document check treats a missing field as a violation,
-- since a check whose expression is null would otherwise pass.
CREATE TABLE jtl_shipping_method_evidence (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 connection_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('read','write_receipt')),
 observed_at timestamptz NOT NULL,
 document jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES connector_installations(tenant_id,id),
 CHECK(COALESCE(document->>'id'=id::text
  AND document->'source'->>'connectionId'=connection_id::text
  AND CASE kind
   WHEN 'read' THEN document->>'completeness' IN ('complete','partial')
    AND document->>'adapterVersion'<>''
   ELSE document->>'kind'='write_receipt' AND document->>'status'='accepted'
    AND document->>'idempotencyKey'<>'' AND document->>'adapterVersion'<>''
    AND document->>'dispatchIdentity'<>'' END, false))
);
ALTER TABLE jtl_shipping_method_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE jtl_shipping_method_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON jtl_shipping_method_evidence TO luma_connectors
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON jtl_shipping_method_evidence TO luma_connectors;

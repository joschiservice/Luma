-- Receipt identity remains fenced after successful or uncertain dispatch, independent of changing stock revisions.
CREATE TABLE shopify_receipt_stock_claims (
 tenant_id uuid NOT NULL,
 run_id uuid NOT NULL,
 receipt_id uuid NOT NULL,
 withheld boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,run_id),
 FOREIGN KEY(tenant_id,run_id) REFERENCES shopify_inventory_corrections(tenant_id,id),
 FOREIGN KEY(tenant_id,receipt_id) REFERENCES procurement_commitments(tenant_id,id)
);
CREATE INDEX shopify_receipt_stock_claims_receipt ON shopify_receipt_stock_claims(tenant_id,receipt_id);
ALTER TABLE shopify_receipt_stock_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopify_receipt_stock_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON shopify_receipt_stock_claims TO luma_connectors
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON shopify_receipt_stock_claims TO luma_connectors;
GRANT UPDATE(withheld) ON shopify_receipt_stock_claims TO luma_connectors;

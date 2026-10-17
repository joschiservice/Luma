-- Purchasing-system reads that submission and revision verification cite. Each row keeps the
-- read's source identity, freshness and completeness, so a cited observation ID resolves to the
-- evidence itself. Rows are append-only.
CREATE TABLE procurement_read_evidence (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 purchase_order_id uuid NOT NULL,
 connection_id uuid NOT NULL,
 purpose text NOT NULL CHECK(purpose IN ('submission','revision')),
 subject_id uuid NOT NULL,
 observed_at timestamptz NOT NULL,
 document jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,purchase_order_id) REFERENCES procurement_purchase_orders(tenant_id,id),
 CHECK(document->>'id'=id::text AND document->>'tenantId'=tenant_id::text
  AND document->>'purchaseOrderId'=purchase_order_id::text
  AND document->'source'->>'connectionId'=connection_id::text
  AND document->>'purpose'=purpose AND document->>'subjectId'=subject_id::text
  AND document->>'completeness' IN ('complete','partial'))
);
CREATE INDEX procurement_read_evidence_subject ON procurement_read_evidence(tenant_id,subject_id,observed_at DESC);
ALTER TABLE procurement_read_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE procurement_read_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON procurement_read_evidence TO luma_desk
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON procurement_read_evidence TO luma_desk;

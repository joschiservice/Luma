-- Provider reads that return creation, settlement and exchange verification, their audit entries
-- and return-deadline money evidence cite. Each row keeps the read's source identity, freshness
-- and completeness, so a cited observation ID resolves to the evidence itself. Rows are
-- append-only.
CREATE TABLE orders_return_read_evidence (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 case_id uuid NOT NULL,
 connection_id uuid NOT NULL,
 purpose text NOT NULL CHECK(purpose IN ('creation','settlement','exchange','completion')),
 subject_id uuid NOT NULL,
 observed_at timestamptz NOT NULL,
 document jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,case_id) REFERENCES orders_return_cases(tenant_id,id),
 CHECK(document->>'id'=id::text AND document->>'tenantId'=tenant_id::text
  AND document->>'caseId'=case_id::text
  AND document->'source'->>'connectionId'=connection_id::text
  AND document->>'purpose'=purpose AND document->>'subjectId'=subject_id::text
  AND document->>'completeness' IN ('complete','partial'))
);
CREATE INDEX orders_return_read_evidence_subject ON orders_return_read_evidence(tenant_id,subject_id,observed_at DESC);
ALTER TABLE orders_return_read_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders_return_read_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON orders_return_read_evidence TO luma_desk
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON orders_return_read_evidence TO luma_desk;

-- Saved test cases stay with their draft. Test runs use example replies only and never
-- reach connected systems; they are evidence for the author, not an activation or approval.
CREATE TABLE workflow_draft_tests (
 tenant_id uuid NOT NULL,
 draft_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision >= 1),
 cases jsonb NOT NULL CHECK(jsonb_typeof(cases)='array' AND octet_length(cases::text) <= 1048576),
 updated_by uuid NOT NULL,
 updated_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,draft_id),
 FOREIGN KEY(tenant_id,draft_id) REFERENCES workflow_drafts(tenant_id,id)
);
ALTER TABLE workflow_draft_tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_draft_tests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON workflow_draft_tests TO luma_desk
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON workflow_draft_tests TO luma_desk;
GRANT UPDATE(revision,cases,updated_by,updated_at) ON workflow_draft_tests TO luma_desk;

-- A run belongs to the person who started it. Runs left running past expires_at are failed on read.
CREATE TABLE workflow_draft_test_runs (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 draft_id uuid NOT NULL,
 draft_revision integer NOT NULL CHECK(draft_revision >= 1),
 case_id uuid,
 principal_id uuid NOT NULL,
 request_digest text NOT NULL,
 state text NOT NULL CHECK(state IN ('running','completed','failed','cancelled')),
 document jsonb NOT NULL CHECK(octet_length(document::text) <= 1048576),
 created_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,draft_id) REFERENCES workflow_drafts(tenant_id,id)
);
CREATE INDEX workflow_draft_test_runs_latest ON workflow_draft_test_runs(tenant_id,draft_id,draft_revision,case_id,created_at DESC);
ALTER TABLE workflow_draft_test_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_draft_test_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON workflow_draft_test_runs TO luma_desk
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON workflow_draft_test_runs TO luma_desk;
GRANT UPDATE(state,document) ON workflow_draft_test_runs TO luma_desk;

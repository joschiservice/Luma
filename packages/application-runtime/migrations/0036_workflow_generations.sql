-- Provenance for natural-language authoring: prompt reference, model route, revisions and token
-- usage. Records never hold prompts or model text. A refine record also holds its proposal until
-- the author accepts or rejects it. A failed describe request created no draft.
CREATE TABLE workflow_generations (
 tenant_id uuid NOT NULL REFERENCES organizations(id),
 id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('describe','refine','code_step')),
 draft_id uuid,
 base_revision integer CHECK(base_revision >= 1),
 resulting_revision integer CHECK(resulting_revision >= 1),
 request_digest text NOT NULL,
 prompt_version text NOT NULL,
 prompt_digest text NOT NULL,
 route jsonb NOT NULL,
 usage jsonb NOT NULL,
 attempts integer NOT NULL CHECK(attempts BETWEEN 0 AND 10),
 outcome text NOT NULL CHECK(outcome IN ('valid','partial','failed')),
 result jsonb CHECK(octet_length(result::text) <= 1048576),
 proposal_state text CHECK(proposal_state IN ('open','accepted','rejected')),
 decided_by uuid,
 decided_at timestamptz,
 accept_save_id uuid,
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,draft_id) REFERENCES workflow_drafts(tenant_id,id),
 CHECK(kind='describe' OR draft_id IS NOT NULL),
 CHECK((outcome='failed') = (result IS NULL)),
 CHECK((kind='refine' AND outcome<>'failed') = (proposal_state IS NOT NULL)),
 CHECK((proposal_state IN ('accepted','rejected')) = (decided_at IS NOT NULL))
);
CREATE INDEX workflow_generations_draft ON workflow_generations(tenant_id,draft_id,created_at DESC) WHERE draft_id IS NOT NULL;
ALTER TABLE workflow_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_generations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON workflow_generations TO luma_desk
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON workflow_generations TO luma_desk;
GRANT UPDATE(resulting_revision,proposal_state,decided_by,decided_at,accept_save_id) ON workflow_generations TO luma_desk;

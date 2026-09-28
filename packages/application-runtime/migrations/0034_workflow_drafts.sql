-- Drafts are mutable authoring records. They never run; publication copies an exact revision
-- into the immutable playbook_versions catalog.
CREATE TABLE workflow_drafts (
 tenant_id uuid NOT NULL REFERENCES organizations(id),
 id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision >= 1),
 state text NOT NULL CHECK(state IN ('draft','published','discarded')),
 mode text NOT NULL CHECK(mode IN ('template','visual','code','language')),
 content jsonb NOT NULL CHECK(octet_length(content::text) <= 262144),
 code_view text CHECK(octet_length(code_view) <= 262144),
 based_on jsonb,
 author_id uuid NOT NULL,
 updated_by uuid NOT NULL,
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 published jsonb,
 create_digest text NOT NULL,
 last_save jsonb,
 PRIMARY KEY(tenant_id,id),
 CHECK((state='published') = (published IS NOT NULL))
);
CREATE INDEX workflow_drafts_recent ON workflow_drafts(tenant_id,updated_at DESC,id) WHERE state='draft';
ALTER TABLE workflow_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON workflow_drafts TO luma_desk
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON workflow_drafts TO luma_desk;
GRANT UPDATE(revision,state,mode,content,code_view,updated_by,updated_at,published,last_save) ON workflow_drafts TO luma_desk;

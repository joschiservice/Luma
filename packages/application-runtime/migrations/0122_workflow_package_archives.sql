CREATE TABLE workflow_package_archives(tenant_id uuid NOT NULL,definition_id text NOT NULL,package_id text NOT NULL,archived_by uuid NOT NULL,archived boolean NOT NULL DEFAULT true,changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,definition_id),FOREIGN KEY(tenant_id,definition_id) REFERENCES playbook_definitions(tenant_id,id));
ALTER TABLE workflow_package_archives ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_package_archives FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON workflow_package_archives TO luma_desk USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON workflow_package_archives TO luma_desk;

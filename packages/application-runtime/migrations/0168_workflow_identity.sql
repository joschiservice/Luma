-- Background workers resolve who a workflow runs as and check workspace members, but must not
-- hold luma_identity, which reads and changes sessions, accounts, credentials and memberships.
-- This read-only role covers the membership, role, organization and account status reads that
-- resolving a workflow context and listing members need. It reads no user names or emails.
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='luma_workflow_identity') THEN CREATE ROLE luma_workflow_identity NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO luma_workflow_identity;
GRANT SELECT(id,tenant_id,user_id,role,status,custom_role_id) ON memberships TO luma_workflow_identity;
GRANT SELECT(tenant_id,id,name,revision) ON workspace_roles TO luma_workflow_identity;
GRANT SELECT(tenant_id,role_id,permission) ON workspace_role_permissions TO luma_workflow_identity;
GRANT SELECT(id,name,slug,data_region,status) ON organizations TO luma_workflow_identity;
GRANT SELECT(user_id) ON account_disablements TO luma_workflow_identity;
GRANT SELECT(user_id,status) ON account_deletions TO luma_workflow_identity;
GRANT EXECUTE ON FUNCTION identity_tenant_region(uuid) TO luma_workflow_identity;

-- The same rows luma_identity reads: the acting user's own memberships, role and workspaces
-- before a tenant is selected, and the selected tenant's members after.
CREATE POLICY workflow_identity_read ON memberships FOR SELECT TO luma_workflow_identity USING (
 user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
 OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);
CREATE POLICY workflow_identity_read ON organizations FOR SELECT TO luma_workflow_identity USING (
 id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
 OR id IN (SELECT tenant_id FROM memberships WHERE user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
);
CREATE POLICY workflow_identity_read ON workspace_roles FOR SELECT TO luma_workflow_identity USING (
 tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
 OR EXISTS (SELECT 1 FROM memberships m WHERE m.tenant_id = workspace_roles.tenant_id AND m.custom_role_id = workspace_roles.id
  AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
);
CREATE POLICY workflow_identity_read ON workspace_role_permissions FOR SELECT TO luma_workflow_identity USING (
 tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
 OR EXISTS (SELECT 1 FROM memberships m WHERE m.tenant_id = workspace_role_permissions.tenant_id AND m.custom_role_id = workspace_role_permissions.role_id
  AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
);

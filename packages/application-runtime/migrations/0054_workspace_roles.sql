-- Custom workspace roles. Built-in roles (owner, admin, member) are defined in code; memberships
-- and invitations point at a built-in key or, with role 'custom', at a role row in the same tenant.
CREATE TABLE workspace_roles (
 tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, id uuid NOT NULL,
 name text NOT NULL CHECK(char_length(btrim(name)) BETWEEN 1 AND 60),
 description text NOT NULL DEFAULT '' CHECK(char_length(description) <= 300),
 revision integer NOT NULL DEFAULT 1 CHECK(revision > 0),
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz,
 PRIMARY KEY(tenant_id,id)
);
CREATE UNIQUE INDEX workspace_roles_active_name ON workspace_roles(tenant_id,lower(btrim(name))) WHERE archived_at IS NULL;
CREATE TABLE workspace_role_permissions (
 tenant_id uuid NOT NULL, role_id uuid NOT NULL,
 permission text NOT NULL CHECK(permission ~ '^([a-z][a-z0-9-]{0,39}:)?[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$' AND char_length(permission) <= 120),
 PRIMARY KEY(tenant_id,role_id,permission),
 FOREIGN KEY(tenant_id,role_id) REFERENCES workspace_roles(tenant_id,id) ON DELETE CASCADE
);

ALTER TABLE memberships DROP CONSTRAINT memberships_role_check;
ALTER TABLE memberships ADD COLUMN custom_role_id uuid;
ALTER TABLE memberships ADD CONSTRAINT memberships_custom_role FOREIGN KEY(tenant_id,custom_role_id) REFERENCES workspace_roles(tenant_id,id);
ALTER TABLE memberships ADD CONSTRAINT memberships_role_reference CHECK((role = 'custom') = (custom_role_id IS NOT NULL));
CREATE INDEX memberships_custom_role_idx ON memberships(tenant_id,custom_role_id) WHERE custom_role_id IS NOT NULL;
GRANT UPDATE(custom_role_id) ON memberships TO luma_identity;

ALTER TABLE workspace_invitations DROP CONSTRAINT workspace_invitations_role_check;
ALTER TABLE workspace_invitations ADD COLUMN custom_role_id uuid;
ALTER TABLE workspace_invitations ADD CONSTRAINT workspace_invitations_custom_role FOREIGN KEY(tenant_id,custom_role_id) REFERENCES workspace_roles(tenant_id,id);
-- Ownership is granted to existing members only, never through an invitation link.
ALTER TABLE workspace_invitations ADD CONSTRAINT workspace_invitations_role_reference CHECK(role <> 'owner' AND (role = 'custom') = (custom_role_id IS NOT NULL));

-- The first owner of a new workspace is the only membership created outside a tenant context.
DROP POLICY membership_insert ON memberships;
CREATE POLICY membership_insert ON memberships FOR INSERT TO luma_identity WITH CHECK (
 tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
 OR (tenant_id = NULLIF(current_setting('app.provision_id', true), '')::uuid
 AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid AND role = 'owner' AND custom_role_id IS NULL)
);

-- Better Auth's organization plugin checks that its `invitations` table exists at startup, so it
-- stays although Luma never exposes it; workspace_invitations carry Luma's invitations.

GRANT SELECT,INSERT ON workspace_roles TO luma_identity;
GRANT UPDATE(name,description,revision,updated_at,archived_at) ON workspace_roles TO luma_identity;
GRANT SELECT,INSERT,DELETE ON workspace_role_permissions TO luma_identity;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['workspace_roles','workspace_role_permissions'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format($policy$CREATE POLICY tenant_scope ON %I TO luma_identity USING (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid)$policy$,name);
 END LOOP;
END $$;
-- Resolving a tenant context reads the caller's own role before a tenant is selected.
CREATE POLICY own_role_read ON workspace_roles FOR SELECT TO luma_identity USING (
 EXISTS (SELECT 1 FROM memberships m WHERE m.tenant_id = workspace_roles.tenant_id AND m.custom_role_id = workspace_roles.id
  AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
);
CREATE POLICY own_role_read ON workspace_role_permissions FOR SELECT TO luma_identity USING (
 EXISTS (SELECT 1 FROM memberships m WHERE m.tenant_id = workspace_role_permissions.tenant_id AND m.custom_role_id = workspace_role_permissions.role_id
  AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
);

-- Role history and Activity read access events per workspace, newest first.
CREATE INDEX workspace_access_events_recent ON workspace_access_events(tenant_id,created_at DESC,id DESC);

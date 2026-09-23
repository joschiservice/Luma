-- Run with a dedicated migration role. Runtime credentials never own tables.
DO $$ BEGIN
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'luma_identity') THEN
  CREATE ROLE luma_identity NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
 END IF;
END $$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO luma_identity;

CREATE TABLE users (
 id uuid PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE,
 email_verified boolean NOT NULL DEFAULT false, image text,
 created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
);
CREATE TABLE sessions (
 id uuid PRIMARY KEY, token text NOT NULL UNIQUE, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
 ip_address text, user_agent text, active_organization_id uuid
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE TABLE accounts (
 id uuid PRIMARY KEY, account_id text NOT NULL, provider_id text NOT NULL,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 access_token text, refresh_token text, id_token text,
 access_token_expires_at timestamptz, refresh_token_expires_at timestamptz,
 scope text, password text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
 UNIQUE(provider_id, account_id)
);
CREATE INDEX accounts_user_idx ON accounts(user_id);
CREATE TABLE verifications (
 id uuid PRIMARY KEY, identifier text NOT NULL, value text NOT NULL,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
);
CREATE INDEX verifications_identifier_idx ON verifications(identifier);
CREATE TABLE organizations (
 id uuid PRIMARY KEY, name text NOT NULL, slug text NOT NULL UNIQUE, logo text, metadata text,
 created_at timestamptz NOT NULL,
 data_region text NOT NULL DEFAULT 'EU' CHECK(data_region IN ('EU', 'US', 'APAC')),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'suspended', 'closed'))
);
CREATE TABLE memberships (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 role text NOT NULL CHECK(role IN ('owner', 'admin', 'member')), created_at timestamptz NOT NULL,
 UNIQUE(tenant_id, id), UNIQUE(tenant_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships(user_id, tenant_id);
CREATE TABLE invitations (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 email text NOT NULL, role text CHECK(role IN ('owner', 'admin', 'member')),
 status text NOT NULL, inviter_id uuid NOT NULL REFERENCES users(id),
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL,
 UNIQUE(tenant_id, id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON users, sessions, accounts, verifications TO luma_identity;
GRANT SELECT, INSERT ON organizations TO luma_identity;
-- Row locks require an UPDATE grant; placement and status stay operator-owned.
GRANT UPDATE(name) ON organizations TO luma_identity;
GRANT SELECT, INSERT, DELETE ON memberships TO luma_identity;
GRANT UPDATE(role) ON memberships TO luma_identity;
GRANT SELECT, INSERT, DELETE ON invitations TO luma_identity;
GRANT UPDATE(status) ON invitations TO luma_identity;

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;

CREATE POLICY membership_read ON memberships FOR SELECT TO luma_identity USING (
 user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
 OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
);
CREATE POLICY organization_read ON organizations FOR SELECT TO luma_identity USING (
 id = NULLIF(current_setting('app.provision_id', true), '')::uuid
 OR id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
 OR id IN (SELECT tenant_id FROM memberships WHERE user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
);
CREATE POLICY organization_provision ON organizations FOR INSERT TO luma_identity WITH CHECK (
 id = NULLIF(current_setting('app.provision_id', true), '')::uuid
 AND NULLIF(current_setting('app.user_id', true), '') IS NOT NULL
 AND data_region = 'EU' AND status = 'active'
);
CREATE POLICY organization_update ON organizations FOR UPDATE TO luma_identity
 USING (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
 WITH CHECK (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY membership_insert ON memberships FOR INSERT TO luma_identity WITH CHECK (
 tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
 OR (tenant_id = NULLIF(current_setting('app.provision_id', true), '')::uuid
 AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid AND role = 'owner')
);
CREATE POLICY membership_update ON memberships FOR UPDATE TO luma_identity
 USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
 WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY membership_delete ON memberships FOR DELETE TO luma_identity
 USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY invitation_tenant ON invitations TO luma_identity
 USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
 WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

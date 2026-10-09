-- Customer sessions record when they were last used. The identity runtime already holds UPDATE
-- on sessions; session resolution writes this at most once per five minutes per session.
ALTER TABLE sessions ADD COLUMN last_active_at timestamptz;

-- Account inspection is a separate staff permission. Keep this list equal to the staff catalog.
ALTER TABLE staff_access DROP CONSTRAINT staff_access_permissions_check;
ALTER TABLE staff_access ADD CONSTRAINT staff_access_permissions_check CHECK(permissions <@ ARRAY['staff.directory.read','staff.workspace.inspect','staff.sessions.revoke','staff.accounts.inspect']::text[]);

-- Account support grants mirror workspace grants: one customer account, the current staff
-- session, a reason and thirty minutes. They grant no workspace access.
CREATE TABLE staff_account_grants (id uuid PRIMARY KEY,staff_user_id uuid NOT NULL REFERENCES staff_users(id),staff_session_id uuid NOT NULL REFERENCES staff_sessions(id) ON DELETE CASCADE,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 500),expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX staff_account_grants_scope ON staff_account_grants(staff_user_id,staff_session_id,user_id,expires_at);
CREATE INDEX staff_account_grants_user ON staff_account_grants(user_id);
GRANT SELECT,INSERT ON staff_account_grants TO luma_staff_runtime;
GRANT SELECT ON staff_account_grants TO luma_staff_views,luma_identity_support;
ALTER TABLE staff_account_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_account_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY staff_account_grants ON staff_account_grants TO luma_staff_runtime USING(staff_user_id=NULLIF(current_setting('staff.user_id',true),'')::uuid AND staff_session_id=NULLIF(current_setting('staff.session_id',true),'')::uuid) WITH CHECK(staff_user_id=NULLIF(current_setting('staff.user_id',true),'')::uuid AND staff_session_id=NULLIF(current_setting('staff.session_id',true),'')::uuid AND public.staff_has_access('staff.accounts.inspect') AND expires_at<=now()+interval '30 minutes');
CREATE POLICY staff_account_grants_read ON staff_account_grants FOR SELECT TO luma_staff_views,luma_identity_support USING(staff_user_id=NULLIF(current_setting('staff.user_id',true),'')::uuid AND staff_session_id=NULLIF(current_setting('staff.session_id',true),'')::uuid);

CREATE FUNCTION staff_has_account_access(target uuid) RETURNS boolean LANGUAGE sql VOLATILE SET search_path=pg_catalog,public AS $$
 SELECT public.staff_has_access('staff.accounts.inspect') AND EXISTS (SELECT FROM public.staff_account_grants g WHERE g.id=NULLIF(current_setting('staff.grant_id',true),'')::uuid AND g.staff_user_id=NULLIF(current_setting('staff.user_id',true),'')::uuid AND g.staff_session_id=NULLIF(current_setting('staff.session_id',true),'')::uuid AND g.user_id=target AND g.expires_at>clock_timestamp())
$$;
REVOKE ALL ON FUNCTION staff_has_account_access(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION staff_has_account_access(uuid) TO luma_staff_runtime,luma_staff_views,luma_identity_support;

-- The view owner reads only the columns the account page shows, and only under an account grant.
-- Credentials, session tokens, factor secrets and passkey credential IDs stay unreadable.
GRANT SELECT(id,name,email,created_at,two_factor_enabled) ON users TO luma_staff_views;
GRANT SELECT(user_id) ON passkeys TO luma_staff_views;
GRANT SELECT(id,user_id,created_at,expires_at,last_active_at,ip_address,user_agent) ON sessions TO luma_staff_views;
GRANT SELECT(tenant_id,user_id,role,custom_role_id,created_at) ON memberships TO luma_staff_views;
GRANT SELECT(id,name,slug,status,data_region) ON organizations TO luma_staff_views;
GRANT SELECT(tenant_id,id,name) ON workspace_roles TO luma_staff_views;
CREATE POLICY staff_account_membership_read ON memberships FOR SELECT TO luma_staff_views USING(public.staff_has_account_access(user_id));
CREATE POLICY staff_account_workspace_read ON organizations FOR SELECT TO luma_staff_views USING(EXISTS(SELECT FROM public.memberships m WHERE m.tenant_id=organizations.id AND public.staff_has_account_access(m.user_id)));
CREATE POLICY staff_account_role_read ON workspace_roles FOR SELECT TO luma_staff_views USING(EXISTS(SELECT FROM public.memberships m WHERE m.tenant_id=workspace_roles.tenant_id AND m.custom_role_id=workspace_roles.id AND public.staff_has_account_access(m.user_id)));

CREATE VIEW staff_account_profile WITH (security_barrier=true) AS
SELECT u.id,u.name,u.email,u.created_at,u.two_factor_enabled,(SELECT count(*) FROM passkeys p WHERE p.user_id=u.id)::integer AS passkey_count
FROM users u WHERE public.staff_has_account_access(u.id);
CREATE VIEW staff_account_workspaces WITH (security_barrier=true) AS
SELECT m.user_id,o.id,o.name,o.slug,o.status,o.data_region,m.role,r.name AS custom_role_name,m.created_at AS joined_at
FROM memberships m JOIN organizations o ON o.id=m.tenant_id LEFT JOIN workspace_roles r ON r.tenant_id=m.tenant_id AND r.id=m.custom_role_id
WHERE public.staff_has_account_access(m.user_id);
CREATE VIEW staff_account_sessions WITH (security_barrier=true) AS
SELECT s.user_id,s.id,s.created_at,s.expires_at,s.last_active_at,s.ip_address,s.user_agent
FROM sessions s WHERE s.expires_at>clock_timestamp() AND public.staff_has_account_access(s.user_id);
ALTER VIEW staff_account_profile OWNER TO luma_staff_views;
ALTER VIEW staff_account_workspaces OWNER TO luma_staff_views;
ALTER VIEW staff_account_sessions OWNER TO luma_staff_views;
GRANT SELECT ON staff_account_profile,staff_account_workspaces,staff_account_sessions TO luma_staff_runtime;

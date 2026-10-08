-- Staff identities and privileges are independent of customer workspace roles.
DO $$ BEGIN
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='luma_staff_runtime') THEN CREATE ROLE luma_staff_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF;
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='luma_staff_directory') THEN CREATE ROLE luma_staff_directory NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF;
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='luma_staff_views') THEN CREATE ROLE luma_staff_views NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF;
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='luma_identity_support') THEN CREATE ROLE luma_identity_support NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO luma_staff_runtime,luma_staff_views,luma_identity_support,luma_staff_directory;
CREATE TABLE staff_users (id uuid PRIMARY KEY,name text NOT NULL,email text NOT NULL UNIQUE,email_verified boolean NOT NULL DEFAULT false,image text,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL);
CREATE TABLE staff_sessions (id uuid PRIMARY KEY,token text NOT NULL UNIQUE,user_id uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,ip_address text,user_agent text);
CREATE INDEX staff_sessions_user ON staff_sessions(user_id);
CREATE TABLE staff_accounts (id uuid PRIMARY KEY,account_id text NOT NULL,provider_id text NOT NULL,user_id uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,access_token text,refresh_token text,id_token text,access_token_expires_at timestamptz,refresh_token_expires_at timestamptz,scope text,password text,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,UNIQUE(provider_id,account_id));
CREATE TABLE staff_verifications (id uuid PRIMARY KEY,identifier text NOT NULL,value text NOT NULL,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL);
CREATE INDEX staff_verifications_identifier ON staff_verifications(identifier);
CREATE TABLE staff_access (email text PRIMARY KEY CHECK(email=lower(email)),provider_subject text UNIQUE,active boolean NOT NULL DEFAULT true,permissions text[] NOT NULL CHECK(permissions <@ ARRAY['staff.directory.read','staff.workspace.inspect','staff.sessions.revoke']::text[]),created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE staff_support_grants (id uuid PRIMARY KEY,staff_user_id uuid NOT NULL REFERENCES staff_users(id),staff_session_id uuid NOT NULL REFERENCES staff_sessions(id) ON DELETE CASCADE,tenant_id uuid NOT NULL REFERENCES organizations(id),reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 500),expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX staff_support_grants_scope ON staff_support_grants(staff_user_id,staff_session_id,tenant_id,expires_at);
CREATE TABLE staff_audit (sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,staff_user_id uuid REFERENCES staff_users(id),staff_session_id uuid,tenant_id uuid,event text NOT NULL,request_id text NOT NULL,reason text,details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE identity_support_commands (command_id uuid PRIMARY KEY,staff_user_id uuid NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,reason text NOT NULL,revoked_sessions integer NOT NULL,completed_at timestamptz NOT NULL DEFAULT now());
GRANT SELECT,INSERT,UPDATE,DELETE ON staff_users,staff_sessions,staff_accounts,staff_verifications TO luma_staff_runtime;
GRANT SELECT ON staff_access TO luma_staff_runtime,luma_staff_views,luma_identity_support,luma_staff_directory;
GRANT SELECT,INSERT ON staff_support_grants TO luma_staff_runtime;
GRANT SELECT ON staff_users,staff_sessions,staff_accounts,staff_support_grants TO luma_staff_views,luma_identity_support,luma_staff_directory;
GRANT INSERT ON staff_audit TO luma_staff_runtime,luma_identity_support;
GRANT USAGE ON SEQUENCE staff_audit_sequence_seq TO luma_staff_runtime,luma_identity_support;
GRANT SELECT,INSERT ON identity_support_commands TO luma_identity_support;
GRANT SELECT(id,user_id),DELETE ON sessions TO luma_identity_support;
-- The auth package owns the only customer mutation exposed to staff.
CREATE FUNCTION staff_has_access(permission text) RETURNS boolean LANGUAGE sql VOLATILE SET search_path=pg_catalog,public AS $$
 SELECT EXISTS (SELECT FROM public.staff_sessions s JOIN public.staff_users u ON u.id=s.user_id JOIN public.staff_access a ON a.email=lower(u.email)
 WHERE s.id=NULLIF(current_setting('staff.session_id',true),'')::uuid AND s.user_id=NULLIF(current_setting('staff.user_id',true),'')::uuid AND s.expires_at>clock_timestamp() AND s.created_at>clock_timestamp()-interval '8 hours' AND s.updated_at>clock_timestamp()-interval '30 minutes' AND a.active AND (a.provider_subject IS NULL OR EXISTS(SELECT FROM public.staff_accounts p WHERE p.user_id=u.id AND p.provider_id='google' AND p.account_id=a.provider_subject)) AND permission=ANY(a.permissions))
$$;
REVOKE ALL ON FUNCTION staff_has_access(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION staff_has_access(text) TO luma_staff_runtime,luma_staff_views,luma_identity_support,luma_staff_directory;
CREATE FUNCTION staff_has_workspace_access(target uuid) RETURNS boolean LANGUAGE sql VOLATILE SET search_path=pg_catalog,public AS $$
 SELECT public.staff_has_access('staff.workspace.inspect') AND EXISTS (SELECT FROM public.staff_support_grants g WHERE g.id=NULLIF(current_setting('staff.grant_id',true),'')::uuid AND g.staff_user_id=NULLIF(current_setting('staff.user_id',true),'')::uuid AND g.staff_session_id=NULLIF(current_setting('staff.session_id',true),'')::uuid AND g.tenant_id=target AND g.expires_at>clock_timestamp())
$$;
REVOKE ALL ON FUNCTION staff_has_workspace_access(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION staff_has_workspace_access(uuid) TO luma_staff_runtime,luma_staff_views,luma_identity_support,luma_staff_directory;
GRANT SELECT(id,name,email) ON users TO luma_staff_runtime;
GRANT SELECT(id,name,slug,status,data_region) ON organizations TO luma_staff_runtime;
CREATE POLICY staff_directory_read ON organizations FOR SELECT TO luma_staff_runtime USING(public.staff_has_access('staff.directory.read'));
GRANT SELECT(id,tenant_id,user_id,role) ON memberships TO luma_staff_runtime,luma_identity_support;
CREATE POLICY staff_member_read ON memberships FOR SELECT TO luma_staff_runtime,luma_identity_support USING(public.staff_has_workspace_access(tenant_id));
GRANT SELECT(tenant_id,id,document) ON connector_installations TO luma_staff_views;
CREATE POLICY staff_connection_read ON connector_installations FOR SELECT TO luma_staff_views USING(public.staff_has_workspace_access(tenant_id));
GRANT SELECT(tenant_id,connection_id,last_success_at) ON commerce_sync_streams TO luma_staff_views;
CREATE POLICY staff_sync_read ON commerce_sync_streams FOR SELECT TO luma_staff_views USING(public.staff_has_workspace_access(tenant_id));
CREATE VIEW staff_connection_summary WITH (security_barrier=true) AS SELECT c.tenant_id,c.id,COALESCE(c.document->>'providerId',c.document->>'appId','unknown') AS provider,c.document->>'status' AS status,(SELECT max(s.last_success_at) FROM commerce_sync_streams s WHERE s.tenant_id=c.tenant_id AND s.connection_id=c.id) AS last_sync_at FROM connector_installations c;
ALTER VIEW staff_connection_summary OWNER TO luma_staff_views;
GRANT SELECT ON staff_connection_summary TO luma_staff_runtime;
ALTER TABLE staff_support_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_support_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY staff_grants ON staff_support_grants TO luma_staff_runtime USING(staff_user_id=NULLIF(current_setting('staff.user_id',true),'')::uuid AND staff_session_id=NULLIF(current_setting('staff.session_id',true),'')::uuid) WITH CHECK(staff_user_id=NULLIF(current_setting('staff.user_id',true),'')::uuid AND staff_session_id=NULLIF(current_setting('staff.session_id',true),'')::uuid AND public.staff_has_access('staff.workspace.inspect') AND expires_at<=now()+interval '30 minutes');
CREATE POLICY staff_grants_read ON staff_support_grants FOR SELECT TO luma_staff_views,luma_identity_support USING(staff_user_id=NULLIF(current_setting('staff.user_id',true),'')::uuid AND staff_session_id=NULLIF(current_setting('staff.session_id',true),'')::uuid);
GRANT UPDATE(active) ON staff_access TO luma_identity_support;
GRANT UPDATE(updated_at) ON staff_sessions TO luma_identity_support;
GRANT UPDATE(reason) ON staff_support_grants TO luma_identity_support;
GRANT SELECT(id,data_region),UPDATE(name) ON organizations TO luma_identity_support;
CREATE POLICY staff_support_organization ON organizations FOR ALL TO luma_identity_support USING(public.staff_has_workspace_access(id)) WITH CHECK(false);
CREATE POLICY staff_inspection_workspace ON organizations FOR SELECT TO luma_staff_runtime USING(public.staff_has_workspace_access(id));
CREATE FUNCTION identity_support_revoke_sessions(command uuid,target_tenant uuid,target_user uuid,reason_text text,request_text text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=NULLIF(current_setting('staff.user_id',true),'')::uuid; receipt public.identity_support_commands%ROWTYPE; amount integer;
BEGIN
 PERFORM 1 FROM public.staff_access a JOIN public.staff_users u ON lower(u.email)=a.email WHERE u.id=actor FOR SHARE OF a;
 PERFORM 1 FROM public.staff_sessions WHERE id=NULLIF(current_setting('staff.session_id',true),'')::uuid AND user_id=actor FOR SHARE;
 PERFORM 1 FROM public.staff_support_grants WHERE id=NULLIF(current_setting('staff.grant_id',true),'')::uuid AND staff_user_id=actor FOR SHARE;
 PERFORM 1 FROM public.organizations WHERE id=target_tenant FOR UPDATE;
 PERFORM pg_advisory_xact_lock(hashtextextended(command::text,0));
 IF NOT public.staff_has_access('staff.sessions.revoke') OR NOT public.staff_has_workspace_access(target_tenant) OR NOT EXISTS(SELECT FROM public.staff_sessions WHERE id=NULLIF(current_setting('staff.session_id',true),'')::uuid AND created_at>clock_timestamp()-interval '15 minutes') THEN RAISE EXCEPTION 'staff access denied' USING ERRCODE='42501'; END IF;
 IF reason_text IS NULL OR length(trim(reason_text)) NOT BETWEEN 10 AND 500 THEN RAISE EXCEPTION 'invalid reason' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT FROM public.organizations WHERE id=target_tenant AND data_region='EU') THEN RAISE EXCEPTION 'region unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO receipt FROM public.identity_support_commands WHERE command_id=command;
 IF FOUND THEN
  IF receipt.staff_user_id<>actor OR receipt.tenant_id<>target_tenant OR receipt.user_id<>target_user OR receipt.reason<>reason_text THEN RAISE EXCEPTION 'command conflict' USING ERRCODE='23505'; END IF;
 ELSE
  IF NOT EXISTS(SELECT FROM public.memberships WHERE tenant_id=target_tenant AND user_id=target_user) THEN RAISE EXCEPTION 'member unavailable' USING ERRCODE='P0002'; END IF;
  DELETE FROM public.sessions WHERE user_id=target_user; GET DIAGNOSTICS amount=ROW_COUNT;
  INSERT INTO public.identity_support_commands(command_id,staff_user_id,tenant_id,user_id,reason,revoked_sessions) VALUES(command,actor,target_tenant,target_user,reason_text,amount) RETURNING * INTO receipt;
  INSERT INTO public.staff_audit(staff_user_id,staff_session_id,tenant_id,event,request_id,reason,details) VALUES(actor,NULLIF(current_setting('staff.session_id',true),'')::uuid,target_tenant,'customer.sessions.revoked',request_text,reason_text,jsonb_build_object('commandId',command,'userId',target_user,'revokedSessions',amount,'scope','global-account'));
 END IF;
 RETURN jsonb_build_object('commandId',receipt.command_id,'revokedSessions',receipt.revoked_sessions,'completedAt',receipt.completed_at);
END $$;
ALTER FUNCTION identity_support_revoke_sessions(uuid,uuid,uuid,text,text) OWNER TO luma_identity_support;
REVOKE ALL ON FUNCTION identity_support_revoke_sessions(uuid,uuid,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity_support_revoke_sessions(uuid,uuid,uuid,text,text) TO luma_staff_runtime;

-- Directory matching exposes only workspace metadata, including workspaces of matching users.
GRANT SELECT(id,name,email) ON users TO luma_staff_directory;
GRANT SELECT(id,name,slug,status,data_region) ON organizations TO luma_staff_directory;
GRANT SELECT(tenant_id,user_id) ON memberships TO luma_staff_directory;
CREATE POLICY staff_directory_workspace ON organizations FOR SELECT TO luma_staff_directory USING(public.staff_has_access('staff.directory.read'));
CREATE POLICY staff_directory_membership ON memberships FOR SELECT TO luma_staff_directory USING(public.staff_has_access('staff.directory.read'));
CREATE FUNCTION staff_search_workspaces(pattern text) RETURNS TABLE(id uuid,name text,slug text,status text,data_region text) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ SELECT o.id,o.name,o.slug,o.status,o.data_region FROM public.organizations o WHERE public.staff_has_access('staff.directory.read') AND (o.name ILIKE pattern OR o.slug ILIKE pattern OR EXISTS(SELECT FROM public.memberships m JOIN public.users u ON u.id=m.user_id WHERE m.tenant_id=o.id AND (u.name ILIKE pattern OR u.email ILIKE pattern))) ORDER BY o.name LIMIT 26 $$;
ALTER FUNCTION staff_search_workspaces(text) OWNER TO luma_staff_directory;
REVOKE ALL ON FUNCTION staff_search_workspaces(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION staff_search_workspaces(text) TO luma_staff_runtime;

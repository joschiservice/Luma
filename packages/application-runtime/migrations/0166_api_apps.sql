-- Personal API apps (ADR-017): a member creates an app that acts for them through a bearer
-- token, limited to the permissions they chose. Only SHA-256 hashes of tokens are stored.
-- Identity manages apps under tenant RLS. Bearer requests arrive before any tenant is known, so
-- the customer API resolves tokens only through the functions below, owned by
-- luma_api_credentials; that role has no login.
DO $$ BEGIN
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='luma_api_credentials') THEN CREATE ROLE luma_api_credentials NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO luma_api_credentials;

-- An app belongs to one membership: removing the member or erasing the account deletes the app
-- and its credentials, so a later invitation never revives them.
CREATE TABLE api_apps (
 tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 id uuid NOT NULL,
 user_id uuid NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80 AND name=btrim(name)),
 scopes text[] NOT NULL CHECK(cardinality(scopes) BETWEEN 1 AND 50),
 created_at timestamptz NOT NULL DEFAULT now(),
 revoked_at timestamptz,
 revoked_by uuid,
 revoke_reason text CHECK(revoke_reason IN ('revoked','account_disabled')),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,user_id) REFERENCES memberships(tenant_id,user_id) ON DELETE CASCADE,
 CHECK((revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE INDEX api_apps_member ON api_apps(tenant_id,user_id,created_at DESC);
CREATE INDEX api_apps_user ON api_apps(user_id) WHERE revoked_at IS NULL;

-- Rotation adds a credential and revokes the earlier ones; every credential expires within a
-- year of its creation.
CREATE TABLE api_app_credentials (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 app_id uuid NOT NULL,
 token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[0-9a-f]{64}$'),
 last_four text NOT NULL CHECK(last_four ~ '^[0-9a-f]{4}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 last_used_at timestamptz,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,app_id) REFERENCES api_apps(tenant_id,id) ON DELETE CASCADE,
 CHECK(expires_at > created_at AND expires_at <= created_at + interval '366 days')
);
CREATE INDEX api_app_credentials_app ON api_app_credentials(tenant_id,app_id,created_at DESC);
-- Finds credentials due an expiry notice across workspaces.
CREATE INDEX api_app_credentials_expiring ON api_app_credentials(expires_at) WHERE revoked_at IS NULL;

GRANT SELECT,INSERT ON api_apps TO luma_identity;
GRANT UPDATE(revoked_at,revoked_by,revoke_reason) ON api_apps TO luma_identity;
-- Identity never reads token hashes back.
GRANT SELECT(tenant_id,id,app_id,last_four,created_at,expires_at,revoked_at,last_used_at),INSERT ON api_app_credentials TO luma_identity;
GRANT UPDATE(revoked_at) ON api_app_credentials TO luma_identity;
GRANT SELECT ON api_apps,api_app_credentials TO luma_api_credentials;
GRANT UPDATE(revoked_at,revoke_reason) ON api_apps TO luma_api_credentials;
GRANT UPDATE(last_used_at) ON api_app_credentials TO luma_api_credentials;
GRANT SELECT(tenant_id,user_id,status) ON memberships TO luma_api_credentials;

ALTER TABLE api_apps ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_apps FORCE ROW LEVEL SECURITY;
ALTER TABLE api_app_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_app_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON api_apps TO luma_identity USING (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_scope ON api_app_credentials TO luma_identity USING (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid);
-- luma_api_credentials has no login; only the functions below act as it.
CREATE POLICY api_credentials_owner ON api_apps TO luma_api_credentials USING (true) WITH CHECK (true);
CREATE POLICY api_credentials_owner ON api_app_credentials TO luma_api_credentials USING (true) WITH CHECK (true);
-- Expiry notices go only to members whose access is active.
CREATE POLICY api_credentials_memberships ON memberships FOR SELECT TO luma_api_credentials USING (true);

-- Hourly counts of the requests and records through which an app that can read customer data
-- read routes that return it. Counts outlive the app, so admins can still see what a revoked or
-- removed app read; they never hold the records themselves.
CREATE TABLE api_app_personal_reads (
 tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 credential_id uuid NOT NULL,
 app_id uuid NOT NULL,
 route text NOT NULL CHECK(length(route) BETWEEN 1 AND 200),
 hour timestamptz NOT NULL CHECK(hour=date_trunc('hour',hour)),
 requests integer NOT NULL CHECK(requests>0),
 records bigint NOT NULL CHECK(records>=0),
 PRIMARY KEY(tenant_id,credential_id,route,hour)
);
CREATE INDEX api_app_personal_reads_app ON api_app_personal_reads(tenant_id,app_id,hour DESC);

GRANT SELECT,INSERT ON api_app_personal_reads TO luma_identity;
GRANT UPDATE(requests,records) ON api_app_personal_reads TO luma_identity;
ALTER TABLE api_app_personal_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_app_personal_reads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON api_app_personal_reads TO luma_identity USING (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid);

INSERT INTO data_retention_classes(table_name,class) VALUES('api_apps','keep_with_organization'),('api_app_credentials','keep_with_organization'),('api_app_personal_reads','keep_with_organization');

-- The person an app acts for is told before its token expires and when someone else revokes it.
ALTER TABLE workspace_mail DROP CONSTRAINT workspace_mail_kind_check;
ALTER TABLE workspace_mail ADD CONSTRAINT workspace_mail_kind_check
 CHECK (kind IN ('invitation','issues','connections','test','support_view_started','support_view_ended','support_access_requested','morning_brief','support_inspection_requested','support_inspection_emergency','api_app_expiring','api_app_revoked'));
-- ON CONFLICT reads the conflict columns.
GRANT INSERT,SELECT(tenant_id,event_key) ON workspace_mail TO luma_api_credentials;
CREATE POLICY api_credentials_mail ON workspace_mail FOR INSERT TO luma_api_credentials WITH CHECK (kind='api_app_expiring');
-- With ON CONFLICT, a new row must also pass a SELECT policy.
CREATE POLICY api_credentials_mail_read ON workspace_mail FOR SELECT TO luma_api_credentials USING (kind='api_app_expiring');

-- The credential as the API sees it. `status` is revoked when the app or the credential was
-- revoked, expired once `expires_at` passed, and active otherwise.
CREATE FUNCTION api_credential_json(c public.api_app_credentials) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('id',c.id,'tenantId',c.tenant_id,'appId',c.app_id,'userId',a.user_id,'scopes',to_jsonb(a.scopes),
  'status',CASE WHEN a.revoked_at IS NOT NULL OR c.revoked_at IS NOT NULL THEN 'revoked' WHEN c.expires_at<=clock_timestamp() THEN 'expired' ELSE 'active' END)
 FROM public.api_apps a WHERE a.tenant_id=c.tenant_id AND a.id=c.app_id
$$;

-- Finds the credential with this token hash, or NULL. Records use at most once a minute, so
-- ordinary requests don't write.
CREATE FUNCTION api_credential_resolve(hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.api_app_credentials%ROWTYPE;
BEGIN
 IF hash IS NULL OR hash !~ '^[0-9a-f]{64}$' THEN RETURN NULL; END IF;
 SELECT * INTO c FROM public.api_app_credentials WHERE token_hash=hash;
 IF NOT FOUND THEN RETURN NULL; END IF;
 UPDATE public.api_app_credentials SET last_used_at=clock_timestamp()
  WHERE tenant_id=c.tenant_id AND id=c.id AND revoked_at IS NULL AND expires_at>clock_timestamp()
   AND (last_used_at IS NULL OR last_used_at<=clock_timestamp()-interval '1 minute');
 RETURN public.api_credential_json(c);
END $$;

-- Rereads a credential by ID when a context is refreshed.
CREATE FUNCTION api_credential_find(target_tenant uuid,credential uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT public.api_credential_json(c) FROM public.api_app_credentials c WHERE c.tenant_id=target_tenant AND c.id=credential
$$;

-- Disabling an account revokes its apps in every workspace, as it ends its sessions; enabling
-- the account again doesn't restore them.
CREATE FUNCTION api_apps_revoke_disabled() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 UPDATE public.api_apps SET revoked_at=now(),revoke_reason='account_disabled' WHERE user_id=NEW.user_id AND revoked_at IS NULL;
 RETURN NULL;
END $$;
CREATE TRIGGER api_apps_revoke_disabled AFTER INSERT ON account_disablements FOR EACH ROW EXECUTE FUNCTION api_apps_revoke_disabled();

-- Queues one notice per credential that expires within `days` days, for apps of active members
-- that aren't revoked. Credentials issued for at most `days` days get none: their owner chose a
-- short lifetime. Returns how many notices were queued.
CREATE FUNCTION api_apps_queue_expiry_notices(days integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE queued integer;
BEGIN
 IF days IS NULL OR days NOT BETWEEN 1 AND 30 THEN RAISE EXCEPTION 'invalid notice window' USING ERRCODE='22023'; END IF;
 INSERT INTO public.workspace_mail(tenant_id,id,event_key,kind,user_id,target_id)
 SELECT c.tenant_id,gen_random_uuid(),'api-app-expiring:'||c.id::text,'api_app_expiring',a.user_id,c.id
 FROM public.api_app_credentials c
 JOIN public.api_apps a ON a.tenant_id=c.tenant_id AND a.id=c.app_id AND a.revoked_at IS NULL
 JOIN public.memberships m ON m.tenant_id=a.tenant_id AND m.user_id=a.user_id AND m.status='active'
 WHERE c.revoked_at IS NULL AND c.expires_at>now() AND c.expires_at<=now()+make_interval(days=>days)
  AND c.expires_at-c.created_at>make_interval(days=>days)
 ON CONFLICT(tenant_id,event_key) DO NOTHING;
 GET DIAGNOSTICS queued=ROW_COUNT;
 RETURN queued;
END $$;

DO $$ DECLARE fn text; BEGIN
 FOREACH fn IN ARRAY ARRAY['api_credential_json(api_app_credentials)','api_credential_resolve(text)','api_credential_find(uuid,uuid)','api_apps_revoke_disabled()','api_apps_queue_expiry_notices(integer)'] LOOP
  EXECUTE format('ALTER FUNCTION %s OWNER TO luma_api_credentials',fn);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION api_credential_resolve(text),api_credential_find(uuid,uuid),api_apps_queue_expiry_notices(integer) TO luma_identity;

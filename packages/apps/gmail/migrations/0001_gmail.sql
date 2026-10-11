-- Pending Google authorizations. Only a digest of the state is stored; the PKCE verifier is
-- derived from the state on callback, so no reusable secret is kept here.
CREATE TABLE gmail_oauth_states (
 tenant_id uuid NOT NULL, digest text NOT NULL, actor_id text NOT NULL, session_id text NOT NULL,
 app text NOT NULL, label text NOT NULL, login_hint text, expires_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,digest)
);
-- One mailbox belongs to one workspace per Google OAuth app, so push notifications, which name
-- only the mailbox, resolve to exactly one connection.
CREATE TABLE gmail_mailbox_bindings (
 tenant_id uuid NOT NULL, app text NOT NULL, email_address text NOT NULL, connection_id uuid NOT NULL,
 PRIMARY KEY(app,email_address), UNIQUE(tenant_id,connection_id,app),
 CHECK(email_address = lower(email_address))
);
-- Gmail push registrations; renewed during reads before they expire.
CREATE TABLE gmail_watches (
 tenant_id uuid NOT NULL, connection_id uuid NOT NULL, topic text NOT NULL,
 history_id text NOT NULL CHECK(history_id ~ '^[0-9]{1,20}$'), expires_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,connection_id)
);
GRANT SELECT,INSERT,DELETE ON gmail_oauth_states TO luma_connectors;
GRANT SELECT,INSERT,DELETE ON gmail_mailbox_bindings TO luma_connectors;
GRANT SELECT,INSERT,UPDATE,DELETE ON gmail_watches TO luma_connectors;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['gmail_oauth_states','gmail_mailbox_bindings','gmail_watches'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format($policy$CREATE POLICY tenant_scope ON %I TO luma_connectors USING (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid)$policy$,name);
 END LOOP;
END $$;

-- A verified Gmail push names a mailbox, not a workspace. Resolves the bound connection and asks
-- the inbox to read it soon. Returns false for unknown mailboxes, which callers acknowledge.
CREATE FUNCTION gmail_push_hint(app_key text, email text, history_id text) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE binding record;
BEGIN
 SELECT b.tenant_id,b.connection_id INTO binding FROM public.gmail_mailbox_bindings b
  WHERE b.app=app_key AND b.email_address=lower(email);
 IF NOT FOUND THEN RETURN false; END IF;
 IF gmail_push_hint.history_id ~ '^[0-9]{1,20}$' THEN
  UPDATE public.gmail_watches w SET history_id=gmail_push_hint.history_id,updated_at=now()
   WHERE w.tenant_id=binding.tenant_id AND w.connection_id=binding.connection_id
   AND w.history_id::numeric < gmail_push_hint.history_id::numeric;
 END IF;
 PERFORM public.messaging_request_read(binding.tenant_id,binding.connection_id);
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION gmail_push_hint(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gmail_push_hint(text,text,text) TO luma_connectors;

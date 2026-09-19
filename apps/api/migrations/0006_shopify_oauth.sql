CREATE TABLE shopify_oauth_states (
 tenant_id uuid NOT NULL, digest text NOT NULL, actor_id text NOT NULL, session_id text NOT NULL,
 app text NOT NULL, shop text NOT NULL, label text NOT NULL, expires_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,digest)
);
-- One Shopify app installation has one credential pair, even across Luma workspaces.
CREATE TABLE shopify_installation_bindings (
 tenant_id uuid NOT NULL, app text NOT NULL, shop text NOT NULL, connection_id uuid NOT NULL,
 PRIMARY KEY(app,shop), UNIQUE(tenant_id,connection_id,app)
);
GRANT SELECT,INSERT,DELETE ON shopify_oauth_states TO luma_connectors;
GRANT SELECT,INSERT ON shopify_installation_bindings TO luma_connectors;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['shopify_oauth_states','shopify_installation_bindings'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format($policy$CREATE POLICY tenant_scope ON %I TO luma_connectors USING (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid)$policy$,name);
 END LOOP;
END $$;

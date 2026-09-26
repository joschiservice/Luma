CREATE TABLE workspace_apps (
 tenant_id uuid NOT NULL, app_id text NOT NULL,
 status text NOT NULL CHECK(status IN ('installed','uninstalled')),
 version integer NOT NULL CHECK(version > 0), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,app_id)
);
CREATE TABLE workspace_app_events (
 tenant_id uuid NOT NULL, app_id text NOT NULL, version integer NOT NULL,
 status text NOT NULL, actor_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,app_id,version), FOREIGN KEY(tenant_id,app_id) REFERENCES workspace_apps(tenant_id,app_id)
);
-- Preserve ownership and installation state for connections created before apps existed.
UPDATE connector_installations SET document=document || jsonb_build_object('appInstallationVersion',1,'appId',CASE WHEN document->'target'->>'kind' IN ('jtl-cloud','jtl-onprem') THEN 'jtl' ELSE document->'target'->>'kind' END,'provider',CASE WHEN document->'target'->>'kind' IN ('jtl-cloud','jtl-onprem') THEN 'jtl' ELSE document->'target'->>'kind' END);
INSERT INTO workspace_apps(tenant_id,app_id,status,version) SELECT DISTINCT tenant_id,document->>'appId','installed',1 FROM connector_installations;
INSERT INTO workspace_app_events(tenant_id,app_id,version,status,actor_id) SELECT tenant_id,app_id,version,status,'migration' FROM workspace_apps;
GRANT SELECT,INSERT,UPDATE ON workspace_apps TO luma_connectors;
GRANT SELECT,INSERT ON workspace_app_events TO luma_connectors;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['workspace_apps','workspace_app_events'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format($policy$CREATE POLICY tenant_scope ON %I TO luma_connectors USING (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid)$policy$,name);
 END LOOP;
END $$;
-- Serialize new credentials and health updates with uninstall, including OAuth callbacks.
CREATE FUNCTION require_workspace_app() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.document->>'appId' IS NOT NULL AND NEW.document->>'status' NOT IN ('disconnected','revoked') THEN
  PERFORM 1 FROM workspace_apps WHERE tenant_id=NEW.tenant_id AND app_id=NEW.document->>'appId' AND status='installed' AND version=(NEW.document->>'appInstallationVersion')::integer FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'App is not installed' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER require_workspace_app BEFORE INSERT OR UPDATE ON connector_installations FOR EACH ROW EXECUTE FUNCTION require_workspace_app();

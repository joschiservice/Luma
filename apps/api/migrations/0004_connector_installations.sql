DO $$ BEGIN
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'luma_connectors') THEN
  CREATE ROLE luma_connectors NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
 END IF;
END $$;
GRANT USAGE ON SCHEMA public TO luma_connectors;
CREATE TABLE connector_installations (
 tenant_id uuid NOT NULL, id uuid NOT NULL, version integer NOT NULL CHECK(version > 0),
 document jsonb NOT NULL, secret text, PRIMARY KEY(tenant_id,id),
 CHECK(COALESCE(document->>'tenantId'=tenant_id::text AND document->>'id'=id::text AND (document->>'version')::integer=version,false)),
 CHECK(COALESCE(document->>'status' IN ('pending','active','degraded','disconnected','revoked'),false)),
 CHECK((document->>'status' IN ('disconnected','revoked')) = (secret IS NULL))
);
CREATE TABLE connector_lifecycle_events (
 tenant_id uuid NOT NULL, connection_id uuid NOT NULL, version integer NOT NULL,
 event text NOT NULL, actor_id text NOT NULL, status text NOT NULL, credential_version integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,connection_id,version),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES connector_installations(tenant_id,id)
);
GRANT SELECT,INSERT ON connector_installations,connector_lifecycle_events TO luma_connectors;
GRANT UPDATE(version,document,secret) ON connector_installations TO luma_connectors;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['connector_installations','connector_lifecycle_events'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format($policy$CREATE POLICY tenant_scope ON %I TO luma_connectors USING (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid)$policy$,name);
 END LOOP;
END $$;

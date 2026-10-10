-- Authority is workspace configuration; source observations and snapshots remain immutable.
CREATE TABLE connector_authority_settings (
 tenant_id uuid PRIMARY KEY,
 revision integer NOT NULL CHECK(revision > 0),
 overrides jsonb NOT NULL CHECK(jsonb_typeof(overrides)='object')
);
CREATE TABLE connector_authority_events (
 tenant_id uuid NOT NULL,
 command_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision > 0),
 document jsonb NOT NULL,
 PRIMARY KEY(tenant_id,command_id),
 UNIQUE(tenant_id,revision),
 CHECK(document->>'commandId'=command_id::text AND (document->>'revision')::integer=revision)
);
GRANT SELECT,INSERT,UPDATE ON connector_authority_settings TO luma_connectors;
GRANT SELECT,INSERT ON connector_authority_events TO luma_connectors;
GRANT SELECT ON connector_authority_settings,connector_authority_events TO luma_case_reader;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['connector_authority_settings','connector_authority_events'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format($policy$CREATE POLICY tenant_scope ON %I TO luma_connectors USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)$policy$,name);
  EXECUTE format($policy$CREATE POLICY authority_reads ON %I FOR SELECT TO luma_case_reader USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)$policy$,name);
 END LOOP;
END $$;

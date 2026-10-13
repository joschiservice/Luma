CREATE TABLE connector_source_reviews (
 tenant_id uuid NOT NULL, id uuid NOT NULL, connection_id uuid NOT NULL, document jsonb NOT NULL,
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,connection_id) REFERENCES connector_installations(tenant_id,id),
 CHECK(COALESCE(document->>'id'=id::text AND document->>'connectionId'=connection_id::text,false))
);
CREATE TABLE connector_source_environments (
 tenant_id uuid NOT NULL, connection_id uuid NOT NULL, revision integer NOT NULL CHECK(revision>0), document jsonb NOT NULL,
 PRIMARY KEY(tenant_id,connection_id), FOREIGN KEY(tenant_id,connection_id) REFERENCES connector_installations(tenant_id,id),
 CHECK(COALESCE(document->>'connectionId'=connection_id::text AND (document->>'revision')::integer=revision,false))
);
CREATE TABLE connector_source_commands (
 tenant_id uuid NOT NULL, id uuid NOT NULL, connection_id uuid NOT NULL, revision integer NOT NULL, fingerprint text NOT NULL CHECK(length(fingerprint)=64), document jsonb NOT NULL,
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,connection_id,revision), FOREIGN KEY(tenant_id,connection_id) REFERENCES connector_installations(tenant_id,id)
);
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['connector_source_reviews','connector_source_environments','connector_source_commands'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO luma_connectors USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',relation);
 END LOOP;
END $$;
GRANT SELECT,INSERT ON connector_source_reviews,connector_source_commands TO luma_connectors;
GRANT SELECT,INSERT,UPDATE ON connector_source_environments TO luma_connectors;

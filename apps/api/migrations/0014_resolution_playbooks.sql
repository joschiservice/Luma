-- Workflows own playbook contracts and immutable run evidence. Execution owns admission authority.
CREATE TABLE playbook_definitions (
 tenant_id uuid NOT NULL, id text NOT NULL, document jsonb NOT NULL,
 PRIMARY KEY(tenant_id,id),
 CHECK(COALESCE(document->>'id'=id,false))
);
CREATE TABLE playbook_versions (
 tenant_id uuid NOT NULL, definition_id text NOT NULL, version text NOT NULL,
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'), document jsonb NOT NULL,
 PRIMARY KEY(tenant_id,definition_id,version),
 UNIQUE(tenant_id,definition_id,version,digest),
 FOREIGN KEY(tenant_id,definition_id) REFERENCES playbook_definitions(tenant_id,id),
 CHECK(COALESCE(document->'definition'->>'id'=definition_id AND document->>'version'=version AND document->>'digest'=digest,false))
);
CREATE TABLE playbook_activations (
 tenant_id uuid NOT NULL, id uuid NOT NULL, definition_id text NOT NULL,
 version text NOT NULL, version_digest text NOT NULL, document jsonb NOT NULL,
 PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,id,definition_id,version,version_digest),
 FOREIGN KEY(tenant_id,definition_id,version,version_digest) REFERENCES playbook_versions(tenant_id,definition_id,version,digest),
 CHECK(COALESCE(document->>'id'=id::text AND document->>'tenantId'=tenant_id::text AND document->>'definitionId'=definition_id AND document->>'version'=version AND document->>'versionDigest'=version_digest,false))
);
CREATE TABLE playbook_runs (
 tenant_id uuid NOT NULL, id uuid NOT NULL, activation_id uuid NOT NULL,
 definition_id text NOT NULL, version text NOT NULL, version_digest text NOT NULL,
 document jsonb NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,activation_id,definition_id,version,version_digest) REFERENCES playbook_activations(tenant_id,id,definition_id,version,version_digest),
 CHECK(COALESCE(document->>'id'=id::text AND document->>'tenantId'=tenant_id::text AND document->>'activationId'=activation_id::text AND document->>'definitionId'=definition_id AND document->>'version'=version AND document->>'versionDigest'=version_digest AND document->'action'->>'id'=id::text,false))
);
CREATE TABLE playbook_outcomes (
 tenant_id uuid NOT NULL, run_id uuid NOT NULL, digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
 document jsonb NOT NULL, sequence bigint GENERATED ALWAYS AS IDENTITY,
 PRIMARY KEY(tenant_id,run_id,digest),
 FOREIGN KEY(tenant_id,run_id) REFERENCES playbook_runs(tenant_id,id),
 CHECK(COALESCE(document->>'proposalId'=run_id::text,false))
);
GRANT SELECT,INSERT ON playbook_definitions,playbook_versions,playbook_activations,playbook_runs,playbook_outcomes TO luma_desk;
GRANT USAGE ON SEQUENCE playbook_outcomes_sequence_seq TO luma_desk;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['playbook_definitions','playbook_versions','playbook_activations','playbook_runs','playbook_outcomes'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO luma_desk USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',name);
 END LOOP;
END $$;

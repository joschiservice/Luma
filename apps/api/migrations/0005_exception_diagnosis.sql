CREATE TABLE exception_diagnosis_heads (
 tenant_id uuid NOT NULL, exception_id uuid NOT NULL, revision integer NOT NULL CHECK(revision>0),
 evidence_time timestamptz NOT NULL, PRIMARY KEY(tenant_id,exception_id),
 FOREIGN KEY(tenant_id,exception_id) REFERENCES exceptions(tenant_id,id)
);
CREATE TABLE exception_diagnoses (
 tenant_id uuid NOT NULL, exception_id uuid NOT NULL, revision integer NOT NULL CHECK(revision>0),
 revision_key text NOT NULL, snapshot jsonb NOT NULL, document jsonb NOT NULL,
 PRIMARY KEY(tenant_id,exception_id,revision), UNIQUE(tenant_id,exception_id,revision_key),
 FOREIGN KEY(tenant_id,exception_id) REFERENCES exceptions(tenant_id,id),
 CHECK(COALESCE(document->>'exceptionId'=exception_id::text AND (document->>'revision')::integer=revision AND document->>'schemaVersion'='1',false)),
 CHECK(COALESCE(document->>'status' IN ('pending','ready','insufficient_evidence','failed'),false))
);
ALTER TABLE exception_diagnosis_heads ADD CONSTRAINT diagnosis_current_revision
 FOREIGN KEY(tenant_id,exception_id,revision) REFERENCES exception_diagnoses(tenant_id,exception_id,revision) DEFERRABLE INITIALLY DEFERRED;
GRANT SELECT,INSERT ON exception_diagnosis_heads,exception_diagnoses TO luma_exceptions;
GRANT UPDATE(revision,evidence_time) ON exception_diagnosis_heads TO luma_exceptions;
GRANT UPDATE(document) ON exception_diagnoses TO luma_exceptions;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['exception_diagnosis_heads','exception_diagnoses'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO luma_exceptions USING (tenant_id = NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',name);
 END LOOP;
END $$;

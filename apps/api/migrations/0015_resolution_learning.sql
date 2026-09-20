-- Workflows owns the resolution-learning projection and operator-supplied facts.
CREATE TABLE resolution_runs (
 tenant_id uuid NOT NULL, id uuid NOT NULL, incident_id uuid NOT NULL,
 diagnosis_revision integer NOT NULL, artifact_id text NOT NULL, artifact_version text NOT NULL,
 document jsonb NOT NULL, request jsonb NOT NULL, actor_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,incident_id,diagnosis_revision) REFERENCES exception_diagnoses(tenant_id,exception_id,revision),
 FOREIGN KEY(tenant_id,artifact_id,artifact_version) REFERENCES action_artifacts(tenant_id,id,version),
 CHECK(COALESCE(document->>'id'=id::text AND document->>'incidentId'=incident_id::text AND (document->>'diagnosisRevision')::integer=diagnosis_revision AND document->'resolution'->>'id'=artifact_id AND document->'resolution'->>'version'=artifact_version,false))
);
CREATE INDEX resolution_runs_incident_idx ON resolution_runs(tenant_id,incident_id,id);
CREATE INDEX resolution_runs_artifact_idx ON resolution_runs(tenant_id,artifact_id,artifact_version);
CREATE TABLE resolution_learning_events (
 tenant_id uuid NOT NULL, id uuid NOT NULL, run_id uuid NOT NULL,
 sequence integer NOT NULL CHECK(sequence>0), kind text NOT NULL CHECK(kind IN ('cause','repair_step','intervention','observation','human_edit','outcome','recurrence')),
 step_id text, recurrence_id uuid, document jsonb NOT NULL, request jsonb NOT NULL, actor_id text NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,run_id,sequence),
 FOREIGN KEY(tenant_id,run_id) REFERENCES resolution_runs(tenant_id,id),
 FOREIGN KEY(tenant_id,recurrence_id) REFERENCES exceptions(tenant_id,id),
 CHECK(COALESCE(document->>'id'=id::text AND document->'fact'->>'kind'=kind AND (document->>'sequence')::integer=sequence,false))
);
CREATE UNIQUE INDEX resolution_repair_step_idx ON resolution_learning_events(tenant_id,run_id,step_id) WHERE kind='repair_step';
CREATE INDEX resolution_recurrence_idx ON resolution_learning_events(tenant_id,recurrence_id) WHERE recurrence_id IS NOT NULL;
GRANT SELECT,INSERT ON resolution_runs,resolution_learning_events TO luma_desk;
GRANT SELECT ON resolution_runs,resolution_learning_events TO luma_execution;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['resolution_runs','resolution_learning_events'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO luma_desk USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',name);
 END LOOP;
 FOREACH name IN ARRAY ARRAY['action_artifacts','action_admission_runs','action_admission_steps','execution_verifications','execution_failures'] LOOP
  EXECUTE format('GRANT SELECT ON %I TO luma_desk',name);
  EXECUTE format('CREATE POLICY learning_reads ON %I FOR SELECT TO luma_desk USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',name);
 END LOOP;
END $$;
CREATE POLICY execution_reads ON resolution_runs FOR SELECT TO luma_execution USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
-- A run ID must identify the same incident and playbook in learning and execution.
CREATE FUNCTION protect_resolution_run_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE existing jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('resolution:' || NEW.tenant_id::text || ':' || NEW.id::text,0));
 IF TG_TABLE_NAME='resolution_runs' THEN
  SELECT document INTO existing FROM action_admission_runs WHERE tenant_id=NEW.tenant_id AND id=NEW.id;
  IF FOUND AND (existing->>'incidentId'<>NEW.incident_id::text OR (existing->>'diagnosisRevision')::integer<>NEW.diagnosis_revision OR existing->>'artifactId'<>NEW.artifact_id OR existing->>'artifactVersion'<>NEW.artifact_version) THEN
   RAISE EXCEPTION 'Resolution run binding conflicts';
  END IF;
 ELSE
  SELECT document INTO existing FROM resolution_runs WHERE tenant_id=NEW.tenant_id AND id=NEW.id;
  IF FOUND AND (existing->>'incidentId'<>NEW.document->>'incidentId' OR existing->>'diagnosisRevision'<>NEW.document->>'diagnosisRevision' OR existing->'resolution'->>'id'<>NEW.artifact_id OR existing->'resolution'->>'version'<>NEW.artifact_version) THEN
   RAISE EXCEPTION 'Resolution run binding conflicts';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER resolution_run_binding BEFORE INSERT ON resolution_runs FOR EACH ROW EXECUTE FUNCTION protect_resolution_run_binding();
CREATE TRIGGER admission_resolution_binding BEFORE INSERT ON action_admission_runs FOR EACH ROW EXECUTE FUNCTION protect_resolution_run_binding();

CREATE POLICY execution_reads ON resolution_learning_events FOR SELECT TO luma_execution USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE FUNCTION protect_resolution_step_binding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('resolution:' || NEW.tenant_id::text || ':' || NEW.run_id::text,0));
 IF EXISTS(SELECT 1 FROM resolution_learning_events WHERE tenant_id=NEW.tenant_id AND run_id=NEW.run_id AND step_id=NEW.step_id AND kind='repair_step') THEN
  RAISE EXCEPTION 'Step ID is already bound to a human repair';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER resolution_step_binding BEFORE INSERT ON action_admission_steps FOR EACH ROW EXECUTE FUNCTION protect_resolution_step_binding();

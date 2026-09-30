-- Resolution owns immutable facts, not a second metric store. Counts read these facts and their authoritative owners.
CREATE TABLE resolution_measurement_facts (
 tenant_id uuid NOT NULL, id uuid NOT NULL, incident_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0), kind text NOT NULL CHECK(kind IN ('environment','eligibility','attribution','incorrect_action','baseline')),
 actor_id text NOT NULL, document jsonb NOT NULL, request jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,incident_id,revision),
 FOREIGN KEY(tenant_id,incident_id) REFERENCES exceptions(tenant_id,id),
 CHECK(COALESCE(document->>'id'=id::text AND document->>'incidentId'=incident_id::text AND (document->>'revision')::integer=revision AND document->'fact'->>'kind'=kind AND (document->>'schemaVersion')::integer=1,false))
);
CREATE UNIQUE INDEX resolution_measurement_environment ON resolution_measurement_facts(tenant_id,incident_id) WHERE kind='environment';
CREATE INDEX resolution_measurement_detection ON exceptions(tenant_id,(document->>'firstDetectedAt'),id);
GRANT SELECT,INSERT ON resolution_measurement_facts TO luma_desk;
GRANT SELECT ON resolution_measurement_facts TO luma_case_reader;
ALTER TABLE resolution_measurement_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE resolution_measurement_facts FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_scope ON resolution_measurement_facts TO luma_desk
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY metric_scope ON resolution_measurement_facts FOR SELECT TO luma_case_reader
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['resolution_runs','resolution_learning_events','action_admission_steps','exception_evidence','exception_sources'] LOOP
  EXECUTE format('GRANT SELECT ON %I TO luma_case_reader',name);
  EXECUTE format('CREATE POLICY resolution_metric_reads ON %I FOR SELECT TO luma_case_reader USING(tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',name);
 END LOOP;
 FOREACH name IN ARRAY ARRAY['resolution_measurement_facts','resolution_runs','resolution_learning_events','action_admission_steps','exception_evidence','exception_sources','exception_inputs','exception_outbox'] LOOP
  EXECUTE format('CREATE TRIGGER metric_change AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION notify_metric_change()',name);
 END LOOP;
END $$;

CREATE TABLE action_artifacts (
 tenant_id uuid NOT NULL, id text NOT NULL, version text NOT NULL,
 digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
 active boolean NOT NULL DEFAULT true, document jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id,version),
 CHECK(document->>'id'=id AND document->>'version'=version)
);
CREATE TABLE action_admission_runs (
 tenant_id uuid NOT NULL, id uuid NOT NULL, document jsonb NOT NULL,
 artifact_id text NOT NULL, artifact_version text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,artifact_id,artifact_version) REFERENCES action_artifacts(tenant_id,id,version),
 CHECK(COALESCE(document->>'tenantId'=tenant_id::text AND document->>'runId'=id::text AND document->>'artifactId'=artifact_id AND document->>'artifactVersion'=artifact_version,false))
);
CREATE TABLE action_admission_steps (
 tenant_id uuid NOT NULL, run_id uuid NOT NULL, step_id text NOT NULL,
 proposal_id uuid NOT NULL, artifact_id text NOT NULL, artifact_version text NOT NULL,
 document jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,run_id) REFERENCES action_admission_runs(tenant_id,id),
 PRIMARY KEY(tenant_id,run_id,step_id), UNIQUE(tenant_id,proposal_id),
 FOREIGN KEY(tenant_id,artifact_id,artifact_version) REFERENCES action_artifacts(tenant_id,id,version),
 CHECK(COALESCE(document->>'tenantId'=tenant_id::text AND document->>'runId'=run_id::text AND document->>'stepId'=step_id AND document->'action'->>'id'=proposal_id::text,false))
);
GRANT SELECT,INSERT ON action_artifacts,action_admission_runs,action_admission_steps TO luma_execution;
GRANT UPDATE(active) ON action_artifacts TO luma_execution;
ALTER TABLE action_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_artifacts FORCE ROW LEVEL SECURITY;
ALTER TABLE action_admission_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_admission_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE action_admission_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_admission_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON action_artifacts TO luma_execution
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_scope ON action_admission_runs TO luma_execution
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_scope ON action_admission_steps TO luma_execution
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

-- Outcome evidence can advance; reserved intent, provider identity and terminal results cannot change.
CREATE OR REPLACE FUNCTION protect_execution_intent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT ((OLD.state = 'prepared' AND NEW.state IN ('unknown','failed','succeeded')) OR (OLD.state = 'unknown' AND NEW.state IN ('unknown','succeeded'))) OR
    (NEW.document - 'state' - 'attempt') IS DISTINCT FROM (OLD.document - 'state' - 'attempt') OR
    ((NEW.document->'attempt') - 'finishedAt' - 'verification' - 'effectEvidenceRefs' - 'dispatch' - 'businessOutcome' - 'providerRequestId') IS DISTINCT FROM
    ((OLD.document->'attempt') - 'finishedAt' - 'verification' - 'effectEvidenceRefs' - 'dispatch' - 'businessOutcome' - 'providerRequestId') OR
    (OLD.state = 'unknown' AND (
      (NEW.document->'attempt'->'dispatch') IS DISTINCT FROM (OLD.document->'attempt'->'dispatch') OR
      (NEW.document->'attempt'->'providerRequestId') IS DISTINCT FROM (OLD.document->'attempt'->'providerRequestId')
    )) THEN
  RAISE EXCEPTION 'Execution intent and finalized attempts are immutable';
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION protect_artifact_revocation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.active = false AND NEW.active = true THEN
  RAISE EXCEPTION 'Revoked artifact versions cannot be reactivated';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER artifact_revocation_immutable BEFORE UPDATE ON action_artifacts FOR EACH ROW EXECUTE FUNCTION protect_artifact_revocation();

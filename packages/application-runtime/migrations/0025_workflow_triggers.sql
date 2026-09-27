-- Triggering binds evidence but never creates an execution activation or permission artifact.
CREATE TABLE workflow_trigger_runs (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 definition_id text NOT NULL,
 version text NOT NULL,
 version_digest text NOT NULL,
 dedupe_key text NOT NULL,
 request_digest text NOT NULL,
 document jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('scheduled','awaiting_admission','cancelled')),
 due_at timestamptz,
 triggered_at timestamptz,
 PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,dedupe_key),
 FOREIGN KEY(tenant_id,definition_id,version,version_digest) REFERENCES playbook_versions(tenant_id,definition_id,version,digest),
 CHECK(COALESCE(document->>'tenantId'=tenant_id::text AND document->>'id'=id::text AND document->>'definitionId'=definition_id AND document->>'version'=version AND document->>'versionDigest'=version_digest AND document->>'requestDigest'=request_digest,false)),
 CHECK((document->'trigger'->>'kind'='schedule') = (due_at IS NOT NULL))
);
CREATE INDEX workflow_trigger_runs_due ON workflow_trigger_runs(due_at) WHERE state='scheduled';
ALTER TABLE workflow_trigger_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_trigger_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON workflow_trigger_runs TO luma_desk
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON workflow_trigger_runs TO luma_desk;
GRANT UPDATE(state,triggered_at) ON workflow_trigger_runs TO luma_desk;

-- Workers can advance due starts across tenants, but cannot read their payloads or dispatch actions.
-- The transaction either commits the transition or leaves the start available for a later worker.
CREATE FUNCTION advance_workflow_schedules() RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE changed integer;
BEGIN
 WITH due AS (
   SELECT tenant_id,id FROM public.workflow_trigger_runs
   WHERE state='scheduled' AND due_at<=CURRENT_TIMESTAMP
   ORDER BY due_at LIMIT 100 FOR UPDATE SKIP LOCKED
 )
 UPDATE public.workflow_trigger_runs r SET state='awaiting_admission', triggered_at=CURRENT_TIMESTAMP
 FROM due WHERE r.tenant_id=due.tenant_id AND r.id=due.id;
 GET DIAGNOSTICS changed = ROW_COUNT;
 RETURN changed;
END $$;
REVOKE ALL ON FUNCTION advance_workflow_schedules() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION advance_workflow_schedules() TO luma_desk;

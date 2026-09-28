-- Capability replies survive activity retries. Cancellation never deletes execution evidence.
CREATE TABLE workflow_code_records (
 tenant_id uuid NOT NULL,
 run_id uuid NOT NULL,
 step_id text NOT NULL,
 record_key text NOT NULL,
 document jsonb NOT NULL,
 PRIMARY KEY(tenant_id,run_id,step_id,record_key),
 FOREIGN KEY(tenant_id,run_id) REFERENCES workflow_trigger_runs(tenant_id,id)
);
ALTER TABLE workflow_code_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_code_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON workflow_code_records TO luma_desk
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON workflow_code_records TO luma_desk;

CREATE TABLE workflow_code_evaluations (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 definition_id text NOT NULL,
 version text NOT NULL,
 principal_id uuid NOT NULL,
 request_digest text NOT NULL,
 state text NOT NULL CHECK(state IN ('running','passed','failed','cancelled')),
 document jsonb NOT NULL,
 expires_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,definition_id,version) REFERENCES playbook_versions(tenant_id,definition_id,version)
);
ALTER TABLE workflow_code_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_code_evaluations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON workflow_code_evaluations TO luma_desk
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON workflow_code_evaluations TO luma_desk;

-- Discovery exposes routing identifiers only. Activities reauthorize each exact tenant run.
CREATE FUNCTION code_process_worker_scopes() RETURNS TABLE(tenant_id uuid,principal_id text,definition_id text)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT DISTINCT r.tenant_id,r.document->'actor'->>'id',r.definition_id
 FROM public.workflow_trigger_runs r JOIN public.playbook_versions v
 ON v.tenant_id=r.tenant_id AND v.definition_id=r.definition_id AND v.version=r.version
 WHERE r.state='awaiting_admission' AND v.document->>'format'='workflow/2'
 AND EXISTS (SELECT 1 FROM jsonb_array_elements(v.document->'steps') s WHERE s->>'kind'='code')
 AND NOT EXISTS (SELECT 1 FROM public.workflow_process_steps p WHERE p.tenant_id=r.tenant_id AND p.run_id=r.id AND (p.document->>'kind'='end' OR p.state IN ('denied','failed','inconclusive','ended','escalated')))
$$;
REVOKE ALL ON FUNCTION code_process_worker_scopes() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION code_process_worker_scopes() TO luma_desk;

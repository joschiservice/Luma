-- Admission only reads workflow liveness; it never changes another owner's run.
GRANT SELECT(tenant_id,id,state) ON workflow_trigger_runs TO luma_execution;
CREATE POLICY execution_workflow_liveness ON workflow_trigger_runs FOR SELECT TO luma_execution
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE INDEX executed_actions_admission_run ON executed_actions(tenant_id,(document->'admission'->>'runId'))
 WHERE document ? 'admission';

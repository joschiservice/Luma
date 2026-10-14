-- Case readers may inspect admitted intent but gain no admission or execution writes.
GRANT SELECT ON action_admission_steps TO luma_desk;
CREATE POLICY case_admission_history ON action_admission_steps FOR SELECT TO luma_desk
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE INDEX workflow_trigger_case ON workflow_trigger_runs(tenant_id,(document->'context'->'inputs'->>'caseId'))
 WHERE document->'context'->'inputs'->>'caseId' IS NOT NULL;

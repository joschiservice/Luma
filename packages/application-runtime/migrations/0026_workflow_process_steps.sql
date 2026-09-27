-- Process evidence is append-only. A repeated Temporal activity must return the same record.
CREATE TABLE workflow_process_steps (
 tenant_id uuid NOT NULL,
 run_id uuid NOT NULL,
 sequence bigint GENERATED ALWAYS AS IDENTITY,
 step_id text NOT NULL,
 state text NOT NULL CHECK(state IN ('completed','waiting','denied','failed','inconclusive','ended','escalated')),
 document jsonb NOT NULL,
 PRIMARY KEY(tenant_id,run_id,step_id,state),
 FOREIGN KEY(tenant_id,run_id) REFERENCES workflow_trigger_runs(tenant_id,id),
  CHECK(COALESCE(document->>'stepId'=step_id AND document->>'state'=state,false))
);
ALTER TABLE workflow_process_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_process_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON workflow_process_steps TO luma_desk
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON workflow_process_steps TO luma_desk;

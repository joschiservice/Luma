-- Proposal context is immutable and informational; it never replaces dispatch preconditions.
CREATE TABLE replenishment_approval_contexts (
 tenant_id uuid NOT NULL,run_id uuid NOT NULL,document jsonb NOT NULL,
 PRIMARY KEY(tenant_id,run_id),
 FOREIGN KEY(tenant_id,run_id) REFERENCES workflow_trigger_runs(tenant_id,id)
);
GRANT SELECT,INSERT ON replenishment_approval_contexts TO luma_desk;
ALTER TABLE replenishment_approval_contexts ENABLE ROW LEVEL SECURITY;
ALTER TABLE replenishment_approval_contexts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON replenishment_approval_contexts TO luma_desk
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

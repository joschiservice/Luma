-- A comparison that waits for provider sync is neither an issue nor uncertainty. The detector
-- keeps the latest wait per fingerprint so views can say what Luma is waiting for; any other
-- decision for the fingerprint removes it.
CREATE TABLE exception_pending_sync (
 tenant_id uuid NOT NULL, fingerprint text NOT NULL,
 subject_kind text NOT NULL, subject_id text NOT NULL, scope jsonb NOT NULL,
 mismatch_since timestamptz NOT NULL, wait_until timestamptz NOT NULL,
 evaluated_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,fingerprint),
 CHECK (jsonb_typeof(scope)='array' AND wait_until >= mismatch_since)
);
CREATE INDEX exception_pending_sync_subject ON exception_pending_sync(tenant_id,subject_kind,subject_id);
GRANT SELECT,INSERT,UPDATE,DELETE ON exception_pending_sync TO luma_exceptions;
GRANT SELECT ON exception_pending_sync TO luma_case_reader;
ALTER TABLE exception_pending_sync ENABLE ROW LEVEL SECURITY;
ALTER TABLE exception_pending_sync FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON exception_pending_sync TO luma_exceptions
 USING (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY case_reads ON exception_pending_sync FOR SELECT TO luma_case_reader
 USING (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE TRIGGER metric_change AFTER INSERT OR UPDATE OR DELETE ON exception_pending_sync
 FOR EACH ROW EXECUTE FUNCTION notify_metric_change('inventory,orders,issues');

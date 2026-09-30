-- Who is looking after a Needs you decision. Resolution owns the writes; the decision itself
-- stays with its owner, so an assignment never grants approval authority.
CREATE TABLE decision_assignments (
 tenant_id uuid NOT NULL,
 decision_id text NOT NULL CHECK(length(decision_id) BETWEEN 1 AND 200),
 assignee_id uuid,
 assigned_by uuid NOT NULL,
 assigned_at timestamptz NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 PRIMARY KEY(tenant_id,decision_id)
);
CREATE INDEX decision_assignments_assignee ON decision_assignments(tenant_id,assignee_id);
GRANT SELECT,INSERT ON decision_assignments TO luma_desk;
GRANT UPDATE(assignee_id,assigned_by,assigned_at,revision) ON decision_assignments TO luma_desk;
GRANT SELECT ON decision_assignments TO luma_case_reader;
ALTER TABLE decision_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE decision_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_scope ON decision_assignments TO luma_desk
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY reader_scope ON decision_assignments FOR SELECT TO luma_case_reader
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

-- App decision reads list a tenant's recent previews and their claims.
CREATE INDEX shopify_fulfillment_recoveries_recent ON shopify_fulfillment_recoveries(tenant_id,created_at DESC);
CREATE INDEX shopify_fulfillment_claims_run ON shopify_fulfillment_claims(tenant_id,run_id);
CREATE INDEX shopify_inventory_corrections_recent ON shopify_inventory_corrections(tenant_id,created_at DESC);
CREATE INDEX shopify_inventory_claims_run ON shopify_inventory_claims(tenant_id,run_id);

-- Queue sources that are not already covered wake the same tenant stream. Case, proposal and
-- policy tables were added in 0031.
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['decision_assignments','workflow_process_steps','replenishment_claims',
  'executed_actions','shopify_fulfillment_recoveries','shopify_fulfillment_claims',
  'shopify_inventory_corrections','shopify_inventory_claims'] LOOP
  EXECUTE format('CREATE TRIGGER metric_change AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION notify_metric_change()',name);
 END LOOP;
END $$;

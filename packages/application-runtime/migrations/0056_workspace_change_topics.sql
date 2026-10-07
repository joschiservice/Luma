-- Change wake-ups name the areas that changed, so a live view reads again only for its own data.
-- The payload is `tenant:topic,topic` from the trigger argument; a trigger without one still sends
-- the bare tenant, which listeners treat as a change everywhere. Tables that feed Needs you also
-- carry `decisions`. Record links (connector_source_mappings) and handover signals read from
-- orders are left out; the stream's 30-second reconciliation covers them.
CREATE OR REPLACE FUNCTION notify_metric_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE suffix text := CASE WHEN TG_NARGS > 0 THEN ':' || TG_ARGV[0] ELSE '' END;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM pg_notify('luma_metrics', OLD.tenant_id::text || suffix);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM pg_notify('luma_metrics', NEW.tenant_id::text || suffix);
  END IF;
  RETURN NULL;
END $$;

DO $$ DECLARE entry text[]; BEGIN
 FOREACH entry SLICE 1 IN ARRAY ARRAY[
  ['orders_projections','orders'], ['orders_snapshots','orders'], ['orders_relationships','orders'],
  ['connector_installations','connections'], ['connector_observations','connections'],
  ['connector_read_checks','connections'], ['connector_source_mappings','connections'],
  ['exceptions','issues,decisions'], ['exception_diagnosis_heads','issues,decisions'],
  ['exception_diagnoses','issues,decisions'], ['exception_uncertainty','issues,decisions'],
  ['case_commands','issues,decisions'], ['case_proposals','issues,decisions'],
  ['policy_decisions','issues,decisions'], ['policy_approvals','issues,decisions'],
  ['action_admission_steps','issues,decisions'],
  ['exception_evidence','issues'], ['exception_sources','issues'], ['exception_inputs','issues'],
  ['exception_outbox','issues'],
  ['inventory_projections','inventory'], ['inventory_snapshots','inventory'],
  ['inventory_entities','inventory'],
  ['replenishment_activations','procurement,decisions'], ['replenishment_claims','procurement'],
  ['procurement_purchase_orders','procurement,decisions'],
  ['procurement_submissions','procurement,decisions'],
  ['procurement_commitments','procurement,decisions'],
  ['procurement_follow_ups','procurement,decisions'],
  ['procurement_communications','procurement'], ['procurement_extractions','procurement'],
  ['procurement_observations','procurement'],
  ['workflow_process_steps','workflows,decisions'], ['executed_actions','workflows,decisions'],
  ['shopify_fulfillment_recoveries','workflows,decisions'],
  ['shopify_fulfillment_claims','workflows,decisions'],
  ['shopify_inventory_corrections','workflows,decisions'],
  ['shopify_inventory_claims','workflows,decisions'],
  ['resolution_measurement_facts','resolution'], ['resolution_runs','resolution'],
  ['resolution_learning_events','resolution'],
  ['decision_assignments','decisions']
 ] LOOP
  EXECUTE format('DROP TRIGGER metric_change ON %I', entry[1]);
  EXECUTE format('CREATE TRIGGER metric_change AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION notify_metric_change(%L)', entry[1], entry[2]);
 END LOOP;
 IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'metric_change' AND tgnargs = 0) THEN
  RAISE EXCEPTION 'Every metric_change trigger must name its topics';
 END IF;
END $$;

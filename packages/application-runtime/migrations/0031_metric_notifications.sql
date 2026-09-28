-- Canonical rows remain the durable truth. These transactional wake-ups are not an event log.
-- Identical tenant payloads coalesce within a transaction; rollback emits nothing.
CREATE FUNCTION notify_metric_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM pg_notify('luma_metrics', OLD.tenant_id::text);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM pg_notify('luma_metrics', NEW.tenant_id::text);
  END IF;
  RETURN NULL;
END $$;
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY[
    'orders_projections', 'orders_snapshots', 'orders_relationships',
    'connector_source_mappings', 'connector_installations',
    'connector_observations', 'connector_read_checks', 'exceptions',
    'exception_diagnosis_heads', 'exception_diagnoses', 'exception_uncertainty',
    'case_commands', 'case_proposals', 'policy_decisions', 'policy_approvals'
  ] LOOP
    EXECUTE format('CREATE TRIGGER metric_change AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION notify_metric_change()', name);
  END LOOP;
END $$;

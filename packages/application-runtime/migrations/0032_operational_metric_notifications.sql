-- All source corrections, deletes and lifecycle changes invalidate the same tenant stream.
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY[
    'inventory_projections', 'inventory_snapshots', 'inventory_entities',
    'replenishment_activations', 'procurement_purchase_orders'
  ] LOOP
    EXECUTE format('CREATE TRIGGER metric_change AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION notify_metric_change()', name);
  END LOOP;
END $$;

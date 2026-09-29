-- Tenant-scoped record explorer reads current canonical identities and snapshots.
GRANT SELECT ON orders_entities, inventory_entities, inventory_projections, inventory_snapshots TO luma_case_reader;

DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['orders_entities','inventory_entities','inventory_projections','inventory_snapshots'] LOOP
    EXECUTE format('CREATE POLICY record_explorer_reads ON %I FOR SELECT TO luma_case_reader USING (tenant_id = NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)', name);
  END LOOP;
END $$;

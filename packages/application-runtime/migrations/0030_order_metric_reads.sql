-- Metrics share the existing read-only, tenant-scoped API role. No credential access.
GRANT SELECT ON orders_projections, orders_snapshots, orders_relationships, connector_source_mappings TO luma_case_reader;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['orders_projections','orders_snapshots','orders_relationships','connector_source_mappings'] LOOP
  EXECUTE format('CREATE POLICY metric_reads ON %I FOR SELECT TO luma_case_reader USING (tenant_id = NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',name);
 END LOOP;
END $$;
CREATE INDEX orders_projection_connection ON orders_projections(tenant_id,connection_id,entity_id);

-- Shopify reads owner-reviewed balances; Inventory remains the sole stock writer.
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['inventory_stock_ownership_scopes','inventory_stock_ownership_transitions','inventory_ledger_accounts','inventory_ledger_entries','inventory_ledger_postings','inventory_ledger_reviews'] LOOP
  EXECUTE format('GRANT SELECT ON %I TO luma_connectors',name);
  EXECUTE format($policy$CREATE POLICY native_publication_read ON %I FOR SELECT TO luma_connectors USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)$policy$,name);
 END LOOP;
END $$;

-- A possible native publication makes this exact source pool channel evidence until audited handback.
CREATE TABLE shopify_native_stock_replicas (
 tenant_id uuid NOT NULL,run_id uuid NOT NULL,connection_id uuid NOT NULL,sku_id uuid NOT NULL,location_id uuid NOT NULL,unit text NOT NULL,
 scope_version bigint NOT NULL,recorded_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,run_id),FOREIGN KEY(tenant_id,run_id) REFERENCES shopify_inventory_corrections(tenant_id,id),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES connector_installations(tenant_id,id),
 FOREIGN KEY(tenant_id,sku_id) REFERENCES inventory_entities(tenant_id,id),FOREIGN KEY(tenant_id,location_id) REFERENCES inventory_entities(tenant_id,id)
);
CREATE INDEX shopify_native_replica_pool ON shopify_native_stock_replicas(tenant_id,connection_id,sku_id,location_id,unit,scope_version);
ALTER TABLE shopify_native_stock_replicas ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopify_native_stock_replicas FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON shopify_native_stock_replicas TO luma_connectors USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY inventory_read ON shopify_native_stock_replicas FOR SELECT TO luma_inventory,luma_case_reader USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON shopify_native_stock_replicas TO luma_connectors;
GRANT SELECT ON shopify_native_stock_replicas TO luma_inventory,luma_case_reader;
CREATE TRIGGER shopify_native_replica_immutable BEFORE UPDATE OR DELETE ON shopify_native_stock_replicas FOR EACH ROW EXECUTE FUNCTION inventory_ledger_immutable();
CREATE TRIGGER metric_change AFTER INSERT OR UPDATE OR DELETE ON shopify_native_stock_replicas FOR EACH ROW EXECUTE FUNCTION notify_metric_change('inventory,decisions');

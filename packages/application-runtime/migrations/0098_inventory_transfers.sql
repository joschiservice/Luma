ALTER TABLE inventory_entities DROP CONSTRAINT inventory_entities_kind_check;
ALTER TABLE inventory_entities ADD CONSTRAINT inventory_entities_kind_check
 CHECK(kind IN ('sku','location','product','position','inventory_transfer','inventory_shipment'));
ALTER TABLE connector_source_mappings DROP CONSTRAINT connector_source_mappings_resource_check;
ALTER TABLE connector_source_mappings ADD CONSTRAINT connector_source_mappings_resource_check
 CHECK(resource IN ('order','order_line','fulfillment','sku','location','product','return','refund','inventory_transfer','inventory_shipment'));
ALTER TABLE connector_read_checks DROP CONSTRAINT connector_read_checks_capability_check;
ALTER TABLE connector_read_checks ADD CONSTRAINT connector_read_checks_capability_check
 CHECK(capability IN ('orders.read','products.read','inventory.read','fulfillment.read','customers.read','returns.read','orders.shipping-method.read','inventory.transfers.read','inventory.shipments.read'));
ALTER TABLE commerce_sync_streams DROP CONSTRAINT commerce_sync_streams_record_type_check;
ALTER TABLE commerce_sync_streams ADD CONSTRAINT commerce_sync_streams_record_type_check
 CHECK(record_type IN ('orders','fulfillments','products','inventory','customers','returns','inventory_transfers','inventory_shipments'));
ALTER TABLE commerce_sync_items DROP CONSTRAINT commerce_sync_items_record_type_check;
ALTER TABLE commerce_sync_items ADD CONSTRAINT commerce_sync_items_record_type_check
 CHECK(record_type IN ('orders','fulfillments','products','inventory','customers','returns','inventory_transfers','inventory_shipments'));

-- Scalar list fields and exact relationship indexes stay usable under forced row security.
CREATE TABLE inventory_transfer_records (
 tenant_id uuid NOT NULL, entity_id uuid NOT NULL, connection_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('inventory_transfer','inventory_shipment')),
 facts jsonb NOT NULL, snapshot_id uuid NOT NULL, name text NOT NULL, status text NOT NULL,
 source_created_at timestamptz, observed_at timestamptz NOT NULL, deleted boolean NOT NULL,
 sort_at timestamptz GENERATED ALWAYS AS (COALESCE(source_created_at,observed_at)) STORED,
 PRIMARY KEY(tenant_id,entity_id,connection_id),
 FOREIGN KEY(tenant_id,entity_id,connection_id) REFERENCES inventory_projections(tenant_id,entity_id,connection_id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,entity_id,connection_id,snapshot_id) REFERENCES inventory_snapshots(tenant_id,entity_id,connection_id,id)
);
CREATE INDEX inventory_transfer_records_list ON inventory_transfer_records(tenant_id,kind,entity_id,connection_id) WHERE NOT deleted;
CREATE TABLE inventory_transfer_references (
 tenant_id uuid NOT NULL, entity_id uuid NOT NULL, connection_id uuid NOT NULL,
 resource text NOT NULL CHECK(resource IN ('sku','location')), canonical_id uuid NOT NULL,
 snapshot_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,entity_id,connection_id,resource,canonical_id),
 FOREIGN KEY(tenant_id,entity_id,connection_id) REFERENCES inventory_projections(tenant_id,entity_id,connection_id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,entity_id,connection_id,snapshot_id) REFERENCES inventory_snapshots(tenant_id,entity_id,connection_id,id),
 FOREIGN KEY(tenant_id,resource,canonical_id) REFERENCES inventory_entities(tenant_id,kind,id)
);
CREATE INDEX inventory_transfer_references_target ON inventory_transfer_references(tenant_id,resource,canonical_id,entity_id,connection_id);
CREATE TABLE inventory_transfer_shipments (
 tenant_id uuid NOT NULL, entity_id uuid NOT NULL, connection_id uuid NOT NULL,
 shipment_source_id text NOT NULL, shipment_scope_key text NOT NULL, snapshot_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,entity_id,connection_id,shipment_source_id,shipment_scope_key),
 FOREIGN KEY(tenant_id,entity_id,connection_id) REFERENCES inventory_projections(tenant_id,entity_id,connection_id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,entity_id,connection_id,snapshot_id) REFERENCES inventory_snapshots(tenant_id,entity_id,connection_id,id)
);
CREATE INDEX inventory_transfer_shipments_source ON inventory_transfer_shipments(tenant_id,connection_id,shipment_source_id,shipment_scope_key,entity_id);

GRANT SELECT,INSERT,DELETE ON inventory_transfer_records,inventory_transfer_references,inventory_transfer_shipments TO luma_inventory;
GRANT SELECT ON inventory_transfer_records,inventory_transfer_references,inventory_transfer_shipments TO luma_case_reader;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['inventory_transfer_records','inventory_transfer_references','inventory_transfer_shipments'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format($policy$CREATE POLICY tenant_scope ON %I TO luma_inventory USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)$policy$,name);
  EXECUTE format($policy$CREATE POLICY workspace_read ON %I FOR SELECT TO luma_case_reader USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)$policy$,name);
 END LOOP;
END $$;

-- Readers can join an immutable observation's identity without granting source writes.
GRANT SELECT(id) ON connector_observations TO luma_case_reader;

-- Inventory retains each purchase line's contribution to its incoming account. Provider observations do not alter available stock.
CREATE TABLE inventory_purchase_incoming (
 tenant_id uuid NOT NULL,
 purchase_order_id uuid NOT NULL,
 line_id uuid NOT NULL,
 sku_id uuid NOT NULL,
 location_id uuid NOT NULL,
 unit text NOT NULL CHECK(length(unit) BETWEEN 1 AND 64),
 expected_quantity numeric(24,6) NOT NULL CHECK(expected_quantity>=0),
 outstanding_quantity numeric(24,6) NOT NULL CHECK(outstanding_quantity>=0),
 scope_version bigint NOT NULL CHECK(scope_version>0),
 source_revision text NOT NULL CHECK(length(source_revision)=64),
 source_refs jsonb NOT NULL CHECK(jsonb_typeof(source_refs)='array'),
 observed_at timestamptz NOT NULL,
 expected_date date,
 date_confidence text NOT NULL CHECK(date_confidence IN ('confirmed','requested','unknown')),
 entry_id uuid,
 updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,purchase_order_id,line_id),
 FOREIGN KEY(tenant_id,purchase_order_id) REFERENCES procurement_purchase_orders(tenant_id,id),
 FOREIGN KEY(tenant_id,sku_id) REFERENCES inventory_entities(tenant_id,id),
 FOREIGN KEY(tenant_id,location_id) REFERENCES inventory_entities(tenant_id,id),
 FOREIGN KEY(tenant_id,entry_id) REFERENCES inventory_ledger_entries(tenant_id,id)
);
CREATE INDEX inventory_purchase_incoming_pool ON inventory_purchase_incoming(tenant_id,sku_id,location_id,unit) WHERE outstanding_quantity>0;
ALTER TABLE inventory_purchase_incoming ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_purchase_incoming FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON inventory_purchase_incoming TO luma_inventory,luma_case_reader
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON inventory_purchase_incoming TO luma_inventory;
GRANT SELECT ON inventory_purchase_incoming TO luma_case_reader;

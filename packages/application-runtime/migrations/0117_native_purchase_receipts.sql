DO $$ DECLARE constraint_name text; BEGIN
 SELECT conname INTO STRICT constraint_name FROM pg_constraint WHERE conrelid='inventory_ledger_entries'::regclass
 AND contype='c' AND pg_get_constraintdef(oid) LIKE '%purpose%' AND pg_get_constraintdef(oid) LIKE '%reconciliation%' AND pg_get_constraintdef(oid) LIKE '%production%';
 EXECUTE format('ALTER TABLE inventory_ledger_entries DROP CONSTRAINT %I',constraint_name);
END $$;
ALTER TABLE inventory_ledger_entries ADD CONSTRAINT inventory_ledger_purpose CHECK(purpose IN ('opening','movement','correction','reversal','reservation','release','dispatch','reconciliation','production','purchase_receipt'));
ALTER TABLE inventory_ledger_entries ADD CONSTRAINT inventory_purchase_receipt_review CHECK(purpose<>'purchase_receipt' OR review_id IS NOT NULL);
CREATE TABLE inventory_purchase_receipt_bookings (
 tenant_id uuid NOT NULL,purchase_order_id uuid NOT NULL,line_id uuid NOT NULL,
 good numeric(24,6) NOT NULL CHECK(good>=0),damaged numeric(24,6) NOT NULL CHECK(damaged>=0),
 entry_id uuid NOT NULL,recorded_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,purchase_order_id,line_id),
 FOREIGN KEY(tenant_id,entry_id) REFERENCES inventory_ledger_entries(tenant_id,id),
 FOREIGN KEY(tenant_id,purchase_order_id) REFERENCES procurement_purchase_orders(tenant_id,id)
);
ALTER TABLE inventory_purchase_receipt_bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_purchase_receipt_bookings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON inventory_purchase_receipt_bookings TO luma_inventory
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY receipt_reader ON inventory_purchase_receipt_bookings FOR SELECT TO luma_case_reader
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON inventory_purchase_receipt_bookings TO luma_inventory;
GRANT SELECT ON inventory_purchase_receipt_bookings TO luma_case_reader;

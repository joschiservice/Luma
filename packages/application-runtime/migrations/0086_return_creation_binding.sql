-- Verified return creation is linked when commerce sync imports its independent source record.
GRANT SELECT ON orders_return_cases,orders_return_creations TO luma_orders;
GRANT UPDATE(source_return_id,revision,document,updated_at) ON orders_return_cases TO luma_orders;
GRANT UPDATE(source_return_id) ON orders_return_cases TO luma_desk;
CREATE POLICY order_owner ON orders_return_cases TO luma_orders
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY order_owner_reads ON orders_return_creations FOR SELECT TO luma_orders
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

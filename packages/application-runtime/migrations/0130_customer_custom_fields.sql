-- Customers can carry custom fields. Each source customer profile is its own record.
ALTER TABLE adaptive_fields DROP CONSTRAINT adaptive_fields_record_type_check;
ALTER TABLE adaptive_fields ADD CONSTRAINT adaptive_fields_record_type_check
 CHECK(record_type IN ('order','product','supplier','purchase_order','customer'));
GRANT SELECT(tenant_id,id) ON customer_profiles TO luma_adaptive;
CREATE POLICY adaptive_identity_read ON customer_profiles FOR SELECT TO luma_adaptive
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

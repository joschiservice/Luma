-- Case labels resolve canonical SKUs through tenant-scoped source mappings.
GRANT SELECT ON connector_source_mappings TO luma_case_reader;
CREATE POLICY case_product_identity_reads ON connector_source_mappings FOR SELECT TO luma_case_reader
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

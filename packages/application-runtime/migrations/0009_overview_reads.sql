GRANT SELECT (tenant_id,id,document) ON connector_installations TO luma_case_reader;
GRANT SELECT (tenant_id,connection_id,document) ON connector_observations TO luma_case_reader;
CREATE POLICY overview_reads ON connector_installations FOR SELECT TO luma_case_reader
 USING (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY overview_reads ON connector_observations FOR SELECT TO luma_case_reader
 USING (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid);

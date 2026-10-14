GRANT SELECT(tenant_id,version,document) ON exception_configurations TO luma_case_reader;
CREATE POLICY detection_limits_read ON exception_configurations FOR SELECT TO luma_case_reader
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

GRANT SELECT(tenant_id,connection_id,record_type,last_success_at,last_complete_at,error_code) ON commerce_sync_streams TO luma_case_reader;
CREATE POLICY connection_health_read ON commerce_sync_streams FOR SELECT TO luma_case_reader
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

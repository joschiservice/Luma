ALTER TABLE workspace_settings ADD COLUMN detection jsonb NOT NULL DEFAULT '{"inventoryTolerance":"0","propagationSeconds":1800,"oversellPropagationSeconds":120,"stuckSeconds":7200}';
GRANT SELECT ON workspace_settings TO luma_exceptions;
CREATE POLICY detection_settings_read ON workspace_settings FOR SELECT TO luma_exceptions
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);

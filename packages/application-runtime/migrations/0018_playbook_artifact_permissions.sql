-- Workspace administrators manage playbook artifacts without execution write access.
GRANT INSERT, UPDATE(active) ON action_artifacts TO luma_desk;
CREATE POLICY playbook_management_insert ON action_artifacts FOR INSERT TO luma_desk
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid
 AND id LIKE 'playbook:%' AND document->'playbook' IS NOT NULL);
CREATE POLICY playbook_management_update ON action_artifacts FOR UPDATE TO luma_desk
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid
 AND id LIKE 'playbook:%' AND document->'playbook' IS NOT NULL)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid
 AND id LIKE 'playbook:%' AND document->'playbook' IS NOT NULL);

-- Personal workspace layouts: each member's Home modules and sidebar pins.
CREATE TABLE workspace_layouts (
 tenant_id uuid NOT NULL REFERENCES organizations(id), user_id uuid NOT NULL REFERENCES users(id),
 document jsonb NOT NULL, revision integer NOT NULL DEFAULT 0,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,user_id)
);
GRANT SELECT,INSERT,UPDATE ON workspace_layouts TO luma_identity;
ALTER TABLE workspace_layouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_layouts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON workspace_layouts TO luma_identity
 USING (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid);

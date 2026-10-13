CREATE TABLE procurement_purchasing_ignored (
 tenant_id uuid NOT NULL REFERENCES organizations(id), id uuid NOT NULL, actor_id text NOT NULL,
 request jsonb NOT NULL, recommendation jsonb NOT NULL, decided_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,id)
);
ALTER TABLE procurement_purchasing_ignored ENABLE ROW LEVEL SECURITY;
ALTER TABLE procurement_purchasing_ignored FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON procurement_purchasing_ignored TO luma_desk
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON procurement_purchasing_ignored TO luma_desk;

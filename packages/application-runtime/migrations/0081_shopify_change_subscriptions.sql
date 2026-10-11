-- Registration and verified intake are different facts; no webhook payload is retained here.
CREATE TABLE shopify_change_subscriptions (
 tenant_id uuid NOT NULL,
 connection_id uuid NOT NULL,
 topic text NOT NULL,
 status text NOT NULL CHECK(status IN ('registered','missing','failed','unavailable')),
 checked_at timestamptz NOT NULL,
 last_received_at timestamptz,
 PRIMARY KEY(tenant_id,connection_id,topic),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES connector_installations(tenant_id,id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE shopify_change_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopify_change_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON shopify_change_subscriptions TO luma_connectors
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON shopify_change_subscriptions TO luma_connectors;

-- Monitor bookkeeping advances past already settled and unreceived returns across restarts.
CREATE TABLE resolution_refund_follow_up_cursors (
 tenant_id uuid NOT NULL REFERENCES organizations(id),view text NOT NULL CHECK(view IN('action','waiting')),
 cursor text CHECK(length(cursor)<=4096),PRIMARY KEY(tenant_id,view)
);
ALTER TABLE resolution_refund_follow_up_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE resolution_refund_follow_up_cursors FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON resolution_refund_follow_up_cursors TO luma_desk
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON resolution_refund_follow_up_cursors TO luma_desk;
GRANT UPDATE(cursor) ON resolution_refund_follow_up_cursors TO luma_desk;

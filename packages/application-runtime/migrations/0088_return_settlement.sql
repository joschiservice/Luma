-- Physical and financial return effects retain immutable intent and independent proof.
CREATE TABLE orders_return_actions (
 tenant_id uuid NOT NULL,id uuid NOT NULL,case_id uuid NOT NULL,connection_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('refund','restock')),order_line_id uuid,
 state text NOT NULL CHECK(state IN ('approval_required','approved','rejected','expired','sending','uncertain','pending','verified','failed','not_executed')),
 sent boolean NOT NULL DEFAULT false,document jsonb NOT NULL,requested_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,case_id) REFERENCES orders_return_cases(tenant_id,id),
 CHECK(document->>'id'=id::text AND document->>'tenantId'=tenant_id::text AND document->>'caseId'=case_id::text
  AND document->>'kind'=kind AND document->>'state'=state AND (document->>'sent')::boolean=sent),
 CHECK((kind='refund' AND order_line_id IS NULL) OR (kind='restock' AND order_line_id IS NOT NULL))
);
CREATE UNIQUE INDEX orders_return_actions_slot ON orders_return_actions(tenant_id,case_id,kind,COALESCE(order_line_id,'00000000-0000-0000-0000-000000000000'::uuid))
 WHERE sent OR state IN ('approval_required','approved','sending','uncertain','pending','verified');
CREATE INDEX orders_return_actions_case ON orders_return_actions(tenant_id,case_id,requested_at);
ALTER TABLE orders_return_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders_return_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON orders_return_actions TO luma_desk USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY reader ON orders_return_actions FOR SELECT TO luma_case_reader USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON orders_return_actions TO luma_desk;
GRANT UPDATE(state,sent,document) ON orders_return_actions TO luma_desk;
GRANT SELECT ON orders_return_actions TO luma_case_reader;
CREATE TRIGGER metric_change AFTER INSERT OR UPDATE OR DELETE ON orders_return_actions FOR EACH ROW EXECUTE FUNCTION notify_metric_change('orders,decisions');

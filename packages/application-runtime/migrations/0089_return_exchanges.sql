-- One tracked exchange holds its identity across replacement choices and uncertain writes.
CREATE TABLE orders_return_exchanges (
 tenant_id uuid NOT NULL,id uuid NOT NULL,case_id uuid NOT NULL,document jsonb NOT NULL,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,case_id),UNIQUE(tenant_id,id,case_id),
 FOREIGN KEY(tenant_id,case_id) REFERENCES orders_return_cases(tenant_id,id),
 CHECK(document->>'id'=id::text AND document->>'tenantId'=tenant_id::text AND document->>'caseId'=case_id::text)
);
CREATE TABLE orders_return_exchange_steps (
 tenant_id uuid NOT NULL,id uuid NOT NULL,operation_id uuid NOT NULL,case_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('request','process','cancel','release')),marker text NOT NULL,
 state text NOT NULL CHECK(state IN ('approval_required','approved','rejected','expired','sending','uncertain','verified','failed','not_executed')),
 sent boolean NOT NULL DEFAULT false,document jsonb NOT NULL,requested_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,operation_id,case_id) REFERENCES orders_return_exchanges(tenant_id,id,case_id),
 FOREIGN KEY(tenant_id,case_id) REFERENCES orders_return_cases(tenant_id,id),
 CHECK(document->>'id'=id::text AND document->>'tenantId'=tenant_id::text AND document->>'caseId'=case_id::text
 AND document->>'operationId'=operation_id::text AND document->'plan'->>'kind'=kind AND document->>'state'=state AND (document->>'sent')::boolean=sent)
);
CREATE UNIQUE INDEX orders_return_exchange_step_slot ON orders_return_exchange_steps(tenant_id,operation_id,kind,marker)
 WHERE sent OR state IN ('approval_required','approved','sending','uncertain','verified');
CREATE UNIQUE INDEX orders_return_exchange_process_once ON orders_return_exchange_steps(tenant_id,operation_id) WHERE kind='process' AND sent;
CREATE INDEX orders_return_exchange_steps_case ON orders_return_exchange_steps(tenant_id,case_id,requested_at);
ALTER TABLE orders_return_exchanges ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders_return_exchanges FORCE ROW LEVEL SECURITY;
ALTER TABLE orders_return_exchange_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders_return_exchange_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON orders_return_exchanges TO luma_desk USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_scope ON orders_return_exchange_steps TO luma_desk USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY order_reader ON orders_return_exchanges FOR SELECT TO luma_orders USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY order_reader ON orders_return_exchange_steps FOR SELECT TO luma_orders USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON orders_return_exchanges,orders_return_exchange_steps TO luma_desk;
GRANT UPDATE(document) ON orders_return_exchanges TO luma_desk;
GRANT UPDATE(state,sent,document) ON orders_return_exchange_steps TO luma_desk;
GRANT SELECT ON orders_return_exchanges,orders_return_exchange_steps TO luma_orders;
CREATE TRIGGER metric_change AFTER INSERT OR UPDATE OR DELETE ON orders_return_exchanges FOR EACH ROW EXECUTE FUNCTION notify_metric_change('orders,decisions');
CREATE TRIGGER metric_change AFTER INSERT OR UPDATE OR DELETE ON orders_return_exchange_steps FOR EACH ROW EXECUTE FUNCTION notify_metric_change('orders,decisions');

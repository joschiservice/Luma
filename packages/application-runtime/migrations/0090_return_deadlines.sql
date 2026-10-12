-- Policy versions remain immutable; waits retain earlier escalations and verified occurrences.
CREATE TABLE orders_return_deadline_policies (
 tenant_id uuid NOT NULL REFERENCES organizations(id), revision integer NOT NULL CHECK(revision>0),command_id uuid NOT NULL,digest text NOT NULL,document jsonb NOT NULL,
 PRIMARY KEY(tenant_id,revision),UNIQUE(tenant_id,command_id),CHECK((document->>'revision')::integer=revision)
);
CREATE TABLE orders_return_deadline_cursors (
 tenant_id uuid PRIMARY KEY REFERENCES organizations(id),last_case_id uuid
);
CREATE TABLE orders_return_waits (
 tenant_id uuid NOT NULL,id uuid NOT NULL,case_id uuid NOT NULL,phase text NOT NULL CHECK(phase IN('receipt','inspection','proposal','financial')),
 policy_revision integer NOT NULL,state text NOT NULL CHECK(state IN('waiting','escalated','verified','superseded','paused')),
 document jsonb NOT NULL,opened_at timestamptz NOT NULL,due_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,case_id) REFERENCES orders_return_cases(tenant_id,id),FOREIGN KEY(tenant_id,policy_revision) REFERENCES orders_return_deadline_policies(tenant_id,revision),
 CHECK(document->>'id'=id::text AND document->>'tenantId'=tenant_id::text AND document->>'caseId'=case_id::text AND document->>'phase'=phase AND document->>'state'=state AND (document->>'policyRevision')::integer=policy_revision)
);
CREATE UNIQUE INDEX orders_return_wait_live ON orders_return_waits(tenant_id,case_id,phase) WHERE state IN('waiting','escalated');
CREATE INDEX orders_return_wait_due ON orders_return_waits(tenant_id,due_at,id) WHERE state IN('waiting','escalated');
ALTER TABLE orders_return_deadline_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders_return_deadline_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE orders_return_deadline_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders_return_deadline_cursors FORCE ROW LEVEL SECURITY;
ALTER TABLE orders_return_waits ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders_return_waits FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON orders_return_deadline_policies TO luma_desk USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_scope ON orders_return_deadline_cursors TO luma_desk USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_scope ON orders_return_waits TO luma_desk USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON orders_return_deadline_policies,orders_return_deadline_cursors,orders_return_waits TO luma_desk;
GRANT UPDATE(last_case_id) ON orders_return_deadline_cursors TO luma_desk;
GRANT UPDATE(state,document) ON orders_return_waits TO luma_desk;
CREATE TRIGGER metric_change AFTER INSERT OR UPDATE OR DELETE ON orders_return_deadline_policies FOR EACH ROW EXECUTE FUNCTION notify_metric_change('orders,decisions');
CREATE TRIGGER metric_change AFTER INSERT OR UPDATE OR DELETE ON orders_return_waits FOR EACH ROW EXECUTE FUNCTION notify_metric_change('orders,decisions');

-- Monitor bookkeeping makes no business-state or provider-freshness claim.
CREATE TABLE orders_return_deadline_checks (
 tenant_id uuid NOT NULL,case_id uuid NOT NULL,policy_revision integer NOT NULL,checked_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,case_id),FOREIGN KEY(tenant_id,case_id) REFERENCES orders_return_cases(tenant_id,id),FOREIGN KEY(tenant_id,policy_revision) REFERENCES orders_return_deadline_policies(tenant_id,revision)
);
ALTER TABLE orders_return_deadline_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders_return_deadline_checks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON orders_return_deadline_checks TO luma_desk USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON orders_return_deadline_checks TO luma_desk;
GRANT UPDATE(policy_revision,checked_at) ON orders_return_deadline_checks TO luma_desk;
CREATE INDEX orders_return_deadline_case_scan ON orders_return_cases(tenant_id,id) WHERE state='open';

-- Return cases: Luma's own record of a return with people's receipt, inspection and resolution
-- decisions, its append-only history, and requests to create the return in the order's system.
-- Orders owns every write; store return records stay in orders_returns.

CREATE TABLE orders_return_cases (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 order_id uuid NOT NULL,
 connection_id uuid NOT NULL,
 source_return_id uuid,
 state text NOT NULL CHECK(state IN ('open','cancelled')),
 revision integer NOT NULL CHECK(revision>0),
 document jsonb NOT NULL,
 opened_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,order_id) REFERENCES orders_entities(tenant_id,id),
 FOREIGN KEY(tenant_id,source_return_id) REFERENCES orders_entities(tenant_id,id),
 CHECK(document->>'id'=id::text AND document->>'tenantId'=tenant_id::text
  AND document->>'orderId'=order_id::text AND document->>'connectionId'=connection_id::text
  AND document->>'state'=state AND (document->>'revision')::integer=revision)
);
-- One open case works a store return; cancelled cases stay as history.
CREATE UNIQUE INDEX orders_return_cases_source ON orders_return_cases(tenant_id,source_return_id)
 WHERE source_return_id IS NOT NULL AND state='open';
CREATE INDEX orders_return_cases_order ON orders_return_cases(tenant_id,order_id,opened_at);

CREATE TABLE orders_return_case_events (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 case_id uuid NOT NULL,
 -- The command that caused the entry; an exact retry finds it instead of writing again.
 command_id uuid NOT NULL,
 digest text NOT NULL CHECK(length(digest) BETWEEN 1 AND 200),
 kind text NOT NULL CHECK(kind IN ('opened','assigned','receipt_recorded','inspection_recorded',
  'resolution_proposed','cancelled','creation_requested','creation_approved','creation_rejected',
  'creation_created')),
 actor_id text NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 document jsonb NOT NULL,
 occurred_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,command_id),
 FOREIGN KEY(tenant_id,case_id) REFERENCES orders_return_cases(tenant_id,id),
 CHECK(document->>'id'=id::text AND document->>'caseId'=case_id::text AND document->>'kind'=kind)
);
CREATE INDEX orders_return_case_events_case ON orders_return_case_events(tenant_id,case_id,occurred_at);

CREATE TABLE orders_return_creations (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 case_id uuid NOT NULL,
 connection_id uuid NOT NULL,
 state text NOT NULL CHECK(state IN ('approval_required','approved','rejected','expired','sending',
  'uncertain','created','failed','not_executed')),
 principal_id text NOT NULL,
 document jsonb NOT NULL,
 created_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,case_id) REFERENCES orders_return_cases(tenant_id,id),
 CHECK(document->>'id'=id::text AND document->>'tenantId'=tenant_id::text
  AND document->>'caseId'=case_id::text AND document->>'state'=state)
);
-- At most one request per case is live or created; ended attempts stay as history.
CREATE UNIQUE INDEX orders_return_creations_live ON orders_return_creations(tenant_id,case_id)
 WHERE state IN ('approval_required','approved','sending','uncertain','created');
CREATE INDEX orders_return_creations_case ON orders_return_creations(tenant_id,case_id,created_at DESC);

DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['orders_return_cases','orders_return_case_events','orders_return_creations'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('CREATE POLICY tenant_scope ON %I TO luma_desk USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',relation);
  EXECUTE format('CREATE POLICY reader ON %I FOR SELECT TO luma_case_reader USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')::uuid)',relation);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO luma_desk',relation);
  EXECUTE format('GRANT SELECT ON %I TO luma_case_reader',relation);
 END LOOP;
END $$;
-- History is append-only; cases and creations change only their state and document.
GRANT UPDATE(state,revision,document,updated_at) ON orders_return_cases TO luma_desk;
GRANT UPDATE(state,document) ON orders_return_creations TO luma_desk;

CREATE TRIGGER metric_change AFTER INSERT OR UPDATE OR DELETE ON orders_return_cases
 FOR EACH ROW EXECUTE FUNCTION notify_metric_change('orders');
CREATE TRIGGER metric_change AFTER INSERT OR UPDATE OR DELETE ON orders_return_case_events
 FOR EACH ROW EXECUTE FUNCTION notify_metric_change('orders');
CREATE TRIGGER metric_change AFTER INSERT OR UPDATE OR DELETE ON orders_return_creations
 FOR EACH ROW EXECUTE FUNCTION notify_metric_change('orders,decisions');

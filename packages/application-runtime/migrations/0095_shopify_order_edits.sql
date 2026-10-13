-- Shopify order quantity edits: immutable previews, per-order claims, allowlisted evidence and
-- the one-shot commit fence. Shopify offers no idempotency key for order edits, so the fence is
-- what keeps a commit from being sent twice across retries and restarts.
CREATE TABLE shopify_order_edits (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 connection_id uuid NOT NULL,
 order_id text NOT NULL,
 revision text NOT NULL,
 document jsonb NOT NULL,
 decision_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES connector_installations(tenant_id,id),
 CHECK(document->>'tenantId'=tenant_id::text AND document->>'id'=id::text)
);
CREATE INDEX shopify_order_edits_target ON shopify_order_edits(tenant_id,connection_id,order_id,created_at DESC);
CREATE INDEX shopify_order_edits_recent ON shopify_order_edits(tenant_id,created_at DESC);

-- One claim per order revision; the store also refuses a second unsettled claim per order.
CREATE TABLE shopify_order_edit_claims (
 tenant_id uuid NOT NULL,
 connection_id uuid NOT NULL,
 order_id text NOT NULL,
 revision text NOT NULL,
 run_id uuid NOT NULL,
 settled boolean NOT NULL DEFAULT false,
 PRIMARY KEY(tenant_id,connection_id,order_id,revision),
 FOREIGN KEY(tenant_id,run_id) REFERENCES shopify_order_edits(tenant_id,id)
);
CREATE INDEX shopify_order_edit_claims_run ON shopify_order_edit_claims(tenant_id,run_id);
CREATE INDEX shopify_order_edit_claims_open ON shopify_order_edit_claims(tenant_id,connection_id,order_id) WHERE NOT settled;

-- `sent_at` is written before the commit request leaves Luma and is never cleared. Reserved
-- operations either send once or are withheld; a sent commit ends accepted or rejected, or stays
-- sent until independent reads reconcile it.
CREATE TABLE shopify_order_edit_fences (
 tenant_id uuid NOT NULL,
 run_id uuid NOT NULL,
 state text NOT NULL CHECK(state IN ('reserved','sent','accepted','withheld','rejected')),
 sent_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,run_id),
 FOREIGN KEY(tenant_id,run_id) REFERENCES shopify_order_edits(tenant_id,id),
 CHECK((state IN ('reserved','withheld')) = (sent_at IS NULL))
);

CREATE FUNCTION shopify_order_edit_fence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT ((OLD.state = 'reserved' AND NEW.state IN ('sent','withheld'))
       OR (OLD.state = 'sent' AND NEW.state IN ('accepted','rejected')))
     OR (OLD.sent_at IS NOT NULL AND NEW.sent_at IS DISTINCT FROM OLD.sent_at) THEN
    RAISE EXCEPTION 'Invalid order edit fence transition from % to %', OLD.state, NEW.state;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fence_guard BEFORE UPDATE ON shopify_order_edit_fences
 FOR EACH ROW EXECUTE FUNCTION shopify_order_edit_fence_guard();

CREATE TABLE shopify_order_edit_evidence (
 tenant_id uuid NOT NULL,
 connection_id uuid NOT NULL,
 id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('observation','calculation','acceptance')),
 observed_at timestamptz NOT NULL,
 document jsonb NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES connector_installations(tenant_id,id)
);

GRANT SELECT,INSERT ON shopify_order_edits,shopify_order_edit_claims,shopify_order_edit_fences,shopify_order_edit_evidence TO luma_connectors;
GRANT UPDATE(decision_id) ON shopify_order_edits TO luma_connectors;
GRANT UPDATE(settled) ON shopify_order_edit_claims TO luma_connectors;
GRANT UPDATE(state,sent_at,updated_at) ON shopify_order_edit_fences TO luma_connectors;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['shopify_order_edits','shopify_order_edit_claims','shopify_order_edit_fences','shopify_order_edit_evidence'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format($policy$CREATE POLICY tenant_scope ON %I TO luma_connectors USING (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid)$policy$,name);
 END LOOP;
END $$;

-- Previews, claims and fences feed Needs you and live workflow views.
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['shopify_order_edits','shopify_order_edit_claims','shopify_order_edit_fences'] LOOP
  EXECUTE format('CREATE TRIGGER metric_change AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION notify_metric_change(%L)', name, 'workflows,decisions');
 END LOOP;
END $$;

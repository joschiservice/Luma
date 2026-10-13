-- Immutable reviewed changes and a durable one-shot dispatch fence. The provider offers no
-- idempotency key or atomic revision precondition; unknown writes remain claimed until verified.
CREATE TABLE starshipit_order_updates (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 connection_id uuid NOT NULL,
 order_id text NOT NULL,
 revision text NOT NULL,
 document jsonb NOT NULL,
 decision_id uuid,
 sent_at timestamptz,
 closed boolean NOT NULL DEFAULT false,
 settled boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES connector_installations(tenant_id,id),
 CHECK(document->>'tenantId'=tenant_id::text AND document->>'id'=id::text)
);
CREATE UNIQUE INDEX starshipit_order_updates_claim ON starshipit_order_updates(tenant_id,connection_id,order_id) WHERE NOT settled;
CREATE INDEX starshipit_order_updates_recent ON starshipit_order_updates(tenant_id,created_at DESC);
CREATE TABLE starshipit_order_update_evidence (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 connection_id uuid NOT NULL,
 observed_at timestamptz NOT NULL,
 document jsonb NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES connector_installations(tenant_id,id)
);
GRANT SELECT,INSERT ON starshipit_order_updates,starshipit_order_update_evidence TO luma_connectors;
GRANT UPDATE(decision_id,sent_at,closed,settled) ON starshipit_order_updates TO luma_connectors;
CREATE FUNCTION starshipit_order_update_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.sent_at IS NOT NULL AND NEW.sent_at IS DISTINCT FROM OLD.sent_at
    OR OLD.closed AND NOT NEW.closed
    OR OLD.settled AND NOT NEW.settled THEN
   RAISE EXCEPTION 'Invalid Starshipit update fence transition';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER dispatch_guard BEFORE UPDATE ON starshipit_order_updates FOR EACH ROW EXECUTE FUNCTION starshipit_order_update_guard();
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['starshipit_order_updates','starshipit_order_update_evidence'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format($policy$CREATE POLICY tenant_scope ON %I TO luma_connectors USING (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid)$policy$,name);
 END LOOP;
END $$;
CREATE TRIGGER metric_change AFTER INSERT OR UPDATE OR DELETE ON starshipit_order_updates FOR EACH ROW EXECUTE FUNCTION notify_metric_change('workflows,decisions');

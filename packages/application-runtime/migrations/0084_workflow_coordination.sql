-- Coordination retains input independently of Temporal wakeups and workflow step receipts.
CREATE TABLE workflow_events (
 tenant_id uuid NOT NULL REFERENCES organizations(id), source_id text NOT NULL,
 event_type text NOT NULL, correlation_key text NOT NULL, occurred_at timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(), document jsonb NOT NULL,
 PRIMARY KEY(tenant_id,source_id)
);
CREATE INDEX workflow_events_correlation ON workflow_events(tenant_id,event_type,correlation_key,occurred_at,source_id);
CREATE TABLE workflow_human_tasks (
 tenant_id uuid NOT NULL, run_id uuid NOT NULL, step_id text NOT NULL,
 state text NOT NULL CHECK(state IN ('open','answered','cancelled')),
 document jsonb NOT NULL,
 PRIMARY KEY(tenant_id,run_id,step_id),
 FOREIGN KEY(tenant_id,run_id) REFERENCES workflow_trigger_runs(tenant_id,id)
);
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['workflow_events','workflow_human_tasks'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format($policy$CREATE POLICY tenant_scope ON %I TO luma_desk USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)$policy$,name);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO luma_desk',name);
  EXECUTE format('CREATE TRIGGER metric_change AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION notify_metric_change(''workflows,decisions,issues'')',name);
 END LOOP;
END $$;
GRANT UPDATE(state,document) ON workflow_human_tasks TO luma_desk;
-- Cancellation follows the authoritative run, including cancellation before a task is answered.
CREATE FUNCTION cancel_workflow_human_tasks() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state='cancelled' THEN
  UPDATE workflow_human_tasks SET state='cancelled',document=jsonb_set(document,'{state}','"cancelled"')
  WHERE tenant_id=NEW.tenant_id AND run_id=NEW.id AND state='open';
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER cancel_human_tasks AFTER UPDATE OF state ON workflow_trigger_runs FOR EACH ROW EXECUTE FUNCTION cancel_workflow_human_tasks();

CREATE TABLE workflow_subscription_revisions (
 tenant_id uuid NOT NULL REFERENCES organizations(id), id uuid NOT NULL, revision integer NOT NULL CHECK(revision>0),
 definition_id text NOT NULL, document jsonb NOT NULL,
 PRIMARY KEY(tenant_id,id,revision)
);
CREATE TABLE workflow_subscription_heads (
 tenant_id uuid NOT NULL, id uuid NOT NULL, revision integer NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,id,revision) REFERENCES workflow_subscription_revisions(tenant_id,id,revision)
);
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['workflow_subscription_revisions','workflow_subscription_heads'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format($policy$CREATE POLICY tenant_scope ON %I TO luma_desk USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid)$policy$,name);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO luma_desk',name);
 END LOOP;
END $$;
GRANT UPDATE(revision) ON workflow_subscription_heads TO luma_desk;

-- The existing recovery pass also discovers committed coordination-only runs.
CREATE OR REPLACE FUNCTION code_process_worker_scopes() RETURNS TABLE(tenant_id uuid,principal_id text,definition_id text)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT DISTINCT r.tenant_id,r.document->'actor'->>'id',r.definition_id
 FROM public.workflow_trigger_runs r JOIN public.playbook_versions v
 ON v.tenant_id=r.tenant_id AND v.definition_id=r.definition_id AND v.version=r.version
 JOIN public.organizations o ON o.id=r.tenant_id AND o.status='active'
 WHERE r.state='awaiting_admission' AND v.document->>'format'='workflow/2'
 AND EXISTS (SELECT 1 FROM jsonb_array_elements(v.document->'steps') s WHERE s->>'kind' IN ('code','human_task','event_wait'))
 AND NOT EXISTS (SELECT 1 FROM public.workflow_process_steps p WHERE p.tenant_id=r.tenant_id AND p.run_id=r.id AND (p.document->>'kind'='end' OR p.state IN ('denied','failed','inconclusive','ended','escalated')))
 AND NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.tenant_id=r.tenant_id AND m.user_id::text=r.document->'actor'->>'id' AND m.status='suspended')
 AND NOT EXISTS (SELECT 1 FROM public.account_disablements d WHERE d.user_id::text=r.document->'actor'->>'id')
 AND NOT EXISTS (SELECT 1 FROM public.account_deletions x WHERE x.user_id::text=r.document->'actor'->>'id' AND x.status='erased')
$$;

CREATE FUNCTION cancel_case_human_tasks() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.state='resolved' THEN
  UPDATE public.workflow_human_tasks t SET state='cancelled',document=jsonb_set(t.document,'{state}','"cancelled"')
  FROM public.workflow_trigger_runs r WHERE r.tenant_id=t.tenant_id AND r.id=t.run_id
  AND t.tenant_id=NEW.tenant_id AND r.document->'context'->'inputs'->>'caseId'=NEW.id::text AND t.state='open';
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION cancel_case_human_tasks() FROM PUBLIC;
CREATE TRIGGER cancel_human_tasks AFTER UPDATE OF state ON exceptions FOR EACH ROW EXECUTE FUNCTION cancel_case_human_tasks();

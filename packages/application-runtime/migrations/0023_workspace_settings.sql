CREATE TABLE workspace_settings (
 tenant_id uuid PRIMARY KEY REFERENCES organizations(id), timezone text NOT NULL DEFAULT 'UTC',
 revision integer NOT NULL DEFAULT 0, always_require_approval boolean NOT NULL DEFAULT false,
 policy_revision integer NOT NULL DEFAULT 0
);
CREATE TABLE notification_preferences (
 tenant_id uuid NOT NULL REFERENCES organizations(id), user_id uuid NOT NULL REFERENCES users(id),
 issues boolean NOT NULL DEFAULT false, connections boolean NOT NULL DEFAULT false,
 revision integer NOT NULL DEFAULT 0, PRIMARY KEY(tenant_id,user_id)
);
CREATE TABLE workspace_invitations (
 tenant_id uuid NOT NULL REFERENCES organizations(id), id uuid NOT NULL,
 email text NOT NULL, role text NOT NULL CHECK(role IN ('admin','member')),
 status text NOT NULL CHECK(status IN ('pending','accepted','revoked')),
 generation integer NOT NULL DEFAULT 1, token_hash text NOT NULL,
 inviter_id uuid NOT NULL REFERENCES users(id), accepted_by uuid REFERENCES users(id),
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id)
);
CREATE UNIQUE INDEX workspace_pending_invitation ON workspace_invitations(tenant_id,email) WHERE status='pending';
CREATE TABLE workspace_commands (
 tenant_id uuid NOT NULL, id uuid NOT NULL, actor_id uuid NOT NULL,
 request jsonb NOT NULL, result jsonb NOT NULL, PRIMARY KEY(tenant_id,id)
);
CREATE TABLE workspace_access_events (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, actor_id uuid NOT NULL,
 event_type text NOT NULL, target_id text NOT NULL, before_value jsonb, after_value jsonb,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE workspace_mail (
 tenant_id uuid NOT NULL, id uuid NOT NULL, event_key text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('invitation','issues','connections','test')),
 user_id uuid, invitation_id uuid, generation integer, target_id uuid,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','sent','failed','cancelled')),
 attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
 first_attempt_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz,
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,event_key),
 FOREIGN KEY(tenant_id,invitation_id) REFERENCES workspace_invitations(tenant_id,id)
);
CREATE INDEX workspace_mail_due ON workspace_mail(next_attempt_at,tenant_id) WHERE state='queued';
GRANT SELECT,INSERT,UPDATE ON workspace_settings,notification_preferences,workspace_invitations,workspace_mail TO luma_identity;
GRANT SELECT,INSERT ON workspace_commands,workspace_access_events TO luma_identity;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['workspace_settings','notification_preferences','workspace_invitations','workspace_commands','workspace_access_events','workspace_mail'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format($policy$CREATE POLICY tenant_scope ON %I TO luma_identity USING (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid)$policy$,name);
 END LOOP;
END $$;
-- Discovery returns only tenant IDs with due work. Message contents remain tenant scoped.
CREATE FUNCTION workspace_mail_tenants() RETURNS TABLE(tenant_id uuid) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT DISTINCT m.tenant_id FROM public.workspace_mail m JOIN public.organizations o ON o.id=m.tenant_id WHERE m.state='queued' AND m.next_attempt_at<=now() AND o.status='active' AND o.data_region='EU' LIMIT 100;
$$;
REVOKE ALL ON FUNCTION workspace_mail_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workspace_mail_tenants() TO luma_identity;

-- Source commits enqueue only opted-in recipients, using immutable source identities.
CREATE FUNCTION enqueue_workspace_notification() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE category text := 'issues'; source_key text; target uuid;
BEGIN
 IF TG_TABLE_NAME='exceptions' THEN
  IF NEW.state NOT IN ('awaiting_approval','escalated') THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.state=NEW.state THEN RETURN NEW; END IF;
  target := NEW.id;
 ELSIF TG_TABLE_NAME='policy_decisions' THEN
  IF NEW.document->>'outcome'<>'approval_required' THEN RETURN NEW; END IF;
  SELECT p.exception_id INTO target FROM public.case_proposals p JOIN public.exceptions e ON e.tenant_id=p.tenant_id AND e.id=p.exception_id WHERE p.tenant_id=NEW.tenant_id AND p.id=NEW.proposal_id AND e.state<>'resolved';
 ELSIF TG_TABLE_NAME='exception_diagnosis_heads' THEN
  SELECT d.exception_id INTO target FROM public.exception_diagnoses d JOIN public.exceptions e ON e.tenant_id=d.tenant_id AND e.id=d.exception_id WHERE d.tenant_id=NEW.tenant_id AND d.exception_id=NEW.exception_id AND d.revision=NEW.revision AND e.state<>'resolved' AND d.document->>'status'='ready' AND d.document->'nextSteps' @> '[{"kind":"manual_intervention"}]'::jsonb;
 ELSIF TG_TABLE_NAME='exception_uncertainty' THEN
  IF NOT NEW.review_required THEN RETURN NEW; END IF;
  SELECT id INTO target FROM public.exceptions WHERE tenant_id=NEW.tenant_id AND fingerprint=NEW.fingerprint AND state<>'resolved';
 ELSE
  IF NEW.status NOT IN ('degraded','revoked') THEN RETURN NEW; END IF;
  category := 'connections'; target := NEW.connection_id; source_key := 'connection:'||NEW.connection_id::text||':'||NEW.version::text;
 END IF;
 IF target IS NULL THEN RETURN NEW; END IF;
 IF category='issues' THEN source_key := 'issue:'||target::text||':attention'; END IF;
 INSERT INTO public.workspace_mail(tenant_id,id,event_key,kind,user_id,target_id)
 SELECT NEW.tenant_id,gen_random_uuid(),source_key||':'||p.user_id::text,category,p.user_id,target
 FROM public.notification_preferences p JOIN public.memberships m ON m.tenant_id=p.tenant_id AND m.user_id=p.user_id
 WHERE p.tenant_id=NEW.tenant_id AND CASE WHEN category='issues' THEN p.issues ELSE p.connections END
 ON CONFLICT(tenant_id,event_key) DO NOTHING;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION enqueue_workspace_notification() FROM PUBLIC;
DO $$ BEGIN
 IF to_regclass('exceptions') IS NOT NULL THEN
  CREATE TRIGGER workspace_issue_notification AFTER INSERT OR UPDATE ON exceptions FOR EACH ROW EXECUTE FUNCTION enqueue_workspace_notification();
 END IF;
 IF to_regclass('policy_decisions') IS NOT NULL THEN
  CREATE TRIGGER workspace_approval_notification AFTER INSERT ON policy_decisions FOR EACH ROW EXECUTE FUNCTION enqueue_workspace_notification();
  CREATE TRIGGER workspace_manual_notification AFTER INSERT OR UPDATE ON exception_diagnosis_heads FOR EACH ROW EXECUTE FUNCTION enqueue_workspace_notification();
  CREATE TRIGGER workspace_uncertainty_notification AFTER INSERT OR UPDATE ON exception_uncertainty FOR EACH ROW EXECUTE FUNCTION enqueue_workspace_notification();
 END IF;
 IF to_regclass('connector_lifecycle_events') IS NOT NULL THEN
  CREATE TRIGGER workspace_connection_notification AFTER INSERT ON connector_lifecycle_events FOR EACH ROW EXECUTE FUNCTION enqueue_workspace_notification();
 END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='luma_policies') THEN
  GRANT SELECT ON workspace_settings TO luma_policies;
  CREATE POLICY policy_reads ON workspace_settings FOR SELECT TO luma_policies USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
 END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='luma_desk') THEN
  GRANT SELECT ON workspace_access_events,workspace_settings TO luma_desk;
  CREATE POLICY desk_settings_reads ON workspace_settings FOR SELECT TO luma_desk USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
  CREATE POLICY desk_access_reads ON workspace_access_events FOR SELECT TO luma_desk USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
 END IF;
END $$;

-- Reservation and settings changes use the same fence across API and worker processes.
CREATE FUNCTION fence_workspace_policy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE revision integer; decision_version text; expected text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('exceptions:'||NEW.tenant_id::text,0));
 SELECT COALESCE(policy_revision,0) INTO revision FROM workspace_settings WHERE tenant_id=NEW.tenant_id;
 expected := 'v0.1'||CASE WHEN COALESCE(revision,0)=0 THEN '' ELSE ':workspace:'||revision::text END;
 SELECT document->>'policyVersion' INTO decision_version FROM policy_decisions WHERE tenant_id=NEW.tenant_id AND id=(NEW.document->'attempt'->>'policyDecisionId')::uuid;
 IF decision_version IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Workspace policy changed before reservation'; END IF;
 RETURN NEW;
END $$;
DO $$ BEGIN
 IF to_regclass('executed_actions') IS NOT NULL THEN
  GRANT SELECT ON workspace_settings TO luma_execution;
  CREATE POLICY execution_settings_reads ON workspace_settings FOR SELECT TO luma_execution USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
  CREATE TRIGGER workspace_policy_fence BEFORE INSERT ON executed_actions FOR EACH ROW EXECUTE FUNCTION fence_workspace_policy();
 END IF;
END $$;

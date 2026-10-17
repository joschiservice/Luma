-- Connection mail announces a change into degraded or revoked. Later lifecycle events of a
-- connection that stays in that state, such as a new webhook secret, send nothing.
CREATE OR REPLACE FUNCTION enqueue_workspace_notification() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
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
  IF (SELECT l.status FROM public.connector_lifecycle_events l WHERE l.tenant_id=NEW.tenant_id AND l.connection_id=NEW.connection_id AND l.version<NEW.version ORDER BY l.version DESC LIMIT 1) IS NOT DISTINCT FROM NEW.status THEN RETURN NEW; END IF;
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

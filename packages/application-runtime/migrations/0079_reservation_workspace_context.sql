-- The effective approval rule is read for the session's workspace. A reservation written in
-- another workspace's context, or none, cannot be checked against it, so it is refused rather
-- than checked against the rule for no workspace.
CREATE OR REPLACE FUNCTION fence_workspace_policy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE revision integer; decision_version text; expected text;
BEGIN
 IF NULLIF(current_setting('app.tenant_id',true),'')::uuid IS DISTINCT FROM NEW.tenant_id THEN
  RAISE EXCEPTION 'Reservation requires its workspace context' USING ERRCODE='42501';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('exceptions:'||NEW.tenant_id::text,0));
 SELECT policy_revision INTO revision FROM workspace_settings WHERE tenant_id=NEW.tenant_id;
 expected := 'v0.1'||CASE WHEN COALESCE(revision,0)=0 THEN '' ELSE ':workspace:'||revision::text END
  ||CASE WHEN workspace_requires_independent_approval() THEN '' ELSE ':self-approval' END;
 SELECT document->>'policyVersion' INTO decision_version FROM policy_decisions WHERE tenant_id=NEW.tenant_id AND id=(NEW.document->'attempt'->>'policyDecisionId')::uuid;
 IF decision_version IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Workspace policy changed before reservation'; END IF;
 RETURN NEW;
END $$;

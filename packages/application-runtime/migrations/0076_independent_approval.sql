ALTER TABLE workspace_settings ADD COLUMN require_independent_approval boolean NOT NULL DEFAULT true;

-- Count only people who can still enter this workspace. The reader owns no writes and
-- reads memberships through tenant RLS; callers cannot supply a different tenant.
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='luma_workspace_policy_reader') THEN CREATE ROLE luma_workspace_policy_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO luma_workspace_policy_reader;
GRANT SELECT(tenant_id,user_id,status) ON memberships TO luma_workspace_policy_reader;
GRANT SELECT(user_id) ON account_disablements TO luma_workspace_policy_reader;
CREATE POLICY workspace_policy_members ON memberships FOR SELECT TO luma_workspace_policy_reader
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE FUNCTION workspace_active_member_count() RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT count(*)::integer FROM public.memberships m
 WHERE m.tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid AND m.status='active'
 AND NOT EXISTS(SELECT FROM public.account_disablements d WHERE d.user_id=m.user_id);
$$;
ALTER FUNCTION workspace_active_member_count() OWNER TO luma_workspace_policy_reader;
REVOKE ALL ON FUNCTION workspace_active_member_count() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workspace_active_member_count() TO luma_identity,luma_policies,luma_execution,luma_desk;

-- Expose only the effective rule to operational readers, without membership identities.
GRANT SELECT(tenant_id,require_independent_approval) ON workspace_settings TO luma_workspace_policy_reader;
CREATE POLICY workspace_policy_settings ON workspace_settings FOR SELECT TO luma_workspace_policy_reader
 USING(tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE FUNCTION workspace_requires_independent_approval() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT COALESCE((SELECT s.require_independent_approval FROM public.workspace_settings s
 WHERE s.tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid),true)
 AND public.workspace_active_member_count()>1;
$$;
ALTER FUNCTION workspace_requires_independent_approval() OWNER TO luma_workspace_policy_reader;
REVOKE ALL ON FUNCTION workspace_requires_independent_approval() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workspace_requires_independent_approval() TO luma_identity,luma_policies,luma_execution,luma_desk,luma_case_reader;

-- Bind reservations to the effective rule, including the automatic single-member exception.
CREATE OR REPLACE FUNCTION fence_workspace_policy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE revision integer; decision_version text; expected text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('exceptions:'||NEW.tenant_id::text,0));
 SELECT policy_revision INTO revision FROM workspace_settings WHERE tenant_id=NEW.tenant_id;
 expected := 'v0.1'||CASE WHEN COALESCE(revision,0)=0 THEN '' ELSE ':workspace:'||revision::text END
  ||CASE WHEN workspace_requires_independent_approval() THEN '' ELSE ':self-approval' END;
 SELECT document->>'policyVersion' INTO decision_version FROM policy_decisions WHERE tenant_id=NEW.tenant_id AND id=(NEW.document->'attempt'->>'policyDecisionId')::uuid;
 IF decision_version IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Workspace policy changed before reservation'; END IF;
 RETURN NEW;
END $$;


-- Self-responses are valid only when bound to a policy version that permits them.
ALTER TABLE policy_approvals DROP CONSTRAINT policy_approvals_document_check1;
ALTER TABLE policy_approvals ADD CONSTRAINT policy_approvals_document_check1
 CHECK(COALESCE(document->>'approverId' <> document->>'requesterId',false)
 OR (document->>'approverId' IS NOT NULL AND document->>'requesterId' IS NOT NULL AND policy_version LIKE '%:self-approval'));

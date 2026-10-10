-- Membership status. Suspension keeps the membership, its role and the account; tenant resolution
-- rejects it until the membership is reactivated. Who suspended it is recorded by kind: Luma staff
-- (a staff user ID) or a customer (a member's user ID).
ALTER TABLE memberships
 ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')),
 ADD COLUMN suspended_at timestamptz,
 ADD COLUMN suspended_by_kind text CHECK(suspended_by_kind IN ('staff','customer')),
 ADD COLUMN suspended_by uuid,
 ADD COLUMN suspension_reason text CHECK(length(suspension_reason) BETWEEN 10 AND 500),
 ADD CONSTRAINT memberships_suspension CHECK(CASE status
  WHEN 'active' THEN suspended_at IS NULL AND suspended_by_kind IS NULL AND suspended_by IS NULL AND suspension_reason IS NULL
  ELSE suspended_at IS NOT NULL AND suspended_by_kind IS NOT NULL AND suspended_by IS NOT NULL
   AND (suspended_by_kind<>'staff' OR suspension_reason IS NOT NULL) END);
CREATE INDEX memberships_suspended ON memberships(tenant_id) WHERE status='suspended';

-- Access events record whether a customer or Luma staff made the change. Staff changes use the
-- nil UUID as actor; the staff identity stays in the staff audit.
ALTER TABLE workspace_access_events ADD COLUMN actor_kind text NOT NULL DEFAULT 'member' CHECK(actor_kind IN ('member','staff'));

-- Membership commands are a separate staff permission. Keep this list equal to the staff catalog.
ALTER TABLE staff_access DROP CONSTRAINT staff_access_permissions_check;
ALTER TABLE staff_access ADD CONSTRAINT staff_access_permissions_check CHECK(permissions <@ ARRAY['staff.directory.read','staff.workspace.inspect','staff.sessions.revoke','staff.audit.read','staff.accounts.inspect','staff.memberships.manage']::text[]);

-- Staff read membership status on the workspace and account pages.
GRANT SELECT(status,suspended_at,suspended_by_kind) ON memberships TO luma_staff_runtime;
GRANT SELECT(status) ON memberships TO luma_staff_views;
CREATE OR REPLACE VIEW staff_account_workspaces WITH (security_barrier=true) AS
SELECT m.user_id,o.id,o.name,o.slug,o.status,o.data_region,m.role,r.name AS custom_role_name,m.created_at AS joined_at,m.status AS membership_status
FROM memberships m JOIN organizations o ON o.id=m.tenant_id LEFT JOIN workspace_roles r ON r.tenant_id=m.tenant_id AND r.id=m.custom_role_id
WHERE public.staff_has_account_access(m.user_id);

-- Staff access history names staff changes as Luma support.
GRANT SELECT(actor_kind) ON workspace_access_events TO luma_staff_views;
CREATE OR REPLACE VIEW staff_access_history AS
SELECT e.tenant_id,e.id,left(e.event_type,100) AS event_type,left(e.target_id,200) AS target_id,e.actor_id,
 actor.name AS actor_name,actor.is_member AS actor_member,
 CASE WHEN COALESCE(e.after_value->>'userId',e.before_value->>'userId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  THEN COALESCE(e.after_value->>'userId',e.before_value->>'userId')::uuid END AS subject_id,
 subject.name AS subject_name,subject.is_member AS subject_member,
 left(CASE
  WHEN e.event_type='role.app_permissions_removed' THEN 'App '||(e.after_value->'cause'->>'appId')||' uninstalled'
  WHEN e.event_type LIKE 'role.%' THEN COALESCE(e.after_value->>'name',e.before_value->>'name')
  WHEN e.event_type='member.update' THEN NULLIF(concat_ws(' → ',
   COALESCE(e.before_value->>'roleName',CASE WHEN jsonb_typeof(e.before_value->'role')='string' THEN e.before_value->>'role' END),
   COALESCE(e.after_value->>'roleName',CASE WHEN jsonb_typeof(e.after_value->'role')='string' THEN e.after_value->>'role' END)),'')
  WHEN e.event_type LIKE 'member.%' OR e.event_type LIKE 'invitation.%' THEN COALESCE(
   COALESCE(e.after_value->>'roleName',CASE WHEN jsonb_typeof(e.after_value->'role')='string' THEN e.after_value->>'role' END),
   COALESCE(e.before_value->>'roleName',CASE WHEN jsonb_typeof(e.before_value->'role')='string' THEN e.before_value->>'role' END))
  WHEN e.event_type='policy.updated' THEN CASE e.after_value->>'required' WHEN 'true' THEN 'Approval always required' WHEN 'false' THEN 'Approval follows the workspace policy' END
  WHEN e.event_type='workspace.updated' THEN e.after_value->>'name'
 END,200) AS summary,
 e.created_at,to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')||'_'||e.id::text AS cursor,
 e.actor_kind
FROM workspace_access_events e
LEFT JOIN workspace_people actor ON actor.tenant_id=e.tenant_id AND actor.user_id=e.actor_id
LEFT JOIN workspace_people subject ON subject.tenant_id=e.tenant_id
 AND subject.user_id=CASE WHEN COALESCE(e.after_value->>'userId',e.before_value->>'userId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  THEN COALESCE(e.after_value->>'userId',e.before_value->>'userId')::uuid END
WHERE e.tenant_id=(SELECT public.staff_inspected_workspace());

-- Staff membership commands. Receipts make exact retries return the original result.
CREATE TABLE identity_support_membership_commands (
 command_id uuid PRIMARY KEY,
 staff_user_id uuid NOT NULL,
 tenant_id uuid NOT NULL,
 user_id uuid NOT NULL,
 membership_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('suspend','reactivate')),
 reason text NOT NULL,
 last_owner_acknowledged boolean NOT NULL,
 last_active_owner boolean NOT NULL,
 completed_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT,INSERT ON identity_support_membership_commands TO luma_identity_support;
GRANT SELECT(custom_role_id,status),UPDATE(status,suspended_at,suspended_by_kind,suspended_by,suspension_reason) ON memberships TO luma_identity_support;
CREATE POLICY staff_membership_status ON memberships FOR UPDATE TO luma_identity_support
 USING(public.staff_has_workspace_access(tenant_id)) WITH CHECK(public.staff_has_workspace_access(tenant_id));
GRANT SELECT(tenant_id,id,name) ON workspace_roles TO luma_identity_support;
CREATE POLICY staff_membership_role ON workspace_roles FOR SELECT TO luma_identity_support USING(public.staff_has_workspace_access(tenant_id));
GRANT INSERT ON workspace_access_events TO luma_identity_support;
CREATE POLICY staff_membership_event ON workspace_access_events FOR INSERT TO luma_identity_support
 WITH CHECK(actor_kind='staff' AND public.staff_has_workspace_access(tenant_id));

-- Suspends or reactivates one membership. Checks the staff permission, a current workspace grant
-- and a staff sign-in within fifteen minutes. The receipt, membership change, customer access
-- event and staff audit commit together. Suspending the only active owner requires
-- `acknowledge_last_owner`. Errors: 42501 access, 22023 reason, 23505 command reuse,
-- P0002 no membership, 55000 state conflict (message `already suspended`, `already active` or
-- `last active owner`).
CREATE FUNCTION identity_support_change_membership(command uuid,target_tenant uuid,target_user uuid,action_name text,reason_text text,acknowledge_last_owner boolean,request_text text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
 actor uuid:=NULLIF(current_setting('staff.user_id',true),'')::uuid;
 staff_session uuid:=NULLIF(current_setting('staff.session_id',true),'')::uuid;
 receipt public.identity_support_membership_commands%ROWTYPE;
 target record;
 sole_owner boolean;
 role_name text;
 next_status text:=CASE action_name WHEN 'suspend' THEN 'suspended' ELSE 'active' END;
BEGIN
 PERFORM 1 FROM public.staff_access a JOIN public.staff_users u ON lower(u.email)=a.email WHERE u.id=actor FOR SHARE OF a;
 PERFORM 1 FROM public.staff_sessions WHERE id=staff_session AND user_id=actor FOR SHARE;
 PERFORM 1 FROM public.staff_support_grants WHERE id=NULLIF(current_setting('staff.grant_id',true),'')::uuid AND staff_user_id=actor FOR SHARE;
 -- Customer membership changes serialize on the same organization row.
 PERFORM 1 FROM public.organizations WHERE id=target_tenant FOR UPDATE;
 PERFORM pg_advisory_xact_lock(hashtextextended(command::text,0));
 IF action_name NOT IN ('suspend','reactivate') THEN RAISE EXCEPTION 'invalid action' USING ERRCODE='22023'; END IF;
 IF NOT public.staff_has_access('staff.memberships.manage') OR NOT public.staff_has_workspace_access(target_tenant) OR NOT EXISTS(SELECT FROM public.staff_sessions WHERE id=staff_session AND created_at>clock_timestamp()-interval '15 minutes') THEN RAISE EXCEPTION 'staff access denied' USING ERRCODE='42501'; END IF;
 IF reason_text IS NULL OR length(trim(reason_text)) NOT BETWEEN 10 AND 500 THEN RAISE EXCEPTION 'invalid reason' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT FROM public.organizations WHERE id=target_tenant AND data_region='EU') THEN RAISE EXCEPTION 'region unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO receipt FROM public.identity_support_membership_commands WHERE command_id=command;
 IF FOUND THEN
  IF receipt.staff_user_id<>actor OR receipt.tenant_id<>target_tenant OR receipt.user_id<>target_user OR receipt.action<>action_name OR receipt.reason<>reason_text OR receipt.last_owner_acknowledged<>acknowledge_last_owner THEN RAISE EXCEPTION 'command conflict' USING ERRCODE='23505'; END IF;
 ELSE
  IF EXISTS(SELECT FROM public.identity_support_commands WHERE command_id=command) THEN RAISE EXCEPTION 'command conflict' USING ERRCODE='23505'; END IF;
  -- The support role reads only these columns.
  SELECT m.id,m.user_id,m.role,m.custom_role_id,m.status INTO target FROM public.memberships m WHERE m.tenant_id=target_tenant AND m.user_id=target_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'member unavailable' USING ERRCODE='P0002'; END IF;
  IF target.status=next_status THEN RAISE EXCEPTION '%', CASE next_status WHEN 'suspended' THEN 'already suspended' ELSE 'already active' END USING ERRCODE='55000'; END IF;
  sole_owner:=action_name='suspend' AND target.role='owner' AND NOT EXISTS(SELECT FROM public.memberships WHERE tenant_id=target_tenant AND role='owner' AND status='active' AND id<>target.id);
  IF sole_owner AND NOT acknowledge_last_owner THEN RAISE EXCEPTION 'last active owner' USING ERRCODE='55000'; END IF;
  IF action_name='suspend' THEN
   UPDATE public.memberships SET status='suspended',suspended_at=now(),suspended_by_kind='staff',suspended_by=actor,suspension_reason=reason_text WHERE id=target.id;
  ELSE
   UPDATE public.memberships SET status='active',suspended_at=NULL,suspended_by_kind=NULL,suspended_by=NULL,suspension_reason=NULL WHERE id=target.id;
  END IF;
  role_name:=CASE target.role WHEN 'owner' THEN 'Owner' WHEN 'admin' THEN 'Admin' WHEN 'member' THEN 'Member'
   ELSE (SELECT r.name FROM public.workspace_roles r WHERE r.tenant_id=target_tenant AND r.id=target.custom_role_id) END;
  INSERT INTO public.workspace_access_events(id,tenant_id,actor_id,actor_kind,event_type,target_id,before_value,after_value)
  VALUES(gen_random_uuid(),target_tenant,'00000000-0000-0000-0000-000000000000','staff',
   CASE action_name WHEN 'suspend' THEN 'member.suspended' ELSE 'member.reactivated' END,target.id::text,
   jsonb_build_object('id',target.id,'userId',target.user_id,'roleId',COALESCE(target.custom_role_id::text,target.role),'roleName',role_name,'status',target.status),
   jsonb_build_object('id',target.id,'userId',target.user_id,'roleId',COALESCE(target.custom_role_id::text,target.role),'roleName',role_name,'status',next_status));
  INSERT INTO public.identity_support_membership_commands(command_id,staff_user_id,tenant_id,user_id,membership_id,action,reason,last_owner_acknowledged,last_active_owner)
  VALUES(command,actor,target_tenant,target_user,target.id,action_name,reason_text,acknowledge_last_owner,sole_owner) RETURNING * INTO receipt;
  INSERT INTO public.staff_audit(staff_user_id,staff_session_id,tenant_id,event,request_id,reason,details)
  VALUES(actor,staff_session,target_tenant,CASE action_name WHEN 'suspend' THEN 'customer.membership.suspended' ELSE 'customer.membership.reactivated' END,request_text,reason_text,
   jsonb_build_object('commandId',command,'userId',target_user,'membershipId',target.id,'role',COALESCE(target.custom_role_id::text,target.role),'lastActiveOwner',sole_owner));
 END IF;
 RETURN jsonb_build_object('commandId',receipt.command_id,'membershipId',receipt.membership_id,'status',CASE receipt.action WHEN 'suspend' THEN 'suspended' ELSE 'active' END,'lastActiveOwner',receipt.last_active_owner,'completedAt',receipt.completed_at);
END $$;
ALTER FUNCTION identity_support_change_membership(uuid,uuid,uuid,text,text,boolean,text) OWNER TO luma_identity_support;
REVOKE ALL ON FUNCTION identity_support_change_membership(uuid,uuid,uuid,text,text,boolean,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity_support_change_membership(uuid,uuid,uuid,text,text,boolean,text) TO luma_staff_runtime;

-- A command ID names one staff command: session revocation also rejects membership receipts.
CREATE OR REPLACE FUNCTION identity_support_revoke_sessions(command uuid,target_tenant uuid,target_user uuid,reason_text text,request_text text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=NULLIF(current_setting('staff.user_id',true),'')::uuid; receipt public.identity_support_commands%ROWTYPE; amount integer;
BEGIN
 PERFORM 1 FROM public.staff_access a JOIN public.staff_users u ON lower(u.email)=a.email WHERE u.id=actor FOR SHARE OF a;
 PERFORM 1 FROM public.staff_sessions WHERE id=NULLIF(current_setting('staff.session_id',true),'')::uuid AND user_id=actor FOR SHARE;
 PERFORM 1 FROM public.staff_support_grants WHERE id=NULLIF(current_setting('staff.grant_id',true),'')::uuid AND staff_user_id=actor FOR SHARE;
 PERFORM 1 FROM public.organizations WHERE id=target_tenant FOR UPDATE;
 PERFORM pg_advisory_xact_lock(hashtextextended(command::text,0));
 IF NOT public.staff_has_access('staff.sessions.revoke') OR NOT public.staff_has_workspace_access(target_tenant) OR NOT EXISTS(SELECT FROM public.staff_sessions WHERE id=NULLIF(current_setting('staff.session_id',true),'')::uuid AND created_at>clock_timestamp()-interval '15 minutes') THEN RAISE EXCEPTION 'staff access denied' USING ERRCODE='42501'; END IF;
 IF reason_text IS NULL OR length(trim(reason_text)) NOT BETWEEN 10 AND 500 THEN RAISE EXCEPTION 'invalid reason' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT FROM public.organizations WHERE id=target_tenant AND data_region='EU') THEN RAISE EXCEPTION 'region unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO receipt FROM public.identity_support_commands WHERE command_id=command;
 IF FOUND THEN
  IF receipt.staff_user_id<>actor OR receipt.tenant_id<>target_tenant OR receipt.user_id<>target_user OR receipt.reason<>reason_text THEN RAISE EXCEPTION 'command conflict' USING ERRCODE='23505'; END IF;
 ELSE
  IF EXISTS(SELECT FROM public.identity_support_membership_commands WHERE command_id=command) THEN RAISE EXCEPTION 'command conflict' USING ERRCODE='23505'; END IF;
  IF NOT EXISTS(SELECT FROM public.memberships WHERE tenant_id=target_tenant AND user_id=target_user) THEN RAISE EXCEPTION 'member unavailable' USING ERRCODE='P0002'; END IF;
  DELETE FROM public.sessions WHERE user_id=target_user; GET DIAGNOSTICS amount=ROW_COUNT;
  INSERT INTO public.identity_support_commands(command_id,staff_user_id,tenant_id,user_id,reason,revoked_sessions) VALUES(command,actor,target_tenant,target_user,reason_text,amount) RETURNING * INTO receipt;
  INSERT INTO public.staff_audit(staff_user_id,staff_session_id,tenant_id,event,request_id,reason,details) VALUES(actor,NULLIF(current_setting('staff.session_id',true),'')::uuid,target_tenant,'customer.sessions.revoked',request_text,reason_text,jsonb_build_object('commandId',command,'userId',target_user,'revokedSessions',amount,'scope','global-account'));
  INSERT INTO public.account_security_events(id,user_id,event_type,outcome,reason_code,request_id,staff_command_id) VALUES(gen_random_uuid(),target_user,'sessions.revoked-by-staff','succeeded','all',left(request_text,200),command);
 END IF;
 RETURN jsonb_build_object('commandId',receipt.command_id,'revokedSessions',receipt.revoked_sessions,'completedAt',receipt.completed_at);
END $$;

-- Background work never acts as a suspended member. Discovery skips principals whose membership
-- is suspended; their open runs pause and continue after reactivation. Detection runs as the
-- first stream principal that isn't suspended.
CREATE OR REPLACE FUNCTION detection_worker_scopes() RETURNS TABLE(tenant_id uuid, principal_id text)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT DISTINCT ON (s.tenant_id) s.tenant_id,s.principal_id FROM public.commerce_sync_streams s
 JOIN public.organizations o ON o.id=s.tenant_id AND o.status='active'
 WHERE NOT s.paused AND s.blocked IS NULL
 AND NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.tenant_id=s.tenant_id AND m.user_id::text=s.principal_id AND m.status='suspended')
 ORDER BY s.tenant_id,s.created_at,s.id LIMIT 1000
$$;

CREATE OR REPLACE FUNCTION replenishment_worker_scopes() RETURNS TABLE(tenant_id uuid,principal_id text)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT DISTINCT a.tenant_id,a.principal_id FROM public.replenishment_activations a
 JOIN public.organizations o ON o.id=a.tenant_id AND o.status='active'
 WHERE NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.tenant_id=a.tenant_id AND m.user_id::text=a.principal_id AND m.status='suspended')
$$;

CREATE OR REPLACE FUNCTION case_workflow_worker_scopes() RETURNS TABLE(tenant_id uuid,principal_id text)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT DISTINCT a.tenant_id,a.principal_id FROM public.workflow_case_activations a
 JOIN public.organizations o ON o.id=a.tenant_id AND o.status='active'
 WHERE NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.tenant_id=a.tenant_id AND m.user_id::text=a.principal_id AND m.status='suspended')
$$;

CREATE OR REPLACE FUNCTION code_process_worker_scopes() RETURNS TABLE(tenant_id uuid,principal_id text,definition_id text)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT DISTINCT r.tenant_id,r.document->'actor'->>'id',r.definition_id
 FROM public.workflow_trigger_runs r JOIN public.playbook_versions v
 ON v.tenant_id=r.tenant_id AND v.definition_id=r.definition_id AND v.version=r.version
 JOIN public.organizations o ON o.id=r.tenant_id AND o.status='active'
 WHERE r.state='awaiting_admission' AND v.document->>'format'='workflow/2'
 AND EXISTS (SELECT 1 FROM jsonb_array_elements(v.document->'steps') s WHERE s->>'kind'='code')
 AND NOT EXISTS (SELECT 1 FROM public.workflow_process_steps p WHERE p.tenant_id=r.tenant_id AND p.run_id=r.id AND (p.document->>'kind'='end' OR p.state IN ('denied','failed','inconclusive','ended','escalated')))
 AND NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.tenant_id=r.tenant_id AND m.user_id::text=r.document->'actor'->>'id' AND m.status='suspended')
$$;

CREATE OR REPLACE FUNCTION procurement_submission_scopes() RETURNS TABLE(tenant_id uuid,principal_id text)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT DISTINCT s.tenant_id,s.principal_id FROM public.procurement_submissions s
 JOIN public.organizations o ON o.id=s.tenant_id AND o.status='active'
 WHERE NOT s.settled AND s.state IN ('approved','submitting','uncertain','submitted')
 AND NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.tenant_id=s.tenant_id AND m.user_id::text=s.principal_id AND m.status='suspended')
$$;

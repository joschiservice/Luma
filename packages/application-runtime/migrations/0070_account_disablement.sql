-- Disabled accounts. A row exists while the account is disabled: sign-in is refused, existing
-- sessions are rejected and every workspace rejects the person. Memberships are untouched, so
-- enabling restores access to every previous workspace. Only luma_identity_support changes it.
CREATE TABLE account_disablements (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 disabled_at timestamptz NOT NULL DEFAULT now(),
 disabled_by uuid NOT NULL,
 reason_category text NOT NULL CHECK(reason_category IN ('compromised','abuse','fraud','legal_request','other')),
 reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 500)
);
-- The customer runtime only needs to know whether an account is disabled.
GRANT SELECT(user_id) ON account_disablements TO luma_identity;

-- Account commands are a separate staff permission. Keep this list equal to the staff catalog.
ALTER TABLE staff_access DROP CONSTRAINT staff_access_permissions_check;
ALTER TABLE staff_access ADD CONSTRAINT staff_access_permissions_check CHECK(permissions <@ ARRAY['staff.directory.read','staff.workspace.inspect','staff.sessions.revoke','staff.audit.read','staff.accounts.inspect','staff.memberships.manage','staff.view-as','staff.view-as.emergency','staff.accounts.manage']::text[]);

-- Staff account commands. Receipts make exact retries return the original result.
CREATE TABLE identity_support_account_commands (
 command_id uuid PRIMARY KEY,
 staff_user_id uuid NOT NULL,
 user_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('disable','enable')),
 reason_category text,
 reason text NOT NULL,
 revoked_sessions integer NOT NULL,
 completed_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT,INSERT ON identity_support_account_commands TO luma_identity_support;
GRANT SELECT,INSERT,DELETE ON account_disablements TO luma_identity_support;
GRANT SELECT(id) ON users TO luma_identity_support;
-- Row locks on the account grant need an UPDATE grant, like workspace grants.
GRANT UPDATE(reason) ON staff_account_grants TO luma_identity_support;

-- Security events name any staff command by ID; command IDs are unique across receipt tables.
ALTER TABLE account_security_events DROP CONSTRAINT account_security_events_staff_command_id_fkey;

-- Disables or enables one customer account. Checks the staff permission, a current account
-- grant and a staff sign-in within fifteen minutes. Disabling deletes every session of the
-- account; the disablement, receipt, security event and staff audit commit together. Errors:
-- 42501 access, 22023 reason or category, 23505 command reuse, P0002 no account, 55000 state
-- conflict (message `already disabled` or `already enabled`).
CREATE FUNCTION identity_support_change_account(command uuid,target_user uuid,action_name text,category_name text,reason_text text,request_text text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
 actor uuid:=NULLIF(current_setting('staff.user_id',true),'')::uuid;
 staff_session uuid:=NULLIF(current_setting('staff.session_id',true),'')::uuid;
 receipt public.identity_support_account_commands%ROWTYPE;
 amount integer:=0;
BEGIN
 PERFORM 1 FROM public.staff_access a JOIN public.staff_users u ON lower(u.email)=a.email WHERE u.id=actor FOR SHARE OF a;
 PERFORM 1 FROM public.staff_sessions WHERE id=staff_session AND user_id=actor FOR SHARE;
 PERFORM 1 FROM public.staff_account_grants WHERE id=NULLIF(current_setting('staff.grant_id',true),'')::uuid AND staff_user_id=actor FOR SHARE;
 -- Commands for one account serialize; the account row itself stays Better Auth's.
 PERFORM pg_advisory_xact_lock(hashtextextended('account:'||target_user::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(command::text,0));
 IF action_name IS NULL OR action_name NOT IN ('disable','enable') THEN RAISE EXCEPTION 'invalid action' USING ERRCODE='22023'; END IF;
 IF NOT public.staff_has_access('staff.accounts.manage') OR NOT public.staff_has_account_access(target_user) OR NOT EXISTS(SELECT FROM public.staff_sessions WHERE id=staff_session AND created_at>clock_timestamp()-interval '15 minutes') THEN RAISE EXCEPTION 'staff access denied' USING ERRCODE='42501'; END IF;
 IF reason_text IS NULL OR length(trim(reason_text)) NOT BETWEEN 10 AND 500 THEN RAISE EXCEPTION 'invalid reason' USING ERRCODE='22023'; END IF;
 IF (action_name='disable' AND (category_name IS NULL OR category_name NOT IN ('compromised','abuse','fraud','legal_request','other')))
  OR (action_name='enable' AND category_name IS NOT NULL) THEN RAISE EXCEPTION 'invalid category' USING ERRCODE='22023'; END IF;
 SELECT * INTO receipt FROM public.identity_support_account_commands WHERE command_id=command;
 IF FOUND THEN
  IF receipt.staff_user_id<>actor OR receipt.user_id<>target_user OR receipt.action<>action_name OR receipt.reason_category IS DISTINCT FROM category_name OR receipt.reason<>reason_text THEN RAISE EXCEPTION 'command conflict' USING ERRCODE='23505'; END IF;
 ELSE
  IF EXISTS(SELECT FROM public.identity_support_commands WHERE command_id=command) OR EXISTS(SELECT FROM public.identity_support_membership_commands WHERE command_id=command) THEN RAISE EXCEPTION 'command conflict' USING ERRCODE='23505'; END IF;
  IF NOT EXISTS(SELECT FROM public.users WHERE id=target_user) THEN RAISE EXCEPTION 'account unavailable' USING ERRCODE='P0002'; END IF;
  IF action_name='disable' THEN
   IF EXISTS(SELECT FROM public.account_disablements WHERE user_id=target_user) THEN RAISE EXCEPTION 'already disabled' USING ERRCODE='55000'; END IF;
   INSERT INTO public.account_disablements(user_id,disabled_by,reason_category,reason) VALUES(target_user,actor,category_name,reason_text);
   DELETE FROM public.sessions WHERE user_id=target_user; GET DIAGNOSTICS amount=ROW_COUNT;
  ELSE
   DELETE FROM public.account_disablements WHERE user_id=target_user;
   IF NOT FOUND THEN RAISE EXCEPTION 'already enabled' USING ERRCODE='55000'; END IF;
  END IF;
  INSERT INTO public.identity_support_account_commands(command_id,staff_user_id,user_id,action,reason_category,reason,revoked_sessions)
  VALUES(command,actor,target_user,action_name,category_name,reason_text,amount) RETURNING * INTO receipt;
  INSERT INTO public.staff_audit(staff_user_id,staff_session_id,tenant_id,event,request_id,reason,details)
  VALUES(actor,staff_session,NULL,CASE action_name WHEN 'disable' THEN 'customer.account.disabled' ELSE 'customer.account.enabled' END,request_text,reason_text,
   jsonb_build_object('commandId',command,'userId',target_user,'reasonCategory',category_name,'revokedSessions',amount,'scope','global-account'));
  -- The customer's own history names the change but not the staff reason.
  INSERT INTO public.account_security_events(id,user_id,event_type,outcome,reason_code,request_id,staff_command_id)
  VALUES(gen_random_uuid(),target_user,CASE action_name WHEN 'disable' THEN 'account.disabled' ELSE 'account.enabled' END,'succeeded',NULL,left(request_text,200),command);
 END IF;
 RETURN jsonb_build_object('commandId',receipt.command_id,'status',CASE receipt.action WHEN 'disable' THEN 'disabled' ELSE 'enabled' END,'revokedSessions',receipt.revoked_sessions,'completedAt',receipt.completed_at);
END $$;
ALTER FUNCTION identity_support_change_account(uuid,uuid,text,text,text,text) OWNER TO luma_identity_support;
REVOKE ALL ON FUNCTION identity_support_change_account(uuid,uuid,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity_support_change_account(uuid,uuid,text,text,text,text) TO luma_staff_runtime;

-- A command ID names one staff command: the membership and session commands also reject
-- account receipts.
CREATE OR REPLACE FUNCTION identity_support_change_membership(command uuid,target_tenant uuid,target_user uuid,action_name text,reason_text text,acknowledge_last_owner boolean,request_text text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
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
  IF EXISTS(SELECT FROM public.identity_support_commands WHERE command_id=command) OR EXISTS(SELECT FROM public.identity_support_account_commands WHERE command_id=command) THEN RAISE EXCEPTION 'command conflict' USING ERRCODE='23505'; END IF;
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
  IF EXISTS(SELECT FROM public.identity_support_membership_commands WHERE command_id=command) OR EXISTS(SELECT FROM public.identity_support_account_commands WHERE command_id=command) THEN RAISE EXCEPTION 'command conflict' USING ERRCODE='23505'; END IF;
  IF NOT EXISTS(SELECT FROM public.memberships WHERE tenant_id=target_tenant AND user_id=target_user) THEN RAISE EXCEPTION 'member unavailable' USING ERRCODE='P0002'; END IF;
  DELETE FROM public.sessions WHERE user_id=target_user; GET DIAGNOSTICS amount=ROW_COUNT;
  INSERT INTO public.identity_support_commands(command_id,staff_user_id,tenant_id,user_id,reason,revoked_sessions) VALUES(command,actor,target_tenant,target_user,reason_text,amount) RETURNING * INTO receipt;
  INSERT INTO public.staff_audit(staff_user_id,staff_session_id,tenant_id,event,request_id,reason,details) VALUES(actor,NULLIF(current_setting('staff.session_id',true),'')::uuid,target_tenant,'customer.sessions.revoked',request_text,reason_text,jsonb_build_object('commandId',command,'userId',target_user,'revokedSessions',amount,'scope','global-account'));
  INSERT INTO public.account_security_events(id,user_id,event_type,outcome,reason_code,request_id,staff_command_id) VALUES(gen_random_uuid(),target_user,'sessions.revoked-by-staff','succeeded','all',left(request_text,200),command);
 END IF;
 RETURN jsonb_build_object('commandId',receipt.command_id,'revokedSessions',receipt.revoked_sessions,'completedAt',receipt.completed_at);
END $$;

-- Starting a support view refuses a disabled account; its contexts would be rejected anyway.
CREATE OR REPLACE FUNCTION support_view_start(target_tenant uuid,target_user uuid,mode_name text,reason_text text,category_name text,reference_text text,handoff text,request_text text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
 actor uuid:=NULLIF(current_setting('staff.user_id',true),'')::uuid;
 staff_session uuid:=NULLIF(current_setting('staff.session_id',true),'')::uuid;
 sv public.support_view_sessions%ROWTYPE;
 previous uuid;
 member_status text;
BEGIN
 IF mode_name IS NULL OR mode_name NOT IN ('consent','emergency') THEN RAISE EXCEPTION 'invalid mode' USING ERRCODE='22023'; END IF;
 IF NOT public.staff_has_workspace_access(target_tenant)
  OR (mode_name='consent' AND NOT public.staff_has_access('staff.view-as'))
  OR (mode_name='emergency' AND (NOT public.staff_has_access('staff.view-as.emergency') OR NOT EXISTS(SELECT FROM public.staff_sessions WHERE id=staff_session AND created_at>clock_timestamp()-interval '15 minutes')))
 THEN RAISE EXCEPTION 'staff access denied' USING ERRCODE='42501'; END IF;
 IF reason_text IS NULL OR length(trim(reason_text)) NOT BETWEEN 10 AND 500 THEN RAISE EXCEPTION 'invalid reason' USING ERRCODE='22023'; END IF;
 IF (mode_name='emergency' AND (category_name IS NULL OR category_name NOT IN ('security_incident','legal_request') OR reference_text IS NULL OR length(trim(reference_text)) NOT BETWEEN 3 AND 200))
  OR (mode_name='consent' AND (category_name IS NOT NULL OR reference_text IS NOT NULL))
 THEN RAISE EXCEPTION 'invalid emergency details' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT FROM public.organizations WHERE id=target_tenant AND data_region='EU') THEN RAISE EXCEPTION 'region unavailable' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT FROM public.organizations WHERE id=target_tenant AND status='active') THEN RAISE EXCEPTION 'workspace inactive' USING ERRCODE='55000'; END IF;
 IF mode_name='consent' AND NOT EXISTS(SELECT FROM public.workspace_support_access WHERE tenant_id=target_tenant AND allowed_until>clock_timestamp()) THEN RAISE EXCEPTION 'consent required' USING ERRCODE='55000'; END IF;
 SELECT status INTO member_status FROM public.memberships WHERE tenant_id=target_tenant AND user_id=target_user;
 IF NOT FOUND THEN RAISE EXCEPTION 'member unavailable' USING ERRCODE='P0002'; END IF;
 IF member_status<>'active' THEN RAISE EXCEPTION 'member suspended' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT FROM public.account_disablements WHERE user_id=target_user) THEN RAISE EXCEPTION 'account disabled' USING ERRCODE='55000'; END IF;
 FOR previous IN SELECT id FROM public.support_view_sessions WHERE staff_session_id=staff_session AND staff_user_id=actor AND ended_at IS NULL FOR UPDATE LOOP
  PERFORM public.support_view_finish(previous,'replaced',request_text);
 END LOOP;
 INSERT INTO public.support_view_sessions(id,tenant_id,user_id,staff_user_id,staff_session_id,mode,reason,emergency_category,emergency_reference,handoff_hash,handoff_expires_at,expires_at)
 VALUES(gen_random_uuid(),target_tenant,target_user,actor,staff_session,mode_name,trim(reason_text),category_name,trim(reference_text),handoff,now()+interval '2 minutes',now()+interval '30 minutes')
 RETURNING * INTO sv;
 INSERT INTO public.staff_audit(staff_user_id,staff_session_id,tenant_id,event,request_id,reason,details)
 VALUES(actor,staff_session,target_tenant,'view-as.started',left(request_text,200),sv.reason,
  jsonb_build_object('viewId',sv.id,'userId',target_user,'mode',mode_name,'category',category_name,'reference',sv.emergency_reference,'expiresAt',sv.expires_at));
 INSERT INTO public.workspace_access_events(id,tenant_id,actor_id,actor_kind,event_type,target_id,before_value,after_value)
 VALUES(gen_random_uuid(),target_tenant,'00000000-0000-0000-0000-000000000000','staff',CASE mode_name WHEN 'emergency' THEN 'support_view.emergency_started' ELSE 'support_view.started' END,sv.id::text,NULL,
  jsonb_build_object('userId',target_user,'mode',mode_name,'category',category_name,'expiresAt',sv.expires_at));
 IF mode_name='consent' THEN PERFORM public.support_view_notify_owners(target_tenant,'support_view_started',sv.id); END IF;
 RETURN jsonb_build_object('id',sv.id,'expiresAt',sv.expires_at,'handoffExpiresAt',sv.handoff_expires_at);
END $$;

-- A disabled account can't be viewed as: every workspace rejects it.
GRANT SELECT(user_id) ON account_disablements TO luma_support_view;

-- Staff read the account's status on the account page, under its account grant.
GRANT SELECT ON account_disablements TO luma_staff_views;
CREATE OR REPLACE VIEW staff_account_profile WITH (security_barrier=true) AS
SELECT u.id,u.name,u.email,u.created_at,u.two_factor_enabled,(SELECT count(*) FROM passkeys p WHERE p.user_id=u.id)::integer AS passkey_count,
 d.disabled_at,d.reason_category AS disabled_reason_category,d.reason AS disabled_reason,s.name AS disabled_by_name
FROM users u LEFT JOIN account_disablements d ON d.user_id=u.id LEFT JOIN staff_users s ON s.id=d.disabled_by
WHERE public.staff_has_account_access(u.id);

-- For banning a workspace, staff need to know which members belong to no other workspace and
-- which accounts are already disabled. Exposes only those two facts for the granted workspace.
GRANT SELECT(user_id) ON account_disablements TO luma_staff_directory;
ALTER POLICY staff_grants_read ON staff_support_grants TO luma_staff_views,luma_identity_support,luma_support_view,luma_staff_directory;
CREATE FUNCTION staff_workspace_member_accounts(target uuid) RETURNS TABLE(user_id uuid,only_workspace boolean,account_disabled boolean)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT m.user_id,
  NOT EXISTS (SELECT FROM public.memberships o WHERE o.user_id=m.user_id AND o.tenant_id<>target),
  EXISTS (SELECT FROM public.account_disablements d WHERE d.user_id=m.user_id)
 FROM public.memberships m WHERE m.tenant_id=target AND public.staff_has_workspace_access(target)
$$;
ALTER FUNCTION staff_workspace_member_accounts(uuid) OWNER TO luma_staff_directory;
REVOKE ALL ON FUNCTION staff_workspace_member_accounts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION staff_workspace_member_accounts(uuid) TO luma_staff_runtime;

-- Background work never acts as a disabled account, like a suspended member: discovery skips
-- it, and its open runs pause until the account is enabled.
CREATE OR REPLACE FUNCTION detection_worker_scopes() RETURNS TABLE(tenant_id uuid, principal_id text)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT DISTINCT ON (s.tenant_id) s.tenant_id,s.principal_id FROM public.commerce_sync_streams s
 JOIN public.organizations o ON o.id=s.tenant_id AND o.status='active'
 WHERE NOT s.paused AND s.blocked IS NULL
 AND NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.tenant_id=s.tenant_id AND m.user_id::text=s.principal_id AND m.status='suspended')
 AND NOT EXISTS (SELECT 1 FROM public.account_disablements d WHERE d.user_id::text=s.principal_id)
 ORDER BY s.tenant_id,s.created_at,s.id LIMIT 1000
$$;

CREATE OR REPLACE FUNCTION replenishment_worker_scopes() RETURNS TABLE(tenant_id uuid,principal_id text)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT DISTINCT a.tenant_id,a.principal_id FROM public.replenishment_activations a
 JOIN public.organizations o ON o.id=a.tenant_id AND o.status='active'
 WHERE NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.tenant_id=a.tenant_id AND m.user_id::text=a.principal_id AND m.status='suspended')
 AND NOT EXISTS (SELECT 1 FROM public.account_disablements d WHERE d.user_id::text=a.principal_id)
$$;

CREATE OR REPLACE FUNCTION case_workflow_worker_scopes() RETURNS TABLE(tenant_id uuid,principal_id text)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT DISTINCT a.tenant_id,a.principal_id FROM public.workflow_case_activations a
 JOIN public.organizations o ON o.id=a.tenant_id AND o.status='active'
 WHERE NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.tenant_id=a.tenant_id AND m.user_id::text=a.principal_id AND m.status='suspended')
 AND NOT EXISTS (SELECT 1 FROM public.account_disablements d WHERE d.user_id::text=a.principal_id)
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
 AND NOT EXISTS (SELECT 1 FROM public.account_disablements d WHERE d.user_id::text=r.document->'actor'->>'id')
$$;

CREATE OR REPLACE FUNCTION procurement_submission_scopes() RETURNS TABLE(tenant_id uuid,principal_id text)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT DISTINCT s.tenant_id,s.principal_id FROM public.procurement_submissions s
 JOIN public.organizations o ON o.id=s.tenant_id AND o.status='active'
 WHERE NOT s.settled AND s.state IN ('approved','submitting','uncertain','submitted')
 AND NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.tenant_id=s.tenant_id AND m.user_id::text=s.principal_id AND m.status='suspended')
 AND NOT EXISTS (SELECT 1 FROM public.account_disablements d WHERE d.user_id::text=s.principal_id)
$$;

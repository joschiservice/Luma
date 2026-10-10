-- Account deletion. Staff schedule an account for deletion; for 30 days it behaves as disabled and
-- can be restored exactly. Then the API's erasure pass deletes the account, its credentials and
-- memberships, and pseudonymizes what workspaces keep about the person. The deletion row stays as
-- the erasure receipt, without personal data. All deletion functions are owned by
-- luma_account_deletion: the staff runtime may schedule, restore and request erasure; the customer
-- runtime may only erase deletions that are due.
DO $$ BEGIN
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='luma_account_deletion') THEN CREATE ROLE luma_account_deletion NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO luma_account_deletion;

-- Keep this list equal to the staff catalog.
ALTER TABLE staff_access DROP CONSTRAINT staff_access_permissions_check;
ALTER TABLE staff_access ADD CONSTRAINT staff_access_permissions_check CHECK(permissions <@ ARRAY['staff.directory.read','staff.workspace.inspect','staff.sessions.revoke','staff.audit.read','staff.accounts.inspect','staff.memberships.manage','staff.view-as','staff.view-as.emergency','staff.accounts.manage','staff.accounts.delete']::text[]);

-- One row per scheduling. While `scheduled`, the account is disabled and its active memberships are
-- suspended; `disabled_account` records whether scheduling disabled it, so restore undoes only
-- that. Erasure clears nothing here: the row holds the account's opaque ID, timestamps, category,
-- request reference and staff actors. References must not contain personal data.
CREATE TABLE account_deletions (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('scheduled','restored','erased')),
 reason_category text NOT NULL CHECK(reason_category IN ('customer_request','gdpr_erasure','abuse','inactivity')),
 reference text NOT NULL CHECK(length(reference) BETWEEN 3 AND 200),
 scheduled_by uuid NOT NULL,
 scheduled_at timestamptz NOT NULL DEFAULT now(),
 erase_after timestamptz NOT NULL,
 disabled_account boolean NOT NULL,
 erase_requested_by uuid,
 erase_requested_at timestamptz,
 restored_by uuid,
 restored_at timestamptz,
 erased_at timestamptz,
 CHECK((erase_requested_by IS NULL) = (erase_requested_at IS NULL)),
 CHECK(CASE status
  WHEN 'scheduled' THEN restored_at IS NULL AND erased_at IS NULL
  WHEN 'restored' THEN restored_by IS NOT NULL AND restored_at IS NOT NULL AND erased_at IS NULL AND erase_requested_at IS NULL
  ELSE erased_at IS NOT NULL AND restored_at IS NULL END)
);
CREATE UNIQUE INDEX account_deletions_open ON account_deletions(user_id) WHERE status='scheduled';
CREATE INDEX account_deletions_due ON account_deletions(erase_after) WHERE status='scheduled';
CREATE INDEX account_deletions_user ON account_deletions(user_id);

-- Notices to the person. The recipient is read from the account when sending, so no address is
-- stored; erasure waits until the completion notice is sent or has failed.
CREATE TABLE account_mail (
 id uuid PRIMARY KEY,
 deletion_id uuid NOT NULL REFERENCES account_deletions(id),
 user_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('deletion_scheduled','deletion_restored','account_erased')),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','sent','failed','cancelled')),
 attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
 first_attempt_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz,
 UNIQUE(deletion_id,kind)
);
CREATE INDEX account_mail_due ON account_mail(next_attempt_at) WHERE state='queued';
GRANT SELECT,UPDATE(state,attempts,next_attempt_at,first_attempt_at,sent_at) ON account_mail TO luma_identity;
GRANT SELECT(id,user_id,status,erase_after) ON account_deletions TO luma_identity;

-- Scheduling disables the account with its own category, so sign-in, sessions, workspaces and
-- background work are refused exactly as for a disabled account.
ALTER TABLE account_disablements DROP CONSTRAINT account_disablements_reason_category_check;
ALTER TABLE account_disablements ADD CONSTRAINT account_disablements_reason_category_check CHECK(reason_category IN ('compromised','abuse','fraud','legal_request','other','account_deletion'));

-- Memberships suspended by scheduling name the deletion as their cause; restore reactivates
-- exactly those, and membership commands can't reactivate them separately.
ALTER TABLE memberships DROP CONSTRAINT memberships_suspended_by_kind_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_suspended_by_kind_check CHECK(suspended_by_kind IN ('staff','customer','account_deletion'));

-- Erased people stay in their workspaces' people records without a name or email, so history
-- names them "Former member" with their opaque ID.
ALTER TABLE workspace_people ALTER COLUMN name DROP NOT NULL;
ALTER TABLE workspace_people ADD CONSTRAINT workspace_people_erased CHECK(name IS NOT NULL OR NOT is_member);

-- Attribution columns keep the opaque ID of an erased account, like audit and activity rows.
ALTER TABLE invitations DROP CONSTRAINT invitations_inviter_id_fkey;
ALTER TABLE workspace_invitations DROP CONSTRAINT workspace_invitations_inviter_id_fkey;
ALTER TABLE workspace_invitations DROP CONSTRAINT workspace_invitations_accepted_by_fkey;
ALTER TABLE workspace_roles DROP CONSTRAINT workspace_roles_created_by_fkey;

-- Account command receipts also record deletion commands, so command IDs stay unique.
ALTER TABLE identity_support_account_commands DROP CONSTRAINT identity_support_account_commands_action_check;
ALTER TABLE identity_support_account_commands ADD CONSTRAINT identity_support_account_commands_action_check CHECK(action IN ('disable','enable','schedule_deletion','restore','erase_now'));
ALTER TABLE identity_support_account_commands ADD COLUMN reference text, ADD COLUMN deletion_id uuid;

-- Privileges of the deletion functions. The policies below allow every row to this NOLOGIN role:
-- its functions decide which account they act on.
GRANT SELECT,INSERT,UPDATE ON account_deletions TO luma_account_deletion;
GRANT SELECT,INSERT,UPDATE(state) ON account_mail TO luma_account_deletion;
GRANT SELECT,INSERT,DELETE ON account_disablements TO luma_account_deletion;
GRANT SELECT,INSERT ON identity_support_account_commands TO luma_account_deletion;
GRANT SELECT ON identity_support_commands,identity_support_membership_commands TO luma_account_deletion;
GRANT INSERT ON staff_audit TO luma_account_deletion;
GRANT USAGE ON SEQUENCE staff_audit_sequence_seq TO luma_account_deletion;
GRANT INSERT ON account_security_events TO luma_account_deletion;
GRANT SELECT ON staff_users,staff_sessions,staff_accounts,staff_access,staff_account_grants TO luma_account_deletion;
-- Row locks on admission, sessions and grants need an UPDATE grant, like the other staff commands.
GRANT UPDATE(active) ON staff_access TO luma_account_deletion;
GRANT UPDATE(updated_at) ON staff_sessions TO luma_account_deletion;
GRANT UPDATE(reason) ON staff_account_grants TO luma_account_deletion;
ALTER POLICY staff_account_grants_read ON staff_account_grants TO luma_staff_views,luma_identity_support,luma_account_deletion;
GRANT EXECUTE ON FUNCTION staff_has_access(text) TO luma_account_deletion;
GRANT EXECUTE ON FUNCTION staff_has_account_access(uuid) TO luma_account_deletion;
GRANT SELECT(id,name,email),DELETE ON users TO luma_account_deletion;
GRANT SELECT(id,user_id),DELETE ON sessions TO luma_account_deletion;
GRANT SELECT(id,value,identifier),DELETE ON verifications TO luma_account_deletion;
GRANT SELECT(id,status),UPDATE(name) ON organizations TO luma_account_deletion;
CREATE POLICY account_deletion ON organizations FOR ALL TO luma_account_deletion USING(true) WITH CHECK(false);
GRANT SELECT,DELETE,UPDATE(status,suspended_at,suspended_by_kind,suspended_by,suspension_reason) ON memberships TO luma_account_deletion;
CREATE POLICY account_deletion ON memberships TO luma_account_deletion USING(true) WITH CHECK(true);
GRANT SELECT(tenant_id,id,name) ON workspace_roles TO luma_account_deletion;
CREATE POLICY account_deletion ON workspace_roles FOR SELECT TO luma_account_deletion USING(true);
GRANT SELECT,INSERT,UPDATE(before_value,after_value) ON workspace_access_events TO luma_account_deletion;
CREATE POLICY account_deletion_read ON workspace_access_events FOR SELECT TO luma_account_deletion USING(true);
CREATE POLICY account_deletion_event ON workspace_access_events FOR INSERT TO luma_account_deletion WITH CHECK(actor_kind='staff');
CREATE POLICY account_deletion_redaction ON workspace_access_events FOR UPDATE TO luma_account_deletion USING(true) WITH CHECK(true);
GRANT SELECT,UPDATE(request,result) ON workspace_commands TO luma_account_deletion;
CREATE POLICY account_deletion ON workspace_commands TO luma_account_deletion USING(true) WITH CHECK(true);
GRANT SELECT,UPDATE(email,status) ON workspace_invitations TO luma_account_deletion;
CREATE POLICY account_deletion ON workspace_invitations TO luma_account_deletion USING(true) WITH CHECK(true);
GRANT SELECT,UPDATE(email) ON invitations TO luma_account_deletion;
CREATE POLICY account_deletion ON invitations TO luma_account_deletion USING(true) WITH CHECK(true);
GRANT SELECT,UPDATE(name,email,is_member) ON workspace_people TO luma_account_deletion;
CREATE POLICY account_deletion ON workspace_people TO luma_account_deletion USING(true) WITH CHECK(true);
GRANT SELECT,DELETE ON notification_preferences,workspace_layouts TO luma_account_deletion;
CREATE POLICY account_deletion ON notification_preferences TO luma_account_deletion USING(true);
CREATE POLICY account_deletion ON workspace_layouts TO luma_account_deletion USING(true);

-- Locks every workspace the account belongs to, in a stable order, so deletion commands
-- serialize with the customers' own membership changes.
CREATE FUNCTION account_deletion_lock_workspaces(target_user uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM 1 FROM public.organizations WHERE id IN (SELECT tenant_id FROM public.memberships WHERE user_id=target_user) ORDER BY id FOR UPDATE;
END $$;

-- Starts a deletion: checks the last-owner rule, disables the account unless it is disabled already,
-- ends its sessions and suspends its active memberships, each with a staff access event. Returns
-- the deletion row and the number of ended sessions. Callers hold the account lock and check
-- staff access. Errors: P0002 no account, 55000 `already scheduled` or `sole owner`.
CREATE FUNCTION account_deletion_begin(target_user uuid,actor uuid,category_name text,reference_text text,reason_text text,erase_at timestamptz,OUT deletion public.account_deletions,OUT revoked integer) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
 member record;
 role_name text;
BEGIN
 IF NOT EXISTS(SELECT FROM public.users WHERE id=target_user) THEN RAISE EXCEPTION 'account unavailable' USING ERRCODE='P0002'; END IF;
 IF EXISTS(SELECT FROM public.account_deletions WHERE user_id=target_user AND status='scheduled') THEN RAISE EXCEPTION 'already scheduled' USING ERRCODE='55000'; END IF;
 PERFORM public.account_deletion_lock_workspaces(target_user);
 -- A workspace keeps at least one owner who can act, unless it is closed.
 IF EXISTS(SELECT FROM public.memberships m JOIN public.organizations o ON o.id=m.tenant_id
  WHERE m.user_id=target_user AND m.role='owner' AND m.status='active' AND o.status<>'closed'
  AND NOT EXISTS(SELECT FROM public.memberships other WHERE other.tenant_id=m.tenant_id AND other.role='owner' AND other.status='active' AND other.user_id<>target_user
   AND NOT EXISTS(SELECT FROM public.account_disablements d WHERE d.user_id=other.user_id)))
 THEN RAISE EXCEPTION 'sole owner' USING ERRCODE='55000'; END IF;
 INSERT INTO public.account_deletions(id,user_id,status,reason_category,reference,scheduled_by,erase_after,disabled_account)
 VALUES(gen_random_uuid(),target_user,'scheduled',category_name,trim(reference_text),actor,erase_at,NOT EXISTS(SELECT FROM public.account_disablements WHERE user_id=target_user))
 RETURNING * INTO deletion;
 IF deletion.disabled_account THEN
  INSERT INTO public.account_disablements(user_id,disabled_by,reason_category,reason) VALUES(target_user,actor,'account_deletion',reason_text);
 END IF;
 DELETE FROM public.sessions WHERE user_id=target_user; GET DIAGNOSTICS revoked=ROW_COUNT;
 FOR member IN SELECT m.id,m.tenant_id,m.user_id,m.role,m.custom_role_id FROM public.memberships m WHERE m.user_id=target_user AND m.status='active' FOR UPDATE LOOP
  UPDATE public.memberships SET status='suspended',suspended_at=now(),suspended_by_kind='account_deletion',suspended_by=actor WHERE id=member.id;
  role_name:=CASE member.role WHEN 'owner' THEN 'Owner' WHEN 'admin' THEN 'Admin' WHEN 'member' THEN 'Member'
   ELSE (SELECT r.name FROM public.workspace_roles r WHERE r.tenant_id=member.tenant_id AND r.id=member.custom_role_id) END;
  INSERT INTO public.workspace_access_events(id,tenant_id,actor_id,actor_kind,event_type,target_id,before_value,after_value)
  VALUES(gen_random_uuid(),member.tenant_id,'00000000-0000-0000-0000-000000000000','staff','member.suspended',member.id::text,
   jsonb_build_object('id',member.id,'userId',member.user_id,'roleId',COALESCE(member.custom_role_id::text,member.role),'roleName',role_name,'status','active'),
   jsonb_build_object('id',member.id,'userId',member.user_id,'roleId',COALESCE(member.custom_role_id::text,member.role),'roleName',role_name,'status','suspended'));
 END LOOP;
END $$;

-- Checks staff access for a deletion command and returns its existing receipt, if any. Rejects
-- reuse of a command ID for another payload or command. Errors: 42501, 22023, 23505.
CREATE FUNCTION account_deletion_receipt(command uuid,target_user uuid,action_name text,category_name text,reference_text text,reason_text text) RETURNS public.identity_support_account_commands LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
 actor uuid:=NULLIF(current_setting('staff.user_id',true),'')::uuid;
 staff_session uuid:=NULLIF(current_setting('staff.session_id',true),'')::uuid;
 receipt public.identity_support_account_commands%ROWTYPE;
BEGIN
 PERFORM 1 FROM public.staff_access a JOIN public.staff_users u ON lower(u.email)=a.email WHERE u.id=actor FOR SHARE OF a;
 PERFORM 1 FROM public.staff_sessions WHERE id=staff_session AND user_id=actor FOR SHARE;
 PERFORM 1 FROM public.staff_account_grants WHERE id=NULLIF(current_setting('staff.grant_id',true),'')::uuid AND staff_user_id=actor FOR SHARE;
 -- Commands for one account serialize, with account disabling too.
 PERFORM pg_advisory_xact_lock(hashtextextended('account:'||target_user::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(command::text,0));
 IF NOT public.staff_has_access('staff.accounts.delete') OR NOT public.staff_has_account_access(target_user) OR NOT EXISTS(SELECT FROM public.staff_sessions WHERE id=staff_session AND created_at>clock_timestamp()-interval '15 minutes') THEN RAISE EXCEPTION 'staff access denied' USING ERRCODE='42501'; END IF;
 IF reason_text IS NULL OR length(trim(reason_text)) NOT BETWEEN 10 AND 500 THEN RAISE EXCEPTION 'invalid reason' USING ERRCODE='22023'; END IF;
 IF (action_name='schedule_deletion' AND (category_name IS NULL OR category_name NOT IN ('customer_request','gdpr_erasure','abuse','inactivity')))
  OR (action_name<>'schedule_deletion' AND category_name IS NOT NULL) THEN RAISE EXCEPTION 'invalid category' USING ERRCODE='22023'; END IF;
 IF (action_name='restore' AND reference_text IS NOT NULL)
  OR (action_name<>'restore' AND (reference_text IS NULL OR length(trim(reference_text)) NOT BETWEEN 3 AND 200)) THEN RAISE EXCEPTION 'invalid reference' USING ERRCODE='22023'; END IF;
 SELECT * INTO receipt FROM public.identity_support_account_commands WHERE command_id=command;
 IF FOUND THEN
  IF receipt.staff_user_id<>actor OR receipt.user_id<>target_user OR receipt.action<>action_name OR receipt.reason_category IS DISTINCT FROM category_name
   OR receipt.reference IS DISTINCT FROM reference_text OR receipt.reason<>reason_text THEN RAISE EXCEPTION 'command conflict' USING ERRCODE='23505'; END IF;
  RETURN receipt;
 END IF;
 IF EXISTS(SELECT FROM public.identity_support_commands WHERE command_id=command) OR EXISTS(SELECT FROM public.identity_support_membership_commands WHERE command_id=command) THEN RAISE EXCEPTION 'command conflict' USING ERRCODE='23505'; END IF;
 RETURN NULL;
END $$;

-- Records a completed deletion command: its receipt, the staff audit row and the customer's
-- security event, in the caller's transaction.
CREATE FUNCTION account_deletion_record(command uuid,target_user uuid,action_name text,category_name text,reference_text text,reason_text text,request_text text,deletion public.account_deletions,revoked integer) RETURNS public.identity_support_account_commands LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
 actor uuid:=NULLIF(current_setting('staff.user_id',true),'')::uuid;
 receipt public.identity_support_account_commands%ROWTYPE;
BEGIN
 INSERT INTO public.identity_support_account_commands(command_id,staff_user_id,user_id,action,reason_category,reason,revoked_sessions,reference,deletion_id)
 VALUES(command,actor,target_user,action_name,category_name,reason_text,revoked,reference_text,deletion.id) RETURNING * INTO receipt;
 INSERT INTO public.staff_audit(staff_user_id,staff_session_id,tenant_id,event,request_id,reason,details)
 VALUES(actor,NULLIF(current_setting('staff.session_id',true),'')::uuid,NULL,
  CASE action_name WHEN 'schedule_deletion' THEN 'customer.account.deletion_scheduled' WHEN 'restore' THEN 'customer.account.restored' ELSE 'customer.account.erasure_requested' END,
  request_text,reason_text,
  jsonb_build_object('commandId',command,'userId',target_user,'deletionId',deletion.id,'reasonCategory',deletion.reason_category,'reference',reference_text,
   'eraseAfter',deletion.erase_after,'revokedSessions',revoked,'scope','global-account'));
 IF action_name<>'erase_now' THEN
  INSERT INTO public.account_security_events(id,user_id,event_type,outcome,reason_code,request_id,staff_command_id)
  VALUES(gen_random_uuid(),target_user,CASE action_name WHEN 'schedule_deletion' THEN 'account.deletion-scheduled' ELSE 'account.restored' END,'succeeded',NULL,left(request_text,200),command);
  INSERT INTO public.account_mail(id,deletion_id,user_id,kind) VALUES(gen_random_uuid(),deletion.id,target_user,CASE action_name WHEN 'schedule_deletion' THEN 'deletion_scheduled' ELSE 'deletion_restored' END);
 END IF;
 RETURN receipt;
END $$;

-- The response for a deletion receipt; retries read the deletion's current erase time.
CREATE FUNCTION account_deletion_result(receipt public.identity_support_account_commands) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('commandId',receipt.command_id,'deletionId',receipt.deletion_id,
  'status',CASE receipt.action WHEN 'schedule_deletion' THEN 'scheduled' WHEN 'restore' THEN 'restored' ELSE 'erasing' END,
  'eraseAfter',(SELECT erase_after FROM public.account_deletions WHERE id=receipt.deletion_id),
  'revokedSessions',receipt.revoked_sessions,'completedAt',receipt.completed_at)
$$;

-- Schedules one account for deletion in 30 days. Needs `staff.accounts.delete`, a current account
-- grant, a staff sign-in within fifteen minutes, a category, a request reference and a reason.
-- Disables the account, ends its sessions and suspends its memberships; the deletion, receipt,
-- staff audit, security event and notice commit together. Errors: 42501 access, 22023 input,
-- 23505 command reuse, P0002 no account, 55000 `already scheduled` or `sole owner`.
CREATE FUNCTION identity_support_schedule_account_deletion(command uuid,target_user uuid,category_name text,reference_text text,reason_text text,request_text text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
 receipt public.identity_support_account_commands%ROWTYPE;
 started record;
BEGIN
 receipt:=public.account_deletion_receipt(command,target_user,'schedule_deletion',category_name,reference_text,reason_text);
 IF receipt.command_id IS NULL THEN
  SELECT * INTO started FROM public.account_deletion_begin(target_user,NULLIF(current_setting('staff.user_id',true),'')::uuid,category_name,reference_text,reason_text,now()+interval '30 days');
  receipt:=public.account_deletion_record(command,target_user,'schedule_deletion',category_name,reference_text,reason_text,request_text,started.deletion,started.revoked);
 END IF;
 RETURN public.account_deletion_result(receipt);
END $$;

-- Cancels a scheduled deletion: reactivates the memberships it suspended and removes the
-- disablement it added, so the account returns to its previous state. Sessions stay ended.
-- Errors as for scheduling; 55000 `not scheduled` or `erasure requested`.
CREATE FUNCTION identity_support_restore_account(command uuid,target_user uuid,reason_text text,request_text text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
 actor uuid:=NULLIF(current_setting('staff.user_id',true),'')::uuid;
 receipt public.identity_support_account_commands%ROWTYPE;
 deletion public.account_deletions%ROWTYPE;
 member record;
 role_name text;
BEGIN
 receipt:=public.account_deletion_receipt(command,target_user,'restore',NULL,NULL,reason_text);
 IF receipt.command_id IS NULL THEN
  SELECT * INTO deletion FROM public.account_deletions WHERE user_id=target_user AND status='scheduled' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not scheduled' USING ERRCODE='55000'; END IF;
  IF deletion.erase_requested_at IS NOT NULL THEN RAISE EXCEPTION 'erasure requested' USING ERRCODE='55000'; END IF;
  PERFORM public.account_deletion_lock_workspaces(target_user);
  FOR member IN SELECT m.id,m.tenant_id,m.user_id,m.role,m.custom_role_id FROM public.memberships m WHERE m.user_id=target_user AND m.status='suspended' AND m.suspended_by_kind='account_deletion' FOR UPDATE LOOP
   UPDATE public.memberships SET status='active',suspended_at=NULL,suspended_by_kind=NULL,suspended_by=NULL,suspension_reason=NULL WHERE id=member.id;
   role_name:=CASE member.role WHEN 'owner' THEN 'Owner' WHEN 'admin' THEN 'Admin' WHEN 'member' THEN 'Member'
    ELSE (SELECT r.name FROM public.workspace_roles r WHERE r.tenant_id=member.tenant_id AND r.id=member.custom_role_id) END;
   INSERT INTO public.workspace_access_events(id,tenant_id,actor_id,actor_kind,event_type,target_id,before_value,after_value)
   VALUES(gen_random_uuid(),member.tenant_id,'00000000-0000-0000-0000-000000000000','staff','member.reactivated',member.id::text,
    jsonb_build_object('id',member.id,'userId',member.user_id,'roleId',COALESCE(member.custom_role_id::text,member.role),'roleName',role_name,'status','suspended'),
    jsonb_build_object('id',member.id,'userId',member.user_id,'roleId',COALESCE(member.custom_role_id::text,member.role),'roleName',role_name,'status','active'));
  END LOOP;
  IF deletion.disabled_account THEN
   DELETE FROM public.account_disablements WHERE user_id=target_user AND reason_category='account_deletion';
  END IF;
  UPDATE public.account_deletions SET status='restored',restored_by=actor,restored_at=now() WHERE id=deletion.id RETURNING * INTO deletion;
  receipt:=public.account_deletion_record(command,target_user,'restore',NULL,NULL,reason_text,request_text,deletion,0);
 END IF;
 RETURN public.account_deletion_result(receipt);
END $$;

-- Erases an account without the restore window, for a verified erasure request (GDPR Art. 17).
-- Schedules the deletion first when none is scheduled. The erasure pass completes it within
-- minutes; it can't be restored. Errors as for scheduling.
CREATE FUNCTION identity_support_erase_account_now(command uuid,target_user uuid,reference_text text,reason_text text,request_text text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
 actor uuid:=NULLIF(current_setting('staff.user_id',true),'')::uuid;
 receipt public.identity_support_account_commands%ROWTYPE;
 deletion public.account_deletions%ROWTYPE;
 started record;
 revoked integer:=0;
BEGIN
 receipt:=public.account_deletion_receipt(command,target_user,'erase_now',NULL,reference_text,reason_text);
 IF receipt.command_id IS NULL THEN
  SELECT * INTO deletion FROM public.account_deletions WHERE user_id=target_user AND status='scheduled' FOR UPDATE;
  IF NOT FOUND THEN
   SELECT * INTO started FROM public.account_deletion_begin(target_user,actor,'gdpr_erasure',reference_text,reason_text,now());
   deletion:=started.deletion;
   revoked:=started.revoked;
  END IF;
  UPDATE public.account_deletions SET reason_category='gdpr_erasure',reference=trim(reference_text),erase_after=LEAST(erase_after,now()),
   erase_requested_by=actor,erase_requested_at=now() WHERE id=deletion.id RETURNING * INTO deletion;
  receipt:=public.account_deletion_record(command,target_user,'erase_now',NULL,reference_text,reason_text,request_text,deletion,revoked);
 END IF;
 RETURN public.account_deletion_result(receipt);
END $$;

-- Lists up to 20 deletions that are due. With `notify`, queues the completion notice first and
-- leaves a deletion out until its notice is sent or has failed.
CREATE FUNCTION account_erasures_due(notify boolean) RETURNS TABLE(id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF notify THEN
  INSERT INTO public.account_mail(id,deletion_id,user_id,kind)
  SELECT gen_random_uuid(),d.id,d.user_id,'account_erased' FROM public.account_deletions d
  WHERE d.status='scheduled' AND d.erase_after<=now() ORDER BY d.erase_after LIMIT 100
  ON CONFLICT(deletion_id,kind) DO NOTHING;
 END IF;
 RETURN QUERY SELECT d.id FROM public.account_deletions d WHERE d.status='scheduled' AND d.erase_after<=now()
  AND NOT EXISTS(SELECT FROM public.account_mail m WHERE m.deletion_id=d.id AND m.kind='account_erased' AND m.state='queued')
  ORDER BY d.erase_after LIMIT 20;
END $$;

-- Replaces a JSON string equal to `needle`, ignoring case, wherever it appears in `value`.
CREATE FUNCTION account_erasure_redact(value jsonb,needle text,replacement text) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN value IS NULL OR needle IS NULL OR needle='' THEN value
  ELSE regexp_replace(value::text,regexp_replace(to_jsonb(needle)::text,'([!$()*+.:<=>?[\\\]^{|}-])','\\\1','g'),to_jsonb(replacement)::text,'gi')::jsonb END
$$;

-- Permanently erases one due deletion in one transaction, so an interrupted erasure is rolled
-- back and the next pass repeats it. Removes the account, credentials, sessions, factors,
-- memberships, personal settings and pending verifications; security events go with the account.
-- Workspace people records lose name and email, and invitations, access events and workspace
-- commands replace the email with `erased-<id>`. Activity, audit and attribution keep the opaque
-- account ID. Returns false when the deletion was already erased. Errors: P0002 no deletion,
-- 55000 `not due`.
CREATE FUNCTION account_erase(target uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
 deletion public.account_deletions%ROWTYPE;
 person record;
 pseudonym text;
 tenants uuid[];
BEGIN
 -- Take the account lock before the row lock, in the same order as staff commands.
 PERFORM pg_advisory_xact_lock(hashtextextended('account:'||d.user_id::text,0)) FROM public.account_deletions d WHERE d.id=target;
 SELECT * INTO deletion FROM public.account_deletions WHERE id=target FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'deletion unavailable' USING ERRCODE='P0002'; END IF;
 IF deletion.status='erased' THEN RETURN false; END IF;
 IF deletion.status<>'scheduled' OR deletion.erase_after>now() THEN RAISE EXCEPTION 'not due' USING ERRCODE='55000'; END IF;
 SELECT u.name,lower(u.email) AS email INTO person FROM public.users u WHERE u.id=deletion.user_id;
 pseudonym:='erased-'||deletion.user_id::text;
 tenants:=ARRAY(
  SELECT tenant_id FROM public.memberships WHERE user_id=deletion.user_id
  UNION SELECT tenant_id FROM public.workspace_people WHERE user_id=deletion.user_id
  UNION SELECT tenant_id FROM public.workspace_invitations WHERE lower(email)=person.email
  UNION SELECT tenant_id FROM public.invitations WHERE lower(email)=person.email);
 PERFORM 1 FROM public.organizations WHERE id=ANY(tenants) ORDER BY id FOR UPDATE;

 -- Workspaces see the removal by Luma support; the person then reads as a former member.
 INSERT INTO public.workspace_access_events(id,tenant_id,actor_id,actor_kind,event_type,target_id,before_value,after_value)
 SELECT gen_random_uuid(),m.tenant_id,'00000000-0000-0000-0000-000000000000','staff','member.remove',m.id::text,
  jsonb_build_object('id',m.id,'userId',m.user_id,'roleId',COALESCE(m.custom_role_id::text,m.role),
   'roleName',CASE m.role WHEN 'owner' THEN 'Owner' WHEN 'admin' THEN 'Admin' WHEN 'member' THEN 'Member' ELSE r.name END,'status',m.status),NULL
 FROM public.memberships m LEFT JOIN public.workspace_roles r ON r.tenant_id=m.tenant_id AND r.id=m.custom_role_id WHERE m.user_id=deletion.user_id;
 DELETE FROM public.memberships WHERE user_id=deletion.user_id;
 UPDATE public.workspace_people SET name=NULL,email=NULL,is_member=false WHERE user_id=deletion.user_id;
 DELETE FROM public.notification_preferences WHERE user_id=deletion.user_id;
 DELETE FROM public.workspace_layouts WHERE user_id=deletion.user_id;

 IF person.email IS NOT NULL THEN
  UPDATE public.workspace_invitations SET email=pseudonym,status=CASE status WHEN 'pending' THEN 'revoked' ELSE status END WHERE lower(email)=person.email;
  UPDATE public.invitations SET email=pseudonym WHERE lower(email)=person.email;
  UPDATE public.workspace_access_events SET before_value=public.account_erasure_redact(public.account_erasure_redact(before_value,person.email,pseudonym),person.name,'Former member'),
   after_value=public.account_erasure_redact(public.account_erasure_redact(after_value,person.email,pseudonym),person.name,'Former member')
  WHERE tenant_id=ANY(tenants) AND (strpos(lower(COALESCE(before_value::text,'')||COALESCE(after_value::text,'')),person.email)>0
   OR strpos(COALESCE(before_value::text,'')||COALESCE(after_value::text,''),to_jsonb(person.name)::text)>0);
  UPDATE public.workspace_commands SET request=public.account_erasure_redact(public.account_erasure_redact(request,person.email,pseudonym),person.name,'Former member'),
   result=public.account_erasure_redact(public.account_erasure_redact(result,person.email,pseudonym),person.name,'Former member')
  WHERE tenant_id=ANY(tenants) AND (strpos(lower(request::text||result::text),person.email)>0 OR strpos(request::text||result::text,to_jsonb(person.name)::text)>0);
  DELETE FROM public.verifications WHERE value=deletion.user_id::text OR strpos(lower(identifier),person.email)>0 OR strpos(value,deletion.user_id::text)>0;
 END IF;

 -- Sessions, credentials, factors, disablement, security events, account grants and support views
 -- cascade with the account.
 DELETE FROM public.users WHERE id=deletion.user_id;
 UPDATE public.account_deletions SET status='erased',erased_at=now() WHERE id=deletion.id;
 UPDATE public.account_mail m SET state='cancelled' WHERE m.deletion_id=deletion.id AND m.state='queued';
 INSERT INTO public.staff_audit(staff_user_id,staff_session_id,tenant_id,event,request_id,reason,details)
 VALUES(NULL,NULL,NULL,'customer.account.erased','account-erasure:'||deletion.id::text,NULL,
  jsonb_build_object('userId',deletion.user_id,'deletionId',deletion.id,'reasonCategory',deletion.reason_category,'reference',deletion.reference,
   'scheduledAt',deletion.scheduled_at,'eraseRequestedAt',deletion.erase_requested_at,'workspaces',cardinality(tenants)));
 RETURN true;
END $$;

DO $$ DECLARE fn text; BEGIN
 FOREACH fn IN ARRAY ARRAY['account_deletion_lock_workspaces(uuid)','account_deletion_begin(uuid,uuid,text,text,text,timestamptz)',
  'account_deletion_receipt(uuid,uuid,text,text,text,text)','account_deletion_record(uuid,uuid,text,text,text,text,text,account_deletions,integer)',
  'account_deletion_result(identity_support_account_commands)','identity_support_schedule_account_deletion(uuid,uuid,text,text,text,text)',
  'identity_support_restore_account(uuid,uuid,text,text)','identity_support_erase_account_now(uuid,uuid,text,text,text)',
  'account_erasures_due(boolean)','account_erasure_redact(jsonb,text,text)','account_erase(uuid)'] LOOP
  EXECUTE format('ALTER FUNCTION %s OWNER TO luma_account_deletion',fn);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION identity_support_schedule_account_deletion(uuid,uuid,text,text,text,text) TO luma_staff_runtime;
GRANT EXECUTE ON FUNCTION identity_support_restore_account(uuid,uuid,text,text) TO luma_staff_runtime;
GRANT EXECUTE ON FUNCTION identity_support_erase_account_now(uuid,uuid,text,text,text) TO luma_staff_runtime;
GRANT EXECUTE ON FUNCTION account_erasures_due(boolean) TO luma_identity;
GRANT EXECUTE ON FUNCTION account_erase(uuid) TO luma_identity;

-- Account and membership commands refuse to undo a scheduled deletion's effects.
GRANT SELECT(user_id,status) ON account_deletions TO luma_identity_support;

-- Enabling can't undo a scheduled deletion's disablement; restore the account instead. Errors
-- also include 55000 `deletion scheduled`.
CREATE OR REPLACE FUNCTION identity_support_change_account(command uuid,target_user uuid,action_name text,category_name text,reason_text text,request_text text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
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
  IF EXISTS(SELECT FROM public.account_deletions WHERE user_id=target_user AND status='scheduled') THEN RAISE EXCEPTION 'deletion scheduled' USING ERRCODE='55000'; END IF;
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

-- Memberships suspended by a scheduled deletion return only when the account is restored.
GRANT SELECT(suspended_by_kind) ON memberships TO luma_identity_support;
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
  SELECT m.id,m.user_id,m.role,m.custom_role_id,m.status,m.suspended_by_kind INTO target FROM public.memberships m WHERE m.tenant_id=target_tenant AND m.user_id=target_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'member unavailable' USING ERRCODE='P0002'; END IF;
  IF target.status=next_status THEN RAISE EXCEPTION '%', CASE next_status WHEN 'suspended' THEN 'already suspended' ELSE 'already active' END USING ERRCODE='55000'; END IF;
  IF action_name='reactivate' AND target.suspended_by_kind='account_deletion' THEN RAISE EXCEPTION 'deletion scheduled' USING ERRCODE='55000'; END IF;
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

-- Staff see a scheduled deletion on the account page. A disablement added by the deletion is
-- shown as the deletion, not as a separate disablement.
GRANT SELECT ON account_deletions TO luma_staff_views;
CREATE OR REPLACE VIEW staff_account_profile WITH (security_barrier=true) AS
SELECT u.id,u.name,u.email,u.created_at,u.two_factor_enabled,(SELECT count(*) FROM passkeys p WHERE p.user_id=u.id)::integer AS passkey_count,
 d.disabled_at,d.reason_category AS disabled_reason_category,d.reason AS disabled_reason,s.name AS disabled_by_name,
 x.id AS deletion_id,x.scheduled_at AS deletion_scheduled_at,x.erase_after AS deletion_erase_after,x.reason_category AS deletion_reason_category,
 x.reference AS deletion_reference,xs.name AS deletion_scheduled_by_name,x.erase_requested_at AS deletion_erase_requested_at
FROM users u LEFT JOIN account_disablements d ON d.user_id=u.id AND d.reason_category<>'account_deletion' LEFT JOIN staff_users s ON s.id=d.disabled_by
LEFT JOIN account_deletions x ON x.user_id=u.id AND x.status='scheduled' LEFT JOIN staff_users xs ON xs.id=x.scheduled_by
WHERE public.staff_has_account_access(u.id);

-- Background work never acts as an erased account: discovery skips it, and identity pauses its
-- runs as for a suspended member until someone else takes the work over.
CREATE OR REPLACE FUNCTION detection_worker_scopes() RETURNS TABLE(tenant_id uuid, principal_id text)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT DISTINCT ON (s.tenant_id) s.tenant_id,s.principal_id FROM public.commerce_sync_streams s
 JOIN public.organizations o ON o.id=s.tenant_id AND o.status='active'
 WHERE NOT s.paused AND s.blocked IS NULL
 AND NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.tenant_id=s.tenant_id AND m.user_id::text=s.principal_id AND m.status='suspended')
 AND NOT EXISTS (SELECT 1 FROM public.account_disablements d WHERE d.user_id::text=s.principal_id)
 AND NOT EXISTS (SELECT 1 FROM public.account_deletions x WHERE x.user_id::text=s.principal_id AND x.status='erased')
 ORDER BY s.tenant_id,s.created_at,s.id LIMIT 1000
$$;

CREATE OR REPLACE FUNCTION replenishment_worker_scopes() RETURNS TABLE(tenant_id uuid,principal_id text)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT DISTINCT a.tenant_id,a.principal_id FROM public.replenishment_activations a
 JOIN public.organizations o ON o.id=a.tenant_id AND o.status='active'
 WHERE NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.tenant_id=a.tenant_id AND m.user_id::text=a.principal_id AND m.status='suspended')
 AND NOT EXISTS (SELECT 1 FROM public.account_disablements d WHERE d.user_id::text=a.principal_id)
 AND NOT EXISTS (SELECT 1 FROM public.account_deletions x WHERE x.user_id::text=a.principal_id AND x.status='erased')
$$;

CREATE OR REPLACE FUNCTION case_workflow_worker_scopes() RETURNS TABLE(tenant_id uuid,principal_id text)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT DISTINCT a.tenant_id,a.principal_id FROM public.workflow_case_activations a
 JOIN public.organizations o ON o.id=a.tenant_id AND o.status='active'
 WHERE NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.tenant_id=a.tenant_id AND m.user_id::text=a.principal_id AND m.status='suspended')
 AND NOT EXISTS (SELECT 1 FROM public.account_disablements d WHERE d.user_id::text=a.principal_id)
 AND NOT EXISTS (SELECT 1 FROM public.account_deletions x WHERE x.user_id::text=a.principal_id AND x.status='erased')
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
 AND NOT EXISTS (SELECT 1 FROM public.account_deletions x WHERE x.user_id::text=r.document->'actor'->>'id' AND x.status='erased')
$$;

CREATE OR REPLACE FUNCTION procurement_submission_scopes() RETURNS TABLE(tenant_id uuid,principal_id text)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT DISTINCT s.tenant_id,s.principal_id FROM public.procurement_submissions s
 JOIN public.organizations o ON o.id=s.tenant_id AND o.status='active'
 WHERE NOT s.settled AND s.state IN ('approved','submitting','uncertain','submitted')
 AND NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.tenant_id=s.tenant_id AND m.user_id::text=s.principal_id AND m.status='suspended')
 AND NOT EXISTS (SELECT 1 FROM public.account_disablements d WHERE d.user_id::text=s.principal_id)
 AND NOT EXISTS (SELECT 1 FROM public.account_deletions x WHERE x.user_id::text=s.principal_id AND x.status='erased')
$$;

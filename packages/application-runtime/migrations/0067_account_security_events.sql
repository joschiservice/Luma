-- Identity-owned evidence of sign-ins and account security changes. Like sessions, events have
-- no tenant scope. Failures for unknown emails keep a keyed hash of the normalized email instead
-- of a user. Submitted secrets are never stored. Millisecond timestamps keep paging cursors exact.
CREATE TABLE account_security_events (
 id uuid PRIMARY KEY,
 user_id uuid REFERENCES users(id) ON DELETE CASCADE,
 email_hash text CHECK (email_hash ~ '^[0-9a-f]{64}$'),
 event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z-]*(\.[a-z][a-z-]*)+$'),
 outcome text NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
 reason_code text CHECK (reason_code ~ '^[a-z][a-z-]*$'),
 session_id uuid,
 ip_address text CHECK (char_length(ip_address) <= 64),
 user_agent text CHECK (char_length(user_agent) <= 512),
 request_id text NOT NULL CHECK (char_length(request_id) BETWEEN 1 AND 200),
 staff_command_id uuid REFERENCES identity_support_commands(command_id),
 created_at timestamptz(3) NOT NULL DEFAULT now(),
 CHECK (user_id IS NULL OR email_hash IS NULL)
);
CREATE INDEX account_security_events_user ON account_security_events(user_id, created_at DESC, id DESC) WHERE user_id IS NOT NULL;
CREATE INDEX account_security_events_expiry ON account_security_events(created_at);
CREATE INDEX account_security_events_network ON account_security_events(created_at) WHERE ip_address IS NOT NULL OR user_agent IS NOT NULL;
-- A session is signed in once; retried hooks cannot record it twice.
CREATE UNIQUE INDEX account_security_events_sign_in ON account_security_events(session_id) WHERE session_id IS NOT NULL AND outcome = 'succeeded' AND event_type LIKE 'sign-in.%';
-- Retention clears network details and deletes old events; nothing else is updated.
GRANT SELECT, INSERT, DELETE ON account_security_events TO luma_identity;
GRANT UPDATE(ip_address, user_agent) ON account_security_events TO luma_identity;
GRANT INSERT ON account_security_events TO luma_identity_support;

-- Staff read an account's events under its account grant, without email hashes.
GRANT SELECT(id, user_id, event_type, outcome, reason_code, session_id, ip_address, user_agent, request_id, staff_command_id, created_at) ON account_security_events TO luma_staff_views;
CREATE VIEW staff_account_security_events WITH (security_barrier=true) AS
SELECT e.user_id,e.id,e.event_type,e.outcome,e.reason_code,e.session_id,e.ip_address,e.user_agent,e.request_id,e.staff_command_id,e.created_at
FROM account_security_events e WHERE e.user_id IS NOT NULL AND public.staff_has_account_access(e.user_id);
ALTER VIEW staff_account_security_events OWNER TO luma_staff_views;
GRANT SELECT ON staff_account_security_events TO luma_staff_runtime;

-- Staff session revocation records the customer's event with its receipt, in the same transaction.
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
  IF NOT EXISTS(SELECT FROM public.memberships WHERE tenant_id=target_tenant AND user_id=target_user) THEN RAISE EXCEPTION 'member unavailable' USING ERRCODE='P0002'; END IF;
  DELETE FROM public.sessions WHERE user_id=target_user; GET DIAGNOSTICS amount=ROW_COUNT;
  INSERT INTO public.identity_support_commands(command_id,staff_user_id,tenant_id,user_id,reason,revoked_sessions) VALUES(command,actor,target_tenant,target_user,reason_text,amount) RETURNING * INTO receipt;
  INSERT INTO public.staff_audit(staff_user_id,staff_session_id,tenant_id,event,request_id,reason,details) VALUES(actor,NULLIF(current_setting('staff.session_id',true),'')::uuid,target_tenant,'customer.sessions.revoked',request_text,reason_text,jsonb_build_object('commandId',command,'userId',target_user,'revokedSessions',amount,'scope','global-account'));
  INSERT INTO public.account_security_events(id,user_id,event_type,outcome,reason_code,request_id,staff_command_id) VALUES(gen_random_uuid(),target_user,'sessions.revoked-by-staff','succeeded','all',left(request_text,200),command);
 END IF;
 RETURN jsonb_build_object('commandId',receipt.command_id,'revokedSessions',receipt.revoked_sessions,'completedAt',receipt.completed_at);
END $$;

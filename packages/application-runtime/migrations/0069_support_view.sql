-- Read-only support view (ADR-011). Staff open the customer app as one member, with the
-- workspace's consent or the emergency permission. The customer API resolves views only through
-- the functions below, owned by luma_support_view; neither runtime reads the view tables.
DO $$ BEGIN
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='luma_support_view') THEN CREATE ROLE luma_support_view NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO luma_support_view;

-- Keep this list equal to the staff catalog.
ALTER TABLE staff_access DROP CONSTRAINT staff_access_permissions_check;
ALTER TABLE staff_access ADD CONSTRAINT staff_access_permissions_check CHECK(permissions <@ ARRAY['staff.directory.read','staff.workspace.inspect','staff.sessions.revoke','staff.audit.read','staff.accounts.inspect','staff.memberships.manage','staff.view-as','staff.view-as.emergency']::text[]);

-- Consent: support access is allowed until `allowed_until`; NULL means not allowed. Identity owns
-- the row; changes are workspace access events.
CREATE TABLE workspace_support_access (
 tenant_id uuid PRIMARY KEY REFERENCES organizations(id),
 allowed_until timestamptz,
 changed_by uuid NOT NULL,
 changed_at timestamptz NOT NULL DEFAULT now(),
 revision integer NOT NULL DEFAULT 1
);
-- Staff requests for consent. A pending request lapses after seven days; at most one is pending.
CREATE TABLE workspace_support_access_requests (
 tenant_id uuid NOT NULL REFERENCES organizations(id),
 id uuid NOT NULL,
 staff_user_id uuid NOT NULL REFERENCES staff_users(id),
 reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 500),
 duration_hours integer NOT NULL CHECK(duration_hours IN (24,72,168)),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','declined','expired')),
 requested_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 decided_by uuid,
 decided_at timestamptz,
 PRIMARY KEY(tenant_id,id),
 CHECK((status IN ('approved','declined')) = (decided_by IS NOT NULL AND decided_at IS NOT NULL))
);
CREATE UNIQUE INDEX workspace_support_access_pending ON workspace_support_access_requests(tenant_id) WHERE status='pending';
-- The customer runtime never reads which staff member asked.
GRANT SELECT,INSERT,UPDATE ON workspace_support_access TO luma_identity;
GRANT SELECT(tenant_id,id,reason,duration_hours,status,requested_at,expires_at,decided_by,decided_at),UPDATE(status,decided_by,decided_at) ON workspace_support_access_requests TO luma_identity;
GRANT SELECT ON workspace_support_access TO luma_support_view;
GRANT SELECT,INSERT,UPDATE(status) ON workspace_support_access_requests TO luma_support_view;
ALTER TABLE workspace_support_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_support_access FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_support_access_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_support_access_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON workspace_support_access TO luma_identity USING (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_scope ON workspace_support_access_requests TO luma_identity USING (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid);
-- luma_support_view has no login; only the functions below act as it, and each checks its caller.
CREATE POLICY support_view_owner ON workspace_support_access FOR SELECT TO luma_support_view USING (true);
CREATE POLICY support_view_owner ON workspace_support_access_requests TO luma_support_view USING (true) WITH CHECK (true);

-- One view: a staff member seeing the customer app as one member for at most thirty minutes.
-- Only hashes of the single-use handoff token and the cookie token are stored.
CREATE TABLE support_view_sessions (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES organizations(id),
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 staff_user_id uuid NOT NULL REFERENCES staff_users(id),
 staff_session_id uuid NOT NULL,
 mode text NOT NULL CHECK(mode IN ('consent','emergency')),
 reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 500),
 emergency_category text CHECK(emergency_category IN ('security_incident','legal_request')),
 emergency_reference text CHECK(length(emergency_reference) BETWEEN 3 AND 200),
 handoff_hash text NOT NULL UNIQUE CHECK(handoff_hash ~ '^[0-9a-f]{64}$'),
 token_hash text UNIQUE CHECK(token_hash ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 handoff_expires_at timestamptz NOT NULL,
 redeemed_at timestamptz,
 expires_at timestamptz NOT NULL,
 ended_at timestamptz,
 end_reason text CHECK(end_reason IN ('ended','expired','consent_revoked','staff_access_revoked','replaced')),
 CHECK((mode='emergency') = (emergency_category IS NOT NULL AND emergency_reference IS NOT NULL)),
 CHECK((ended_at IS NULL) = (end_reason IS NULL)),
 CHECK(expires_at <= created_at + interval '30 minutes' AND handoff_expires_at <= expires_at)
);
CREATE INDEX support_view_sessions_open ON support_view_sessions(expires_at) WHERE ended_at IS NULL;
CREATE INDEX support_view_sessions_staff ON support_view_sessions(staff_session_id) WHERE ended_at IS NULL;
CREATE INDEX support_view_sessions_tenant ON support_view_sessions(tenant_id,created_at);
-- The first read of each path in a view; later reads of the same path are not recorded again.
CREATE TABLE support_view_reads (
 view_id uuid NOT NULL REFERENCES support_view_sessions(id) ON DELETE CASCADE,
 path text NOT NULL,
 read_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(view_id,path)
);
GRANT SELECT,INSERT,UPDATE ON support_view_sessions TO luma_support_view;
GRANT SELECT,INSERT ON support_view_reads TO luma_support_view;
-- Mail delivery names the member and the view's times.
GRANT SELECT(id,tenant_id,user_id,mode,emergency_category,created_at,expires_at,ended_at,end_reason) ON support_view_sessions TO luma_identity;
ALTER TABLE support_view_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_view_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE support_view_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_view_reads FORCE ROW LEVEL SECURITY;
CREATE POLICY support_view_owner ON support_view_sessions TO luma_support_view USING (true) WITH CHECK (true);
CREATE POLICY support_view_owner ON support_view_reads TO luma_support_view USING (true) WITH CHECK (true);
CREATE POLICY tenant_scope ON support_view_sessions FOR SELECT TO luma_identity USING (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid);

-- What the functions read and write as luma_support_view.
GRANT SELECT ON staff_users,staff_sessions,staff_accounts,staff_access,staff_support_grants TO luma_support_view;
ALTER POLICY staff_grants_read ON staff_support_grants TO luma_staff_views,luma_identity_support,luma_support_view;
GRANT EXECUTE ON FUNCTION staff_has_access(text),staff_has_workspace_access(uuid) TO luma_support_view;
GRANT SELECT(id,status,data_region) ON organizations TO luma_support_view;
CREATE POLICY support_view_organizations ON organizations FOR SELECT TO luma_support_view USING (true);
GRANT SELECT(tenant_id,user_id,role,status) ON memberships TO luma_support_view;
CREATE POLICY support_view_memberships ON memberships FOR SELECT TO luma_support_view USING (true);
GRANT INSERT ON staff_audit TO luma_support_view;
GRANT USAGE ON SEQUENCE staff_audit_sequence_seq TO luma_support_view;
GRANT INSERT ON workspace_access_events TO luma_support_view;
CREATE POLICY support_view_events ON workspace_access_events FOR INSERT TO luma_support_view WITH CHECK (actor_kind='staff');

-- Owners hear about views and requests by email.
ALTER TABLE workspace_mail DROP CONSTRAINT workspace_mail_kind_check;
ALTER TABLE workspace_mail ADD CONSTRAINT workspace_mail_kind_check CHECK(kind IN ('invitation','issues','connections','test','support_view_started','support_view_ended','support_access_requested'));
GRANT INSERT ON workspace_mail TO luma_support_view;
CREATE POLICY support_view_mail ON workspace_mail FOR INSERT TO luma_support_view WITH CHECK (kind IN ('support_view_started','support_view_ended','support_access_requested'));

-- Queues one message per active owner.
CREATE FUNCTION support_view_notify_owners(target_tenant uuid,mail_kind text,target uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 INSERT INTO public.workspace_mail(tenant_id,id,event_key,kind,user_id,target_id)
 SELECT target_tenant,gen_random_uuid(),mail_kind||':'||target::text||':'||m.user_id::text,mail_kind,m.user_id,target
 FROM public.memberships m WHERE m.tenant_id=target_tenant AND m.role='owner' AND m.status='active'
$$;

-- Why an open view can no longer be used, or NULL while it is valid: its thirty minutes or the
-- handoff window passed, the staff member lost admission, the permission or their session, or
-- the workspace's consent ended. Staff idle limits don't apply: the view itself is the activity.
CREATE FUNCTION support_view_failure(sv public.support_view_sessions) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT CASE
  WHEN sv.expires_at<=clock_timestamp() OR (sv.redeemed_at IS NULL AND sv.handoff_expires_at<=clock_timestamp()) THEN 'expired'
  WHEN NOT EXISTS (SELECT FROM public.staff_sessions s JOIN public.staff_users u ON u.id=s.user_id JOIN public.staff_access a ON a.email=lower(u.email)
   WHERE s.id=sv.staff_session_id AND s.user_id=sv.staff_user_id AND s.expires_at>clock_timestamp() AND s.created_at>clock_timestamp()-interval '8 hours'
   AND a.active AND ((a.provider_subject IS NULL AND s.provider_subject IS NULL) OR (a.provider_subject IS NOT NULL AND s.provider_subject=a.provider_subject))
   AND (CASE sv.mode WHEN 'consent' THEN 'staff.view-as' ELSE 'staff.view-as.emergency' END)=ANY(a.permissions)) THEN 'staff_access_revoked'
  WHEN sv.mode='consent' AND NOT EXISTS (SELECT FROM public.workspace_support_access c WHERE c.tenant_id=sv.tenant_id AND c.allowed_until>clock_timestamp()) THEN 'consent_revoked'
 END
$$;

-- Ends an open view and records the end in the staff audit and the customer's Activity. Owners
-- are emailed when an emergency view ends.
CREATE FUNCTION support_view_finish(target uuid,reason_name text,request_text text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE sv public.support_view_sessions%ROWTYPE; paths integer;
BEGIN
 UPDATE public.support_view_sessions SET ended_at=now(),end_reason=reason_name WHERE id=target AND ended_at IS NULL RETURNING * INTO sv;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT count(*) INTO paths FROM public.support_view_reads WHERE view_id=sv.id;
 INSERT INTO public.staff_audit(staff_user_id,staff_session_id,tenant_id,event,request_id,reason,details)
 VALUES(sv.staff_user_id,sv.staff_session_id,sv.tenant_id,'view-as.ended',left(request_text,200),NULL,
  jsonb_build_object('viewId',sv.id,'userId',sv.user_id,'mode',sv.mode,'endReason',reason_name,'paths',paths));
 INSERT INTO public.workspace_access_events(id,tenant_id,actor_id,actor_kind,event_type,target_id,before_value,after_value)
 VALUES(gen_random_uuid(),sv.tenant_id,'00000000-0000-0000-0000-000000000000','staff','support_view.ended',sv.id::text,NULL,
  jsonb_build_object('userId',sv.user_id,'mode',sv.mode,'endReason',reason_name,'paths',paths));
 IF sv.mode='emergency' THEN PERFORM public.support_view_notify_owners(sv.tenant_id,'support_view_ended',sv.id); END IF;
END $$;

-- Starts a view for the calling staff session. Needs a current workspace grant and the target's
-- active membership, plus `staff.view-as` and current consent, or `staff.view-as.emergency`, a
-- reason category and reference, and a staff sign-in within fifteen minutes. Ends the session's
-- other open views. Errors: 42501 access, 22023 input, P0002 no membership, 55000 state
-- (message `consent required`, `member suspended` or `workspace inactive`).
CREATE FUNCTION support_view_start(target_tenant uuid,target_user uuid,mode_name text,reason_text text,category_name text,reference_text text,handoff text,request_text text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
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

-- Exchanges a single-use handoff for the cookie token's hash within the handoff window. Returns
-- NULL when the handoff is unknown, used, expired or the view is no longer valid.
CREATE FUNCTION support_view_redeem(handoff text,token text,request_text text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE sv public.support_view_sessions%ROWTYPE; failure text;
BEGIN
 SELECT * INTO sv FROM public.support_view_sessions WHERE handoff_hash=handoff FOR UPDATE;
 IF NOT FOUND OR sv.redeemed_at IS NOT NULL OR sv.ended_at IS NOT NULL THEN RETURN NULL; END IF;
 failure:=public.support_view_failure(sv);
 IF failure IS NOT NULL THEN PERFORM public.support_view_finish(sv.id,failure,request_text); RETURN NULL; END IF;
 UPDATE public.support_view_sessions SET token_hash=token,redeemed_at=now() WHERE id=sv.id;
 RETURN jsonb_build_object('id',sv.id,'tenantId',sv.tenant_id);
END $$;

-- Checks a view on every request. Ends it, with its evidence, when it is no longer valid.
-- `target_tenant` NULL accepts any workspace. A non-NULL `read_path` records the first read of
-- that path. States: active, ended (with reason), other (another workspace), missing.
CREATE FUNCTION support_view_resolve(token text,target_tenant uuid,read_path text,request_text text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE sv public.support_view_sessions%ROWTYPE; failure text; recorded integer; relative text;
BEGIN
 SELECT * INTO sv FROM public.support_view_sessions WHERE token_hash=token;
 IF NOT FOUND THEN RETURN jsonb_build_object('state','missing'); END IF;
 IF sv.ended_at IS NULL THEN
  failure:=public.support_view_failure(sv);
  IF failure IS NOT NULL THEN
   PERFORM public.support_view_finish(sv.id,failure,request_text);
   SELECT * INTO sv FROM public.support_view_sessions WHERE id=sv.id;
  END IF;
 END IF;
 IF sv.ended_at IS NOT NULL THEN RETURN jsonb_build_object('state','ended','reason',sv.end_reason,'tenantId',sv.tenant_id); END IF;
 IF target_tenant IS NOT NULL AND target_tenant<>sv.tenant_id THEN RETURN jsonb_build_object('state','other','tenantId',sv.tenant_id); END IF;
 IF read_path IS NOT NULL THEN
  INSERT INTO public.support_view_reads(view_id,path) VALUES(sv.id,left(read_path,300)) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS recorded=ROW_COUNT;
  IF recorded>0 THEN
   relative:=COALESCE(NULLIF(regexp_replace(left(read_path,300),'^/v[0-9]+/organizations/[0-9a-fA-F-]{36}',''),''),'/');
   INSERT INTO public.staff_audit(staff_user_id,staff_session_id,tenant_id,event,request_id,reason,details)
   VALUES(sv.staff_user_id,sv.staff_session_id,sv.tenant_id,'view-as.read',left(request_text,200),NULL,
    jsonb_build_object('viewId',sv.id,'userId',sv.user_id,'path',left(read_path,300)));
   INSERT INTO public.workspace_access_events(id,tenant_id,actor_id,actor_kind,event_type,target_id,before_value,after_value)
   VALUES(gen_random_uuid(),sv.tenant_id,'00000000-0000-0000-0000-000000000000','staff','support_view.read',sv.id::text,NULL,
    jsonb_build_object('userId',sv.user_id,'path',relative));
  END IF;
 END IF;
 RETURN jsonb_build_object('state','active','id',sv.id,'tenantId',sv.tenant_id,'userId',sv.user_id,'mode',sv.mode,'expiresAt',sv.expires_at);
END $$;

-- Ends the view a cookie token names, when it is open. Returns whether it ended now.
CREATE FUNCTION support_view_end(token text,request_text text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE target uuid;
BEGIN
 SELECT id INTO target FROM public.support_view_sessions WHERE token_hash=token AND ended_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM public.support_view_finish(target,'ended',request_text);
 RETURN true;
END $$;

-- Ends open views that are no longer valid, so views nobody used again still record their end.
-- Safe to run concurrently; returns how many views ended.
CREATE FUNCTION support_view_sweep(request_text text) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE sv public.support_view_sessions%ROWTYPE; failure text; ended integer:=0;
BEGIN
 FOR sv IN SELECT * FROM public.support_view_sessions WHERE ended_at IS NULL ORDER BY expires_at LIMIT 200 FOR UPDATE SKIP LOCKED LOOP
  failure:=public.support_view_failure(sv);
  IF failure IS NOT NULL THEN PERFORM public.support_view_finish(sv.id,failure,request_text); ended:=ended+1; END IF;
 END LOOP;
 RETURN ended;
END $$;

-- Staff ask a workspace for consent. Needs a current workspace grant and `staff.view-as`.
-- Errors: 42501 access, 22023 input, 55000 state (message `request pending`, `access allowed`
-- or `workspace inactive`).
CREATE FUNCTION support_access_request(target_tenant uuid,reason_text text,hours integer,request_text text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
 actor uuid:=NULLIF(current_setting('staff.user_id',true),'')::uuid;
 request public.workspace_support_access_requests%ROWTYPE;
BEGIN
 IF NOT public.staff_has_workspace_access(target_tenant) OR NOT public.staff_has_access('staff.view-as') THEN RAISE EXCEPTION 'staff access denied' USING ERRCODE='42501'; END IF;
 IF reason_text IS NULL OR length(trim(reason_text)) NOT BETWEEN 10 AND 500 THEN RAISE EXCEPTION 'invalid reason' USING ERRCODE='22023'; END IF;
 IF hours IS NULL OR hours NOT IN (24,72,168) THEN RAISE EXCEPTION 'invalid duration' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT FROM public.organizations WHERE id=target_tenant AND data_region='EU') THEN RAISE EXCEPTION 'region unavailable' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT FROM public.organizations WHERE id=target_tenant AND status='active') THEN RAISE EXCEPTION 'workspace inactive' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT FROM public.workspace_support_access WHERE tenant_id=target_tenant AND allowed_until>clock_timestamp()) THEN RAISE EXCEPTION 'access allowed' USING ERRCODE='55000'; END IF;
 UPDATE public.workspace_support_access_requests SET status='expired' WHERE tenant_id=target_tenant AND status='pending' AND expires_at<=clock_timestamp();
 BEGIN
  INSERT INTO public.workspace_support_access_requests(tenant_id,id,staff_user_id,reason,duration_hours,expires_at)
  VALUES(target_tenant,gen_random_uuid(),actor,trim(reason_text),hours,now()+interval '7 days') RETURNING * INTO request;
 EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'request pending' USING ERRCODE='55000';
 END;
 INSERT INTO public.staff_audit(staff_user_id,staff_session_id,tenant_id,event,request_id,reason,details)
 VALUES(actor,NULLIF(current_setting('staff.session_id',true),'')::uuid,target_tenant,'support-access.requested',left(request_text,200),request.reason,
  jsonb_build_object('requestId',request.id,'durationHours',hours));
 INSERT INTO public.workspace_access_events(id,tenant_id,actor_id,actor_kind,event_type,target_id,before_value,after_value)
 VALUES(gen_random_uuid(),target_tenant,'00000000-0000-0000-0000-000000000000','staff','support_access.requested',request.id::text,NULL,
  jsonb_build_object('durationHours',hours,'status','pending'));
 PERFORM public.support_view_notify_owners(target_tenant,'support_access_requested',request.id);
 RETURN jsonb_build_object('id',request.id,'durationHours',hours,'requestedAt',request.requested_at,'expiresAt',request.expires_at);
END $$;

-- The workspace's consent and pending request, for the staff workspace page under its grant.
CREATE FUNCTION support_access_status(target_tenant uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE allowed timestamptz; request public.workspace_support_access_requests%ROWTYPE;
BEGIN
 IF NOT public.staff_has_workspace_access(target_tenant) THEN RAISE EXCEPTION 'staff access denied' USING ERRCODE='42501'; END IF;
 SELECT allowed_until INTO allowed FROM public.workspace_support_access WHERE tenant_id=target_tenant AND allowed_until>clock_timestamp();
 SELECT * INTO request FROM public.workspace_support_access_requests WHERE tenant_id=target_tenant AND status='pending' AND expires_at>clock_timestamp();
 RETURN jsonb_build_object('allowedUntil',allowed,'request',CASE WHEN request.id IS NULL THEN NULL ELSE
  jsonb_build_object('id',request.id,'durationHours',request.duration_hours,'requestedAt',request.requested_at,'expiresAt',request.expires_at) END);
END $$;

DO $$ DECLARE fn text; BEGIN
 FOREACH fn IN ARRAY ARRAY['support_view_notify_owners(uuid,text,uuid)','support_view_failure(support_view_sessions)','support_view_finish(uuid,text,text)',
  'support_view_start(uuid,uuid,text,text,text,text,text,text)','support_view_redeem(text,text,text)','support_view_resolve(text,uuid,text,text)',
  'support_view_end(text,text)','support_view_sweep(text)','support_access_request(uuid,text,integer,text)','support_access_status(uuid)'] LOOP
  EXECUTE format('ALTER FUNCTION %s OWNER TO luma_support_view',fn);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION support_view_start(uuid,uuid,text,text,text,text,text,text),support_access_request(uuid,text,integer,text),support_access_status(uuid) TO luma_staff_runtime;
GRANT EXECUTE ON FUNCTION support_view_redeem(text,text,text),support_view_resolve(text,uuid,text,text),support_view_end(text,text),support_view_sweep(text) TO luma_identity;

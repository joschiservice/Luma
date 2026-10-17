-- Staff inspection is customer-approved. Staff request access with a reason; a workspace's people
-- with `support_access.manage` (workspace) or the person themselves (account) approve or decline in
-- the app. Approval opens thirty minutes; unanswered requests lapse after 24 hours; customers can
-- revoke approved access early. `staff.inspect.emergency` opens access without approval for a
-- security incident or legal request, with a reference and a recent staff sign-in; it can't be
-- revoked by the customer and owners (or the person) are emailed.
--
-- Every state is recorded where the customer looks, by triggers on the request tables, so no state
-- commits without its record: workspace requests in the workspace's Activity, account requests in
-- the person's security events. A support grant needs an approved, unexpired request (checked when
-- the grant is inserted and on every use), so no grant exists without an approval record.
--
-- Workspace requests belong with support consent and run as `luma_support_view`; account requests
-- belong with identity's support commands and run as `luma_identity_support`.

-- Grants opened before approval existed are short-lived development data; remove them so every
-- grant references a request.
DELETE FROM staff_support_grants;
DELETE FROM staff_account_grants;

-- Keep this list equal to the staff catalog.
ALTER TABLE staff_access DROP CONSTRAINT staff_access_permissions_check;
ALTER TABLE staff_access ADD CONSTRAINT staff_access_permissions_check CHECK(permissions <@ ARRAY['staff.directory.read','staff.workspace.inspect','staff.sessions.revoke','staff.audit.read','staff.accounts.inspect','staff.memberships.manage','staff.view-as','staff.view-as.emergency','staff.accounts.manage','staff.accounts.delete','staff.inspect.emergency']::text[]);

-- One request per row. `expires_at` is when an unanswered request lapses; `access_expires_at` is
-- when approved access ends. Emergency requests are approved when created, by nobody.
CREATE TABLE workspace_inspection_requests (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES organizations(id),
 staff_user_id uuid NOT NULL REFERENCES staff_users(id),
 mode text NOT NULL CHECK(mode IN ('consent','emergency')),
 reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 500),
 emergency_category text CHECK(emergency_category IN ('security_incident','legal_request')),
 emergency_reference text CHECK(length(emergency_reference) BETWEEN 3 AND 200),
 status text NOT NULL CHECK(status IN ('pending','approved','declined','expired','revoked')),
 requested_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL CHECK(expires_at <= requested_at + interval '24 hours'),
 decided_by uuid,
 decided_at timestamptz,
 access_expires_at timestamptz,
 revoked_by uuid,
 revoked_at timestamptz,
 CHECK((mode='emergency') = (emergency_category IS NOT NULL AND emergency_reference IS NOT NULL)),
 CHECK(mode='consent' OR status='approved'),
 CHECK((status IN ('approved','declined','revoked')) = (decided_at IS NOT NULL)),
 CHECK(mode='emergency' OR (status IN ('approved','declined','revoked')) = (decided_by IS NOT NULL)),
 CHECK((status IN ('approved','revoked')) = (access_expires_at IS NOT NULL)),
 CHECK(access_expires_at <= decided_at + interval '30 minutes'),
 CHECK((status='revoked') = (revoked_at IS NOT NULL AND revoked_by IS NOT NULL))
);
CREATE UNIQUE INDEX workspace_inspection_pending ON workspace_inspection_requests(tenant_id,staff_user_id) WHERE status='pending';
CREATE INDEX workspace_inspection_tenant ON workspace_inspection_requests(tenant_id,requested_at DESC);
CREATE INDEX workspace_inspection_staff ON workspace_inspection_requests(staff_user_id,tenant_id,requested_at DESC);
CREATE INDEX workspace_inspection_lapse ON workspace_inspection_requests(expires_at) WHERE status='pending';

CREATE TABLE account_inspection_requests (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 staff_user_id uuid NOT NULL REFERENCES staff_users(id),
 mode text NOT NULL CHECK(mode IN ('consent','emergency')),
 reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 500),
 emergency_category text CHECK(emergency_category IN ('security_incident','legal_request')),
 emergency_reference text CHECK(length(emergency_reference) BETWEEN 3 AND 200),
 status text NOT NULL CHECK(status IN ('pending','approved','declined','expired','revoked')),
 requested_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL CHECK(expires_at <= requested_at + interval '24 hours'),
 decided_by uuid CHECK(decided_by=user_id),
 decided_at timestamptz,
 access_expires_at timestamptz,
 revoked_by uuid CHECK(revoked_by=user_id),
 revoked_at timestamptz,
 CHECK((mode='emergency') = (emergency_category IS NOT NULL AND emergency_reference IS NOT NULL)),
 CHECK(mode='consent' OR status='approved'),
 CHECK((status IN ('approved','declined','revoked')) = (decided_at IS NOT NULL)),
 CHECK(mode='emergency' OR (status IN ('approved','declined','revoked')) = (decided_by IS NOT NULL)),
 CHECK((status IN ('approved','revoked')) = (access_expires_at IS NOT NULL)),
 CHECK(access_expires_at <= decided_at + interval '30 minutes'),
 CHECK((status='revoked') = (revoked_at IS NOT NULL AND revoked_by IS NOT NULL))
);
CREATE UNIQUE INDEX account_inspection_pending ON account_inspection_requests(user_id,staff_user_id) WHERE status='pending';
CREATE INDEX account_inspection_user ON account_inspection_requests(user_id,requested_at DESC);
CREATE INDEX account_inspection_staff ON account_inspection_requests(staff_user_id,user_id,requested_at DESC);
CREATE INDEX account_inspection_lapse ON account_inspection_requests(expires_at) WHERE status='pending';

ALTER TABLE staff_support_grants ADD COLUMN request_id uuid NOT NULL REFERENCES workspace_inspection_requests(id);
ALTER TABLE staff_account_grants ADD COLUMN request_id uuid NOT NULL REFERENCES account_inspection_requests(id) ON DELETE CASCADE;

-- The lifecycle, whichever role writes: pending → approved | declined | expired, and consented
-- approved → revoked. Approval sets thirty minutes from now; answers need an unlapsed request and
-- lapsing a lapsed one. The request itself never changes.
CREATE FUNCTION inspection_request_transition() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF (to_jsonb(NEW) - ARRAY['status','decided_by','decided_at','access_expires_at','revoked_by','revoked_at'])
  IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','decided_by','decided_at','access_expires_at','revoked_by','revoked_at'])
 THEN RAISE EXCEPTION 'request immutable' USING ERRCODE='55000'; END IF;
 IF OLD.status='pending' AND NEW.status IN ('approved','declined') THEN
  IF OLD.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'request lapsed' USING ERRCODE='55000'; END IF;
  NEW.decided_at:=now();
  NEW.access_expires_at:=CASE WHEN NEW.status='approved' THEN now()+interval '30 minutes' END;
  NEW.revoked_by:=NULL; NEW.revoked_at:=NULL;
 ELSIF OLD.status='pending' AND NEW.status='expired' THEN
  IF OLD.expires_at>clock_timestamp() THEN RAISE EXCEPTION 'request pending' USING ERRCODE='55000'; END IF;
  NEW.decided_by:=NULL; NEW.decided_at:=NULL; NEW.access_expires_at:=NULL; NEW.revoked_by:=NULL; NEW.revoked_at:=NULL;
 ELSIF OLD.status='approved' AND NEW.status='revoked' AND OLD.mode='consent' THEN
  IF OLD.access_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'access ended' USING ERRCODE='55000'; END IF;
  NEW.decided_by:=OLD.decided_by; NEW.decided_at:=OLD.decided_at; NEW.access_expires_at:=OLD.access_expires_at;
  NEW.revoked_at:=now();
 ELSE
  RAISE EXCEPTION 'request answered' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inspection_request_transition BEFORE UPDATE ON workspace_inspection_requests FOR EACH ROW EXECUTE FUNCTION inspection_request_transition();
CREATE TRIGGER inspection_request_transition BEFORE UPDATE ON account_inspection_requests FOR EACH ROW EXECUTE FUNCTION inspection_request_transition();
REVOKE ALL ON FUNCTION inspection_request_transition() FROM PUBLIC;

-- Records each state in the workspace's Activity. Staff actions read as Luma support (nil UUID,
-- `staff`), lapses as Luma (nil UUID) and answers as the member who gave them. The staff identity,
-- reference and reason stay out of the record.
CREATE FUNCTION support_inspection_record() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE kind text; actor uuid:='00000000-0000-0000-0000-000000000000'; actor_type text:='member'; after jsonb;
BEGIN
 IF TG_OP='INSERT' THEN
  actor_type:='staff';
  IF NEW.mode='emergency' THEN
   kind:='support_inspection.emergency_opened';
   after:=jsonb_build_object('status','approved','category',NEW.emergency_category,'expiresAt',NEW.access_expires_at);
  ELSE
   kind:='support_inspection.requested';
   after:=jsonb_build_object('status','pending','lapsesAt',NEW.expires_at);
  END IF;
 ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
  kind:='support_inspection.'||NEW.status;
  actor:=COALESCE(NEW.revoked_by,NEW.decided_by,actor);
  after:=jsonb_build_object('status',NEW.status,'expiresAt',NEW.access_expires_at);
 ELSE
  RETURN NULL;
 END IF;
 INSERT INTO public.workspace_access_events(id,tenant_id,actor_id,actor_kind,event_type,target_id,before_value,after_value)
 VALUES(gen_random_uuid(),NEW.tenant_id,actor,actor_type,kind,NEW.id::text,
  CASE WHEN TG_OP='UPDATE' THEN jsonb_build_object('status',OLD.status) END,after);
 RETURN NULL;
END $$;
CREATE TRIGGER customer_inspection_record AFTER INSERT OR UPDATE OF status ON workspace_inspection_requests FOR EACH ROW EXECUTE FUNCTION support_inspection_record();

-- Records each state in the person's security events. Staff actions carry the request ID as their
-- staff command ID, so they read as by Luma support; the person's own answers and lapses don't.
CREATE FUNCTION identity_record_account_inspection() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE kind text; reason_name text; by_staff boolean:=false;
BEGIN
 IF TG_OP='INSERT' THEN
  by_staff:=true;
  IF NEW.mode='emergency' THEN
   kind:='support-inspection.emergency-opened'; reason_name:=replace(NEW.emergency_category,'_','-');
  ELSE
   kind:='support-inspection.requested';
  END IF;
 ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
  kind:='support-inspection.'||NEW.status;
 ELSE
  RETURN NULL;
 END IF;
 INSERT INTO public.account_security_events(id,user_id,event_type,outcome,reason_code,request_id,staff_command_id)
 VALUES(gen_random_uuid(),NEW.user_id,kind,'succeeded',reason_name,
  COALESCE(NULLIF(left(current_setting('staff.request_id',true),200),''),NULLIF(left(current_setting('app.request_id',true),200),''),NEW.id::text),
  CASE WHEN by_staff THEN NEW.id END);
 RETURN NULL;
END $$;
CREATE TRIGGER customer_inspection_record AFTER INSERT OR UPDATE OF status ON account_inspection_requests FOR EACH ROW EXECUTE FUNCTION identity_record_account_inspection();

-- A grant needs an approved request of the same staff member and target whose access hasn't
-- ended. It takes the request's reason and ends with its access. Locking the request serializes
-- with a concurrent revocation.
CREATE FUNCTION support_inspection_admit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.workspace_inspection_requests%ROWTYPE;
BEGIN
 SELECT * INTO r FROM public.workspace_inspection_requests WHERE id=NEW.request_id FOR SHARE;
 IF NOT FOUND OR r.tenant_id<>NEW.tenant_id OR r.staff_user_id<>NEW.staff_user_id OR r.status<>'approved' OR r.access_expires_at<=clock_timestamp()
 THEN RAISE EXCEPTION 'inspection not approved' USING ERRCODE='42501'; END IF;
 NEW.reason:=r.reason;
 NEW.expires_at:=LEAST(COALESCE(NEW.expires_at,r.access_expires_at),r.access_expires_at);
 RETURN NEW;
END $$;
CREATE TRIGGER inspection_admission BEFORE INSERT ON staff_support_grants FOR EACH ROW EXECUTE FUNCTION support_inspection_admit();

CREATE FUNCTION identity_admit_account_inspection() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.account_inspection_requests%ROWTYPE;
BEGIN
 SELECT * INTO r FROM public.account_inspection_requests WHERE id=NEW.request_id FOR SHARE;
 IF NOT FOUND OR r.user_id<>NEW.user_id OR r.staff_user_id<>NEW.staff_user_id OR r.status<>'approved' OR r.access_expires_at<=clock_timestamp()
 THEN RAISE EXCEPTION 'inspection not approved' USING ERRCODE='42501'; END IF;
 NEW.reason:=r.reason;
 NEW.expires_at:=LEAST(COALESCE(NEW.expires_at,r.access_expires_at),r.access_expires_at);
 RETURN NEW;
END $$;
CREATE TRIGGER inspection_admission BEFORE INSERT ON staff_account_grants FOR EACH ROW EXECUTE FUNCTION identity_admit_account_inspection();

-- Whether a grant's request still allows access: approved, not revoked, not ended. Callers of the
-- grant checks below need no access to the request tables.
CREATE FUNCTION support_inspection_open(request uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT FROM public.workspace_inspection_requests WHERE id=request AND status='approved' AND access_expires_at>clock_timestamp())
$$;
CREATE FUNCTION identity_account_inspection_open(request uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT FROM public.account_inspection_requests WHERE id=request AND status='approved' AND access_expires_at>clock_timestamp())
$$;

CREATE OR REPLACE FUNCTION staff_has_workspace_access(target uuid) RETURNS boolean LANGUAGE sql VOLATILE SET search_path=pg_catalog,public AS $$
 SELECT public.identity_tenant_region(target)=(SELECT region FROM public.luma_cell_region) AND public.staff_has_access('staff.workspace.inspect') AND EXISTS (SELECT FROM public.staff_support_grants g WHERE g.id=NULLIF(current_setting('staff.grant_id',true),'')::uuid AND g.staff_user_id=NULLIF(current_setting('staff.user_id',true),'')::uuid AND g.staff_session_id=NULLIF(current_setting('staff.session_id',true),'')::uuid AND g.tenant_id=target AND g.expires_at>clock_timestamp() AND public.support_inspection_open(g.request_id))
$$;
CREATE OR REPLACE FUNCTION staff_inspected_workspace() RETURNS uuid LANGUAGE sql VOLATILE SET search_path=pg_catalog,public AS $$
 SELECT g.tenant_id FROM public.staff_support_grants g
 WHERE g.id=NULLIF(current_setting('staff.grant_id',true),'')::uuid
  AND g.staff_user_id=NULLIF(current_setting('staff.user_id',true),'')::uuid
  AND g.staff_session_id=NULLIF(current_setting('staff.session_id',true),'')::uuid
  AND public.identity_tenant_region(g.tenant_id)=(SELECT region FROM public.luma_cell_region) AND g.expires_at>clock_timestamp() AND public.staff_has_access('staff.workspace.inspect')
  AND public.support_inspection_open(g.request_id)
$$;
CREATE OR REPLACE FUNCTION staff_has_account_access(target uuid) RETURNS boolean LANGUAGE sql VOLATILE SET search_path=pg_catalog,public AS $$
 SELECT public.staff_has_access('staff.accounts.inspect') AND EXISTS (SELECT FROM public.staff_account_grants g WHERE g.id=NULLIF(current_setting('staff.grant_id',true),'')::uuid AND g.staff_user_id=NULLIF(current_setting('staff.user_id',true),'')::uuid AND g.staff_session_id=NULLIF(current_setting('staff.session_id',true),'')::uuid AND g.user_id=target AND g.expires_at>clock_timestamp() AND public.identity_account_inspection_open(g.request_id))
$$;

-- Owners are emailed about requests and emergency access, like support access requests.
ALTER TABLE workspace_mail DROP CONSTRAINT workspace_mail_kind_check;
ALTER TABLE workspace_mail ADD CONSTRAINT workspace_mail_kind_check
 CHECK (kind IN ('invitation','issues','connections','test','support_view_started','support_view_ended','support_access_requested','morning_brief','support_inspection_requested','support_inspection_emergency'));
ALTER POLICY support_view_mail ON workspace_mail WITH CHECK (kind IN ('support_view_started','support_view_ended','support_access_requested','support_inspection_requested','support_inspection_emergency'));

-- The person is emailed about requests and emergency access to their account.
ALTER TABLE account_mail ALTER COLUMN deletion_id DROP NOT NULL;
ALTER TABLE account_mail ADD COLUMN inspection_request_id uuid REFERENCES account_inspection_requests(id) ON DELETE CASCADE;
ALTER TABLE account_mail DROP CONSTRAINT account_mail_kind_check;
ALTER TABLE account_mail ADD CONSTRAINT account_mail_kind_check CHECK(kind IN ('deletion_scheduled','deletion_restored','account_erased','inspection_requested','inspection_emergency'));
ALTER TABLE account_mail ADD CONSTRAINT account_mail_subject CHECK(CASE WHEN kind LIKE 'inspection_%' THEN inspection_request_id IS NOT NULL AND deletion_id IS NULL ELSE deletion_id IS NOT NULL AND inspection_request_id IS NULL END);
ALTER TABLE account_mail ADD CONSTRAINT account_mail_inspection UNIQUE(inspection_request_id,kind);

-- Staff ask a workspace for inspection (`consent`), or open emergency access. Needs
-- `staff.directory.read` and `staff.workspace.inspect`; emergency access also needs
-- `staff.inspect.emergency`, a category, a reference and a staff sign-in within fifteen minutes.
-- Errors: 42501 access, 22023 input, P0002 workspace unavailable, 55000 state (message
-- `request pending`, `access approved` or `consent unavailable`).
CREATE FUNCTION support_inspection_request(target_tenant uuid,mode_name text,reason_text text,category_name text,reference_text text,request_text text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
 actor uuid:=NULLIF(current_setting('staff.user_id',true),'')::uuid;
 staff_session uuid:=NULLIF(current_setting('staff.session_id',true),'')::uuid;
 r public.workspace_inspection_requests%ROWTYPE;
 workspace_status text;
BEGIN
 IF mode_name IS NULL OR mode_name NOT IN ('consent','emergency') THEN RAISE EXCEPTION 'invalid mode' USING ERRCODE='22023'; END IF;
 IF NOT public.staff_has_access('staff.directory.read') OR NOT public.staff_has_access('staff.workspace.inspect')
  OR (mode_name='emergency' AND (NOT public.staff_has_access('staff.inspect.emergency') OR NOT EXISTS(SELECT FROM public.staff_sessions WHERE id=staff_session AND created_at>clock_timestamp()-interval '15 minutes')))
 THEN RAISE EXCEPTION 'staff access denied' USING ERRCODE='42501'; END IF;
 IF reason_text IS NULL OR length(trim(reason_text)) NOT BETWEEN 10 AND 500 THEN RAISE EXCEPTION 'invalid reason' USING ERRCODE='22023'; END IF;
 IF (mode_name='emergency' AND (category_name IS NULL OR category_name NOT IN ('security_incident','legal_request') OR reference_text IS NULL OR length(trim(reference_text)) NOT BETWEEN 3 AND 200))
  OR (mode_name='consent' AND (category_name IS NOT NULL OR reference_text IS NOT NULL))
 THEN RAISE EXCEPTION 'invalid emergency details' USING ERRCODE='22023'; END IF;
 SELECT status INTO workspace_status FROM public.organizations WHERE id=target_tenant AND data_region=(SELECT region FROM public.luma_cell_region);
 IF NOT FOUND THEN RAISE EXCEPTION 'workspace unavailable' USING ERRCODE='P0002'; END IF;
 IF mode_name='consent' THEN
  -- Nobody can answer in a suspended or closed workspace.
  IF workspace_status<>'active' THEN RAISE EXCEPTION 'consent unavailable' USING ERRCODE='55000'; END IF;
  UPDATE public.workspace_inspection_requests SET status='expired' WHERE tenant_id=target_tenant AND staff_user_id=actor AND status='pending' AND expires_at<=clock_timestamp();
  IF EXISTS(SELECT FROM public.workspace_inspection_requests WHERE tenant_id=target_tenant AND staff_user_id=actor AND status='approved' AND access_expires_at>clock_timestamp())
  THEN RAISE EXCEPTION 'access approved' USING ERRCODE='55000'; END IF;
  BEGIN
   INSERT INTO public.workspace_inspection_requests(id,tenant_id,staff_user_id,mode,reason,status,expires_at)
   VALUES(gen_random_uuid(),target_tenant,actor,'consent',trim(reason_text),'pending',now()+interval '24 hours') RETURNING * INTO r;
  EXCEPTION WHEN unique_violation THEN
   RAISE EXCEPTION 'request pending' USING ERRCODE='55000';
  END;
  PERFORM public.support_view_notify_owners(target_tenant,'support_inspection_requested',r.id);
 ELSE
  INSERT INTO public.workspace_inspection_requests(id,tenant_id,staff_user_id,mode,reason,emergency_category,emergency_reference,status,expires_at,decided_at,access_expires_at)
  VALUES(gen_random_uuid(),target_tenant,actor,'emergency',trim(reason_text),category_name,trim(reference_text),'approved',now(),now(),now()+interval '30 minutes') RETURNING * INTO r;
  PERFORM public.support_view_notify_owners(target_tenant,'support_inspection_emergency',r.id);
 END IF;
 INSERT INTO public.staff_audit(staff_user_id,staff_session_id,tenant_id,event,request_id,reason,details)
 VALUES(actor,staff_session,target_tenant,CASE mode_name WHEN 'emergency' THEN 'workspace.access.emergency' ELSE 'workspace.access.requested' END,left(request_text,200),r.reason,
  jsonb_build_object('requestId',r.id,'mode',mode_name,'category',category_name,'reference',r.emergency_reference));
 RETURN jsonb_build_object('id',r.id,'mode',r.mode,'status',r.status,'requestedAt',r.requested_at,'expiresAt',r.expires_at,'decidedAt',r.decided_at,'accessExpiresAt',r.access_expires_at,'revokedAt',r.revoked_at);
END $$;

-- The calling staff member's latest request for a workspace, or NULL. Lapsed requests and ended
-- access read as `expired`.
CREATE FUNCTION support_inspection_status(target_tenant uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.workspace_inspection_requests%ROWTYPE;
BEGIN
 IF NOT public.staff_has_access('staff.workspace.inspect') THEN RAISE EXCEPTION 'staff access denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM public.workspace_inspection_requests WHERE tenant_id=target_tenant AND staff_user_id=NULLIF(current_setting('staff.user_id',true),'')::uuid
  AND public.identity_tenant_region(target_tenant)=(SELECT region FROM public.luma_cell_region) ORDER BY requested_at DESC LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('id',r.id,'mode',r.mode,'requestedAt',r.requested_at,'expiresAt',r.expires_at,'decidedAt',r.decided_at,'accessExpiresAt',r.access_expires_at,'revokedAt',r.revoked_at,
  'status',CASE WHEN r.status='pending' AND r.expires_at<=clock_timestamp() THEN 'expired' WHEN r.status='approved' AND r.access_expires_at<=clock_timestamp() THEN 'expired' ELSE r.status END);
END $$;

-- Lapses unanswered requests, so the lapse is recorded even if nobody looks. Safe to run
-- concurrently; returns how many lapsed.
CREATE FUNCTION support_inspection_sweep() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE lapsed integer;
BEGIN
 WITH due AS (SELECT id FROM public.workspace_inspection_requests WHERE status='pending' AND expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 200 FOR UPDATE SKIP LOCKED)
 UPDATE public.workspace_inspection_requests r SET status='expired' FROM due WHERE r.id=due.id;
 GET DIAGNOSTICS lapsed=ROW_COUNT;
 RETURN lapsed;
END $$;

-- Staff ask a person for access to their account, or open emergency access. Needs
-- `staff.directory.read` and `staff.accounts.inspect`; emergency access as for workspaces.
-- Errors: 42501 access, 22023 input, P0002 account unavailable, 55000 state (message
-- `request pending`, `access approved` or `account consent unavailable`).
CREATE FUNCTION identity_account_inspection_request(target_user uuid,mode_name text,reason_text text,category_name text,reference_text text,request_text text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
 actor uuid:=NULLIF(current_setting('staff.user_id',true),'')::uuid;
 staff_session uuid:=NULLIF(current_setting('staff.session_id',true),'')::uuid;
 r public.account_inspection_requests%ROWTYPE;
BEGIN
 IF mode_name IS NULL OR mode_name NOT IN ('consent','emergency') THEN RAISE EXCEPTION 'invalid mode' USING ERRCODE='22023'; END IF;
 IF NOT public.staff_has_access('staff.directory.read') OR NOT public.staff_has_access('staff.accounts.inspect')
  OR (mode_name='emergency' AND (NOT public.staff_has_access('staff.inspect.emergency') OR NOT EXISTS(SELECT FROM public.staff_sessions WHERE id=staff_session AND created_at>clock_timestamp()-interval '15 minutes')))
 THEN RAISE EXCEPTION 'staff access denied' USING ERRCODE='42501'; END IF;
 IF reason_text IS NULL OR length(trim(reason_text)) NOT BETWEEN 10 AND 500 THEN RAISE EXCEPTION 'invalid reason' USING ERRCODE='22023'; END IF;
 IF (mode_name='emergency' AND (category_name IS NULL OR category_name NOT IN ('security_incident','legal_request') OR reference_text IS NULL OR length(trim(reference_text)) NOT BETWEEN 3 AND 200))
  OR (mode_name='consent' AND (category_name IS NOT NULL OR reference_text IS NOT NULL))
 THEN RAISE EXCEPTION 'invalid emergency details' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM public.users WHERE id=target_user;
 IF NOT FOUND THEN RAISE EXCEPTION 'account unavailable' USING ERRCODE='P0002'; END IF;
 IF mode_name='consent' THEN
  -- A disabled person can't sign in to answer.
  IF EXISTS(SELECT FROM public.account_disablements WHERE user_id=target_user) THEN RAISE EXCEPTION 'account consent unavailable' USING ERRCODE='55000'; END IF;
  UPDATE public.account_inspection_requests SET status='expired' WHERE user_id=target_user AND staff_user_id=actor AND status='pending' AND expires_at<=clock_timestamp();
  IF EXISTS(SELECT FROM public.account_inspection_requests WHERE user_id=target_user AND staff_user_id=actor AND status='approved' AND access_expires_at>clock_timestamp())
  THEN RAISE EXCEPTION 'access approved' USING ERRCODE='55000'; END IF;
  BEGIN
   INSERT INTO public.account_inspection_requests(id,user_id,staff_user_id,mode,reason,status,expires_at)
   VALUES(gen_random_uuid(),target_user,actor,'consent',trim(reason_text),'pending',now()+interval '24 hours') RETURNING * INTO r;
  EXCEPTION WHEN unique_violation THEN
   RAISE EXCEPTION 'request pending' USING ERRCODE='55000';
  END;
 ELSE
  INSERT INTO public.account_inspection_requests(id,user_id,staff_user_id,mode,reason,emergency_category,emergency_reference,status,expires_at,decided_at,access_expires_at)
  VALUES(gen_random_uuid(),target_user,actor,'emergency',trim(reason_text),category_name,trim(reference_text),'approved',now(),now(),now()+interval '30 minutes') RETURNING * INTO r;
 END IF;
 INSERT INTO public.account_mail(id,inspection_request_id,user_id,kind)
 VALUES(gen_random_uuid(),r.id,target_user,CASE mode_name WHEN 'emergency' THEN 'inspection_emergency' ELSE 'inspection_requested' END);
 INSERT INTO public.staff_audit(staff_user_id,staff_session_id,tenant_id,event,request_id,reason,details)
 VALUES(actor,staff_session,NULL,CASE mode_name WHEN 'emergency' THEN 'account.access.emergency' ELSE 'account.access.requested' END,left(request_text,200),r.reason,
  jsonb_build_object('requestId',r.id,'userId',target_user,'mode',mode_name,'category',category_name,'reference',r.emergency_reference));
 RETURN jsonb_build_object('id',r.id,'mode',r.mode,'status',r.status,'requestedAt',r.requested_at,'expiresAt',r.expires_at,'decidedAt',r.decided_at,'accessExpiresAt',r.access_expires_at,'revokedAt',r.revoked_at);
END $$;

CREATE FUNCTION identity_account_inspection_status(target_user uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.account_inspection_requests%ROWTYPE;
BEGIN
 IF NOT public.staff_has_access('staff.accounts.inspect') THEN RAISE EXCEPTION 'staff access denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM public.account_inspection_requests WHERE user_id=target_user AND staff_user_id=NULLIF(current_setting('staff.user_id',true),'')::uuid ORDER BY requested_at DESC LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('id',r.id,'mode',r.mode,'requestedAt',r.requested_at,'expiresAt',r.expires_at,'decidedAt',r.decided_at,'accessExpiresAt',r.access_expires_at,'revokedAt',r.revoked_at,
  'status',CASE WHEN r.status='pending' AND r.expires_at<=clock_timestamp() THEN 'expired' WHEN r.status='approved' AND r.access_expires_at<=clock_timestamp() THEN 'expired' ELSE r.status END);
END $$;

CREATE FUNCTION identity_account_inspection_sweep() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE lapsed integer;
BEGIN
 WITH due AS (SELECT id FROM public.account_inspection_requests WHERE status='pending' AND expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 200 FOR UPDATE SKIP LOCKED)
 UPDATE public.account_inspection_requests r SET status='expired' FROM due WHERE r.id=due.id;
 GET DIAGNOSTICS lapsed=ROW_COUNT;
 RETURN lapsed;
END $$;

-- Privileges. Function owners act on the request tables without row limits; they have no login,
-- and only the functions above act as them.
GRANT SELECT,INSERT,UPDATE ON workspace_inspection_requests TO luma_support_view;
GRANT SELECT,INSERT,UPDATE ON account_inspection_requests TO luma_identity_support;
GRANT INSERT ON account_mail TO luma_identity_support;
-- The customer runtime answers and revokes; it never reads which staff member asked or the
-- emergency reference.
GRANT SELECT(id,tenant_id,mode,reason,emergency_category,status,requested_at,expires_at,decided_by,decided_at,access_expires_at,revoked_by,revoked_at),
 UPDATE(status,decided_by,revoked_by) ON workspace_inspection_requests TO luma_identity;
GRANT SELECT(id,user_id,mode,reason,emergency_category,status,requested_at,expires_at,decided_by,decided_at,access_expires_at,revoked_by,revoked_at),
 UPDATE(status,decided_by,revoked_by) ON account_inspection_requests TO luma_identity;
ALTER TABLE workspace_inspection_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_inspection_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE account_inspection_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_inspection_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON workspace_inspection_requests TO luma_identity USING (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY account_scope ON account_inspection_requests TO luma_identity USING (user_id = NULLIF(current_setting('app.user_id',true),'')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY support_view_owner ON workspace_inspection_requests TO luma_support_view USING (true) WITH CHECK (true);
CREATE POLICY identity_support_owner ON account_inspection_requests TO luma_identity_support USING (true) WITH CHECK (true);
-- Answers are recorded as the member who gave them, not only as Luma support.
CREATE POLICY support_inspection_event ON workspace_access_events FOR INSERT TO luma_support_view WITH CHECK (event_type LIKE 'support_inspection.%');

DO $$ DECLARE fn text; owner_role text; BEGIN
 FOR fn, owner_role IN VALUES
  ('support_inspection_record()','luma_support_view'),('support_inspection_admit()','luma_support_view'),('support_inspection_open(uuid)','luma_support_view'),
  ('support_inspection_request(uuid,text,text,text,text,text)','luma_support_view'),('support_inspection_status(uuid)','luma_support_view'),('support_inspection_sweep()','luma_support_view'),
  ('identity_record_account_inspection()','luma_identity_support'),('identity_admit_account_inspection()','luma_identity_support'),('identity_account_inspection_open(uuid)','luma_identity_support'),
  ('identity_account_inspection_request(uuid,text,text,text,text,text)','luma_identity_support'),('identity_account_inspection_status(uuid)','luma_identity_support'),('identity_account_inspection_sweep()','luma_identity_support')
 LOOP
  EXECUTE format('ALTER FUNCTION %s OWNER TO %I',fn,owner_role);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn);
 END LOOP;
END $$;
-- Every role that checks grants may ask whether a grant's request is still open.
GRANT EXECUTE ON FUNCTION support_inspection_open(uuid) TO luma_staff_runtime,luma_staff_views,luma_identity_support,luma_staff_directory,luma_staff_audit,luma_account_deletion;
GRANT EXECUTE ON FUNCTION identity_account_inspection_open(uuid) TO luma_staff_runtime,luma_staff_views,luma_support_view,luma_staff_directory,luma_staff_audit,luma_account_deletion;
GRANT EXECUTE ON FUNCTION support_inspection_request(uuid,text,text,text,text,text),support_inspection_status(uuid),
 identity_account_inspection_request(uuid,text,text,text,text,text),identity_account_inspection_status(uuid) TO luma_staff_runtime;
GRANT EXECUTE ON FUNCTION support_inspection_sweep(),identity_account_inspection_sweep() TO luma_identity;

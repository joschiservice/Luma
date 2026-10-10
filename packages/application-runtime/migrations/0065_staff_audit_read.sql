-- Staff audit review. Reading requires the separate `staff.audit.read` permission and is itself
-- audited by the caller. The staff runtime keeps INSERT as its only privilege on staff_audit.
DO $$ BEGIN
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='luma_staff_audit') THEN CREATE ROLE luma_staff_audit NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO luma_staff_audit;

ALTER TABLE staff_access DROP CONSTRAINT staff_access_permissions_check;
ALTER TABLE staff_access ADD CONSTRAINT staff_access_permissions_check CHECK(permissions <@ ARRAY['staff.directory.read','staff.workspace.inspect','staff.sessions.revoke','staff.audit.read']::text[]);

-- The customer account an entry concerns, from `details.userId`, as a plain indexable column.
ALTER TABLE staff_audit ADD COLUMN account_id uuid GENERATED ALWAYS AS (
 CASE WHEN details->>'userId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (details->>'userId')::uuid END) STORED;
CREATE INDEX staff_audit_recent ON staff_audit(created_at DESC,sequence DESC);
CREATE INDEX staff_audit_staff ON staff_audit(staff_user_id,created_at DESC,sequence DESC);
CREATE INDEX staff_audit_workspace ON staff_audit(tenant_id,created_at DESC,sequence DESC);
CREATE INDEX staff_audit_account ON staff_audit(account_id,created_at DESC,sequence DESC) WHERE account_id IS NOT NULL;
CREATE INDEX staff_audit_event ON staff_audit(event,created_at DESC,sequence DESC);

GRANT SELECT ON staff_audit TO luma_staff_audit;
GRANT SELECT(email,provider_subject,active,permissions) ON staff_access TO luma_staff_audit;
GRANT SELECT(id,name,email) ON staff_users TO luma_staff_audit;
GRANT SELECT(id,user_id,provider_subject,expires_at,created_at,updated_at) ON staff_sessions TO luma_staff_audit;
GRANT EXECUTE ON FUNCTION staff_has_access(text) TO luma_staff_audit;
GRANT SELECT(id,name,email) ON users TO luma_staff_audit;
GRANT SELECT(id,name) ON organizations TO luma_staff_audit;
CREATE POLICY staff_audit_names ON organizations FOR SELECT TO luma_staff_audit USING((SELECT public.staff_has_access('staff.audit.read')));

-- Filters are optional; each one present narrows the read. `staff_member` and `account` accept an
-- ID or an exact email address. Entries are ordered newest first and paged by (created_at,
-- sequence). Names come from current records and are NULL when the record no longer exists.
CREATE FUNCTION staff_audit_entries(staff_member text,workspace uuid,account text,event_name text,
 from_at timestamptz,until_at timestamptz,before_at timestamptz,before_sequence bigint,page_size integer)
RETURNS TABLE(sequence bigint,created_at timestamptz,cursor text,event text,request_id text,reason text,outcome text,details jsonb,
 staff_user_id uuid,staff_name text,staff_email text,workspace_id uuid,workspace_name text,
 account_id uuid,account_name text,account_email text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE staff_id uuid; account_key uuid; filters text:='true';
 uuid_pattern constant text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
 IF NOT public.staff_has_access('staff.audit.read') THEN RAISE EXCEPTION 'staff access denied' USING ERRCODE='42501'; END IF;
 IF page_size IS NULL OR page_size NOT BETWEEN 1 AND 101 THEN RAISE EXCEPTION 'invalid page size' USING ERRCODE='22023'; END IF;
 IF staff_member IS NOT NULL THEN
  SELECT s.id INTO staff_id FROM public.staff_users s
  WHERE (staff_member ~ uuid_pattern AND s.id=staff_member::uuid) OR lower(s.email)=lower(staff_member) LIMIT 1;
  IF staff_id IS NULL THEN RETURN; END IF;
  filters:=filters||' AND a.staff_user_id=$1';
 END IF;
 IF workspace IS NOT NULL THEN filters:=filters||' AND a.tenant_id=$2'; END IF;
 IF account IS NOT NULL THEN
  IF account ~ uuid_pattern THEN account_key:=account::uuid;
  ELSE SELECT u.id INTO account_key FROM public.users u WHERE u.email=lower(account) LIMIT 1;
  END IF;
  IF account_key IS NULL THEN RETURN; END IF;
  filters:=filters||' AND a.account_id=$3';
 END IF;
 IF event_name IS NOT NULL THEN filters:=filters||' AND a.event=$4'; END IF;
 IF from_at IS NOT NULL THEN filters:=filters||' AND a.created_at>=$5'; END IF;
 IF until_at IS NOT NULL THEN filters:=filters||' AND a.created_at<$6'; END IF;
 IF before_at IS NOT NULL AND before_sequence IS NOT NULL THEN filters:=filters||' AND (a.created_at,a.sequence)<($7,$8)'; END IF;
 RETURN QUERY EXECUTE format($query$
  SELECT a.sequence,a.created_at,to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')||'_'||a.sequence::text,
   a.event,a.request_id,a.reason,CASE WHEN a.event LIKE '%%.failed' THEN 'failed' ELSE 'succeeded' END,a.details,
   a.staff_user_id,su.name,su.email,a.tenant_id,o.name,a.account_id,u.name,u.email
  FROM public.staff_audit a
  LEFT JOIN public.staff_users su ON su.id=a.staff_user_id
  LEFT JOIN public.organizations o ON o.id=a.tenant_id
  LEFT JOIN public.users u ON u.id=a.account_id
  WHERE %s ORDER BY a.created_at DESC,a.sequence DESC LIMIT $9$query$,filters)
 USING staff_id,workspace,account_key,event_name,from_at,until_at,before_at,before_sequence,page_size;
END $$;
ALTER FUNCTION staff_audit_entries(text,uuid,text,text,timestamptz,timestamptz,timestamptz,bigint,integer) OWNER TO luma_staff_audit;
REVOKE ALL ON FUNCTION staff_audit_entries(text,uuid,text,text,timestamptz,timestamptz,timestamptz,bigint,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION staff_audit_entries(text,uuid,text,text,timestamptz,timestamptz,timestamptz,bigint,integer) TO luma_staff_runtime;

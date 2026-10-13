ALTER TABLE notification_preferences
 ADD COLUMN morning_brief boolean NOT NULL DEFAULT false,
 ADD COLUMN morning_brief_time text NOT NULL DEFAULT '08:00'
 CHECK (morning_brief_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
ALTER TABLE workspace_mail DROP CONSTRAINT workspace_mail_kind_check;
ALTER TABLE workspace_mail ADD CONSTRAINT workspace_mail_kind_check
 CHECK (kind IN ('invitation','issues','connections','test','support_view_started','support_view_ended','support_access_requested','morning_brief'));
ALTER TABLE workspace_mail ADD COLUMN brief_document jsonb;
-- Discovery exposes only tenant IDs; report reads and queue writes remain tenant scoped.
CREATE FUNCTION morning_brief_tenants(as_of timestamptz DEFAULT now()) RETURNS TABLE(tenant_id uuid)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT DISTINCT p.tenant_id FROM public.notification_preferences p
 JOIN public.organizations o ON o.id=p.tenant_id
 JOIN public.memberships member ON member.tenant_id=p.tenant_id AND member.user_id=p.user_id AND member.status='active'
 LEFT JOIN public.workspace_settings s ON s.tenant_id=p.tenant_id
 WHERE p.morning_brief AND NOT EXISTS (SELECT FROM public.account_disablements d WHERE d.user_id=p.user_id) AND o.status='active' AND o.data_region='EU'
 AND to_char(as_of AT TIME ZONE COALESCE(s.timezone,'UTC'),'HH24:MI') >= p.morning_brief_time
 AND NOT EXISTS (SELECT FROM public.workspace_mail m WHERE m.tenant_id=p.tenant_id
  AND m.event_key='morning-brief:'||p.user_id::text||':'||to_char(as_of AT TIME ZONE COALESCE(s.timezone,'UTC'),'YYYY-MM-DD'))
 LIMIT 100;
$$;
REVOKE ALL ON FUNCTION morning_brief_tenants(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morning_brief_tenants(timestamptz) TO luma_identity;

-- The cell is provisioned once with migration credentials; runtime roles only read it.
CREATE TABLE luma_cell_region (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 region text NOT NULL CHECK(region IN ('EU','AU','US')),
 provisioned_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON luma_cell_region FROM PUBLIC;
GRANT SELECT ON luma_cell_region TO PUBLIC;
CREATE FUNCTION luma_cell_region_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN RAISE EXCEPTION 'cell region is immutable' USING ERRCODE='55000'; END $$;
CREATE TRIGGER luma_cell_region_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON luma_cell_region FOR EACH STATEMENT EXECUTE FUNCTION luma_cell_region_immutable();
ALTER TABLE organizations DROP CONSTRAINT organizations_data_region_check;
ALTER TABLE organizations ADD CONSTRAINT organizations_data_region_check CHECK(data_region IN ('EU','AU','US'));
ALTER TABLE organizations ALTER COLUMN data_region DROP DEFAULT;
ALTER POLICY organization_provision ON organizations WITH CHECK (
 id=NULLIF(current_setting('app.provision_id',true),'')::uuid
 AND NULLIF(current_setting('app.user_id',true),'') IS NOT NULL
 AND data_region=(SELECT region FROM public.luma_cell_region) AND status='active'
);
CREATE FUNCTION luma_current_cell_region() RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$ SELECT region FROM public.luma_cell_region $$;
ALTER TABLE staff_access ADD COLUMN regions text[] NOT NULL DEFAULT ARRAY[]::text[] CHECK(regions <@ ARRAY['EU','AU','US']::text[]);
GRANT SELECT(regions) ON staff_access TO luma_staff_audit;
ALTER TABLE staff_access ALTER COLUMN regions SET DEFAULT ARRAY[public.luma_current_cell_region()];
-- Migration credentials may initialize existing staff admissions, only during first provisioning.
CREATE FUNCTION luma_provision_cell_region(target text) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE existing text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('luma-cell-provisioning',0));
 SELECT region INTO existing FROM public.luma_cell_region;
 IF existing IS NOT NULL THEN
  IF existing<>target THEN RAISE EXCEPTION 'cell region mismatch' USING ERRCODE='55000'; END IF;
  RETURN;
 END IF;
 IF EXISTS(SELECT FROM public.organizations WHERE data_region<>target) THEN RAISE EXCEPTION 'existing workspace region differs from cell' USING ERRCODE='55000'; END IF;
 INSERT INTO public.luma_cell_region(region) VALUES(target);
 UPDATE public.staff_access SET regions=ARRAY[target] WHERE regions=ARRAY[]::text[];
END $$;
REVOKE ALL ON FUNCTION luma_provision_cell_region(text) FROM PUBLIC;

DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='luma_placement_directory') THEN CREATE ROLE luma_placement_directory NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO luma_placement_directory;
GRANT SELECT(id,data_region) ON organizations TO luma_placement_directory;
CREATE POLICY placement_directory_read ON organizations FOR SELECT TO luma_placement_directory USING(true);

-- Placement exposes opaque tenant IDs and region only, before membership/tenant payload reads.
CREATE FUNCTION identity_tenant_region(target uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ SELECT data_region FROM public.organizations WHERE id=target $$;
ALTER FUNCTION identity_tenant_region(uuid) OWNER TO luma_placement_directory;
REVOKE ALL ON FUNCTION identity_tenant_region(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity_tenant_region(uuid) TO luma_identity;

CREATE OR REPLACE FUNCTION staff_has_access(permission text) RETURNS boolean LANGUAGE sql VOLATILE SET search_path=pg_catalog,public AS $$
 SELECT EXISTS (SELECT FROM public.staff_sessions s JOIN public.staff_users u ON u.id=s.user_id JOIN public.staff_access a ON a.email=lower(u.email)
 WHERE s.id=NULLIF(current_setting('staff.session_id',true),'')::uuid AND s.user_id=NULLIF(current_setting('staff.user_id',true),'')::uuid AND s.expires_at>clock_timestamp() AND s.created_at>clock_timestamp()-interval '8 hours' AND s.updated_at>clock_timestamp()-interval '30 minutes' AND a.active AND ((a.provider_subject IS NULL AND s.provider_subject IS NULL) OR (a.provider_subject IS NOT NULL AND s.provider_subject=a.provider_subject)) AND permission=ANY(a.permissions) AND (SELECT region FROM public.luma_cell_region)=ANY(a.regions))
$$;

-- Update the current definitions, preserving function owners, grants and all newer authority checks.
DO $migration$
DECLARE definition text; routine record;
BEGIN
 FOR routine IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f' AND p.prosrc ~ 'data_region\s*=\s*''EU''' LOOP
  definition:=pg_get_functiondef(routine.oid);
  definition:=regexp_replace(definition,'data_region\s*=\s*''EU''','data_region=(SELECT region FROM public.luma_cell_region)','g');
  EXECUTE definition;
 END LOOP;
END $migration$;

-- A support view must end immediately if the operator loses the cell's admission scope.
DO $migration$
DECLARE definition text;
BEGIN
 definition:=pg_get_functiondef('support_view_failure(support_view_sessions)'::regprocedure);
 definition:=replace(definition,'AND a.active','AND a.active AND (SELECT region FROM public.luma_cell_region)=ANY(a.regions)');
 EXECUTE definition;
END $migration$;

ALTER POLICY staff_directory_read ON organizations USING(public.staff_has_access('staff.directory.read') AND data_region=(SELECT region FROM public.luma_cell_region));
ALTER POLICY staff_directory_workspace ON organizations USING(public.staff_has_access('staff.directory.read') AND data_region=(SELECT region FROM public.luma_cell_region));
ALTER POLICY staff_inspection_workspace ON organizations USING(public.staff_has_workspace_access(id) AND data_region=(SELECT region FROM public.luma_cell_region));

-- The database rechecks placement even when a caller has retained a support grant.
CREATE OR REPLACE FUNCTION staff_has_workspace_access(target uuid) RETURNS boolean LANGUAGE sql VOLATILE SET search_path=pg_catalog,public AS $$
 SELECT public.staff_has_access('staff.workspace.inspect') AND EXISTS (SELECT FROM public.staff_support_grants g WHERE g.id=NULLIF(current_setting('staff.grant_id',true),'')::uuid AND g.staff_user_id=NULLIF(current_setting('staff.user_id',true),'')::uuid AND g.staff_session_id=NULLIF(current_setting('staff.session_id',true),'')::uuid AND g.tenant_id=target AND g.expires_at>clock_timestamp())
$$;
-- Avoid recursive organization RLS by using the bounded placement reader under its owner.
GRANT EXECUTE ON FUNCTION identity_tenant_region(uuid) TO luma_staff_runtime,luma_staff_views,luma_identity_support,luma_staff_directory,luma_support_view,luma_staff_audit;
DO $migration$
DECLARE definition text;
BEGIN
 definition:=pg_get_functiondef('staff_has_workspace_access(uuid)'::regprocedure);
 definition:=replace(definition,'SELECT public.staff_has_access', 'SELECT public.identity_tenant_region(target)=(SELECT region FROM public.luma_cell_region) AND public.staff_has_access');
 EXECUTE definition;
END $migration$;

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX users_staff_email_trgm ON users USING gin(email gin_trgm_ops);
CREATE INDEX users_staff_name_trgm ON users USING gin(name gin_trgm_ops);
CREATE INDEX organizations_staff_name_trgm ON organizations USING gin(name gin_trgm_ops);
CREATE INDEX organizations_staff_slug_trgm ON organizations USING gin(slug gin_trgm_ops);

ALTER POLICY staff_account_workspace_read ON organizations USING(data_region=(SELECT region FROM public.luma_cell_region) AND EXISTS(SELECT FROM public.memberships m WHERE m.tenant_id=organizations.id AND public.staff_has_account_access(m.user_id)));
ALTER POLICY staff_audit_names ON organizations USING((SELECT public.staff_has_access('staff.audit.read')) AND public.identity_tenant_region(id)=(SELECT region FROM public.luma_cell_region));
DO $migration$
DECLARE definition text;
BEGIN
 definition:=pg_get_functiondef('staff_inspected_workspace()'::regprocedure);
 definition:=replace(definition,'AND g.expires_at>', 'AND public.identity_tenant_region(g.tenant_id)=(SELECT region FROM public.luma_cell_region) AND g.expires_at>');
 EXECUTE definition;
 definition:=pg_get_functiondef('support_view_failure(support_view_sessions)'::regprocedure);
 definition:=replace(definition,'SELECT CASE', 'SELECT CASE WHEN public.identity_tenant_region(sv.tenant_id) IS DISTINCT FROM (SELECT region FROM public.luma_cell_region) THEN ''staff_access_revoked''');
 EXECUTE definition;
END $migration$;

-- Independent candidate branches let PostgreSQL use each substring index before joining members.
CREATE OR REPLACE FUNCTION staff_search_workspaces(pattern text) RETURNS TABLE(id uuid,name text,slug text,status text,data_region text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 WITH matches AS (
  SELECT o.id FROM public.organizations o WHERE o.name ILIKE pattern
  UNION
  SELECT o.id FROM public.organizations o WHERE o.slug ILIKE pattern
  UNION
  SELECT m.tenant_id FROM public.users u JOIN public.memberships m ON m.user_id=u.id WHERE u.email ILIKE pattern
  UNION
  SELECT m.tenant_id FROM public.users u JOIN public.memberships m ON m.user_id=u.id WHERE u.name ILIKE pattern
 )
 SELECT o.id,o.name,o.slug,o.status,o.data_region FROM public.organizations o JOIN matches m ON m.id=o.id
 WHERE (SELECT public.staff_has_access('staff.directory.read')) AND o.data_region=(SELECT region FROM public.luma_cell_region)
 ORDER BY o.name,o.id LIMIT 26
$$;
ALTER POLICY staff_directory_read ON organizations USING((SELECT public.staff_has_access('staff.directory.read')) AND data_region=(SELECT region FROM public.luma_cell_region));
ALTER POLICY staff_directory_workspace ON organizations USING((SELECT public.staff_has_access('staff.directory.read')) AND data_region=(SELECT region FROM public.luma_cell_region));
ALTER POLICY staff_directory_membership ON memberships USING((SELECT public.staff_has_access('staff.directory.read')));

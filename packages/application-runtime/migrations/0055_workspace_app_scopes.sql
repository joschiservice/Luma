-- App permissions in roles and app scopes. Depends on workspace roles (0054) and apps (0024).
-- Scopes an installed app may use in its workspace. Install grants only scopes the installer
-- holds; scopes added by an upgrade stay ungranted until someone approves them.
CREATE TABLE workspace_app_scopes (
 tenant_id uuid NOT NULL, app_id text NOT NULL, scope text NOT NULL CHECK(scope ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
 installation_version integer NOT NULL, granted_by uuid NOT NULL, granted_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,app_id,scope),
 FOREIGN KEY(tenant_id,app_id) REFERENCES workspace_apps(tenant_id,app_id)
);
-- The permission definitions an installation registered, so roles can show them without app code.
ALTER TABLE workspace_apps ADD COLUMN manifest jsonb NOT NULL DEFAULT '{"version":null,"permissions":[],"scopes":[]}'::jsonb;
GRANT SELECT,INSERT,DELETE ON workspace_app_scopes TO luma_connectors;
ALTER TABLE workspace_app_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_app_scopes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON workspace_app_scopes TO luma_connectors USING (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid);
-- Workspaces installed before scopes existed keep their access; uninstalling clears it.
INSERT INTO workspace_app_scopes(tenant_id,app_id,scope,installation_version,granted_by)
SELECT a.tenant_id,a.app_id,s.scope,a.version,'00000000-0000-0000-0000-000000000000'::uuid
FROM workspace_apps a CROSS JOIN LATERAL unnest(CASE a.app_id
 WHEN 'shopify' THEN ARRAY['orders.read','fulfillment.read','inventory.read','products.read','customers.read','returns.read','actions.propose','actions.execute']
 WHEN 'jtl' THEN ARRAY['orders.read','fulfillment.read','inventory.read','products.read','customers.read','procurement.read','actions.propose','actions.execute']
 ELSE ARRAY[]::text[] END) AS s(scope)
WHERE a.status='installed';

-- Uninstalling an app removes its permissions from every role in the same transaction. The app
-- host runs as luma_connectors, which has no grants on role tables, so this function is the
-- deliberate write path. It acts only in the caller's tenant.
CREATE FUNCTION revoke_app_role_permissions(p_tenant uuid, p_app text, p_actor uuid, p_version integer)
RETURNS TABLE(role_id uuid, name text, removed text[]) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF p_tenant IS DISTINCT FROM NULLIF(current_setting('app.tenant_id', true), '')::uuid THEN
  RAISE EXCEPTION 'Tenant context mismatch' USING ERRCODE='42501';
 END IF;
 RETURN QUERY
 WITH removed AS (
  DELETE FROM public.workspace_role_permissions p WHERE p.tenant_id=p_tenant AND p.permission LIKE p_app || ':%'
  RETURNING p.role_id, p.permission
 ), grouped AS (
  SELECT r.role_id, array_agg(r.permission ORDER BY r.permission) AS permissions FROM removed r GROUP BY r.role_id
 ), bumped AS (
  UPDATE public.workspace_roles w SET revision=w.revision+1, updated_at=now() FROM grouped g
  WHERE w.tenant_id=p_tenant AND w.id=g.role_id
  RETURNING w.id, w.name, w.revision, g.permissions
 ), logged AS (
  -- Data-modifying CTEs run even when the outer query does not read them.
  INSERT INTO public.workspace_access_events(id,tenant_id,actor_id,event_type,target_id,before_value,after_value)
  SELECT gen_random_uuid(),p_tenant,p_actor,'role.app_permissions_removed',b.id::text,
   jsonb_build_object('revision',b.revision-1,'permissions',to_jsonb(b.permissions)),
   jsonb_build_object('revision',b.revision,'cause',jsonb_build_object('kind','app_uninstalled','appId',p_app,'installationVersion',p_version))
  FROM bumped b
 )
 SELECT b.id, b.name, b.permissions FROM bumped b;
END $$;
REVOKE ALL ON FUNCTION revoke_app_role_permissions(uuid,text,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION revoke_app_role_permissions(uuid,text,uuid,integer) TO luma_connectors;

-- Lists roles that hold an app's permissions so uninstall confirmation can name them.
CREATE FUNCTION app_permission_roles(p_tenant uuid, p_app text)
RETURNS TABLE(role_id uuid, name text, permissions integer) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT w.id, w.name, count(*)::integer FROM public.workspace_role_permissions p
 JOIN public.workspace_roles w ON w.tenant_id=p.tenant_id AND w.id=p.role_id
 WHERE p.tenant_id=p_tenant AND p_tenant = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  AND p.permission LIKE p_app || ':%' AND w.archived_at IS NULL
 GROUP BY w.id, w.name ORDER BY w.name;
$$;
REVOKE ALL ON FUNCTION app_permission_roles(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_permission_roles(uuid,text) TO luma_connectors;

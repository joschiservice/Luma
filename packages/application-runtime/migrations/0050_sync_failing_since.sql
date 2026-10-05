-- When a stream's current run of consecutive failures began; null while its reads succeed.
-- Sync-failure detection measures its retry window from this time.
ALTER TABLE commerce_sync_streams ADD COLUMN failing_since timestamptz;
UPDATE commerce_sync_streams SET failing_since=error_at WHERE attempts>0;

-- Workspaces whose commerce sync runs, with the person it runs as. Detection reads and
-- verifies with that person's current access, as the sync does.
CREATE FUNCTION detection_worker_scopes() RETURNS TABLE(tenant_id uuid, principal_id text)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT DISTINCT ON (s.tenant_id) s.tenant_id,s.principal_id FROM public.commerce_sync_streams s
 WHERE NOT s.paused AND s.blocked IS NULL ORDER BY s.tenant_id,s.created_at,s.id LIMIT 1000
$$;
REVOKE ALL ON FUNCTION detection_worker_scopes() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION detection_worker_scopes() TO luma_exceptions;

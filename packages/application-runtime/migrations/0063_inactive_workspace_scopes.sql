-- Suspended and closed workspaces get no background work. Discovery returns active workspaces
-- only, so workers never resolve a context the API would reject. Owners, grants and
-- signatures are unchanged.

CREATE OR REPLACE FUNCTION detection_worker_scopes() RETURNS TABLE(tenant_id uuid, principal_id text)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT DISTINCT ON (s.tenant_id) s.tenant_id,s.principal_id FROM public.commerce_sync_streams s
 JOIN public.organizations o ON o.id=s.tenant_id AND o.status='active'
 WHERE NOT s.paused AND s.blocked IS NULL ORDER BY s.tenant_id,s.created_at,s.id LIMIT 1000
$$;

-- Change notifications for an inactive workspace stay unconsumed and are applied once it is
-- active again.
CREATE OR REPLACE FUNCTION commerce_sync_scopes() RETURNS TABLE(tenant_id uuid)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT DISTINCT t.tenant_id FROM (
  SELECT s.tenant_id FROM public.commerce_sync_streams s WHERE NOT s.paused AND s.blocked IS NULL
   AND (s.lease_until IS NULL OR s.lease_until < now())
   AND (s.provider_due_at IS NULL OR s.provider_due_at <= now())
   AND (s.due_at <= now() OR (s.scan IS NULL AND s.hint_at <= now()))
  UNION ALL SELECT h.tenant_id FROM public.connector_refresh_hints h WHERE h.consumed_at IS NULL
  UNION ALL SELECT i.tenant_id FROM public.connector_installations i WHERE i.document->>'status'='active'
   AND EXISTS (SELECT 1 FROM public.connector_lifecycle_events e WHERE e.tenant_id=i.tenant_id AND e.connection_id=i.id)
   AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(i.document->'granted') g(capability)
    WHERE g.capability IN ('orders.read','fulfillment.read','products.read','inventory.read','customers.read','returns.read')
    AND i.document->'permissions' ? g.capability
    AND NOT EXISTS (SELECT 1 FROM public.commerce_sync_streams s WHERE s.tenant_id=i.tenant_id AND s.connection_id=i.id
     AND s.record_type=CASE g.capability WHEN 'orders.read' THEN 'orders' WHEN 'fulfillment.read' THEN 'fulfillments'
      WHEN 'products.read' THEN 'products' WHEN 'inventory.read' THEN 'inventory' WHEN 'returns.read' THEN 'returns'
      ELSE 'customers' END))
  UNION ALL SELECT s.tenant_id FROM public.commerce_sync_streams s WHERE s.blocked IN ('connection_inactive','capability_removed')
   AND EXISTS (SELECT 1 FROM public.connector_installations i WHERE i.tenant_id=s.tenant_id AND i.id=s.connection_id
    AND i.document->>'status'='active'
    AND i.document->'granted' ? CASE s.record_type WHEN 'orders' THEN 'orders.read' WHEN 'fulfillments' THEN 'fulfillment.read'
     WHEN 'products' THEN 'products.read' WHEN 'inventory' THEN 'inventory.read' WHEN 'returns' THEN 'returns.read'
     ELSE 'customers.read' END
    AND i.document->'permissions' ? CASE s.record_type WHEN 'orders' THEN 'orders.read' WHEN 'fulfillments' THEN 'fulfillment.read'
     WHEN 'products' THEN 'products.read' WHEN 'inventory' THEN 'inventory.read' WHEN 'returns' THEN 'returns.read'
     ELSE 'customers.read' END)
  UNION ALL SELECT s.tenant_id FROM public.commerce_sync_streams s WHERE s.blocked IS NULL AND NOT s.paused
   AND EXISTS (SELECT 1 FROM public.connector_installations i WHERE i.tenant_id=s.tenant_id AND i.id=s.connection_id
    AND (i.document->>'status'<>'active' OR NOT (i.document->'granted' ? CASE s.record_type WHEN 'orders' THEN 'orders.read'
     WHEN 'fulfillments' THEN 'fulfillment.read' WHEN 'products' THEN 'products.read' WHEN 'inventory' THEN 'inventory.read'
     WHEN 'returns' THEN 'returns.read' ELSE 'customers.read' END)))
  UNION ALL SELECT l.tenant_id FROM public.commerce_identity_links l WHERE l.state='requested'
   OR (l.state='running' AND l.lease_until < now())
 ) t JOIN public.organizations o ON o.id=t.tenant_id AND o.status='active' LIMIT 1000
$$;

CREATE OR REPLACE FUNCTION commerce_auto_link_scopes() RETURNS TABLE(tenant_id uuid)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT DISTINCT r.tenant_id FROM public.commerce_auto_link_rules r
 JOIN public.organizations o ON o.id=r.tenant_id AND o.status='active'
 WHERE r.enabled AND r.state<>'blocked' AND r.due_at<=now() LIMIT 1000
$$;

CREATE OR REPLACE FUNCTION replenishment_worker_scopes() RETURNS TABLE(tenant_id uuid,principal_id text)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT DISTINCT a.tenant_id,a.principal_id FROM public.replenishment_activations a
 JOIN public.organizations o ON o.id=a.tenant_id AND o.status='active'
$$;

CREATE OR REPLACE FUNCTION case_workflow_worker_scopes() RETURNS TABLE(tenant_id uuid,principal_id text)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT DISTINCT a.tenant_id,a.principal_id FROM public.workflow_case_activations a
 JOIN public.organizations o ON o.id=a.tenant_id AND o.status='active'
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
$$;

CREATE OR REPLACE FUNCTION procurement_submission_scopes() RETURNS TABLE(tenant_id uuid,principal_id text)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT DISTINCT s.tenant_id,s.principal_id FROM public.procurement_submissions s
 JOIN public.organizations o ON o.id=s.tenant_id AND o.status='active'
 WHERE NOT s.settled AND s.state IN ('approved','submitting','uncertain','submitted')
$$;

-- A scheduled start whose time comes while its workspace is suspended or closed is skipped,
-- not started later: reactivation never fires a backlog of missed starts.
ALTER TABLE workflow_trigger_runs DROP CONSTRAINT workflow_trigger_runs_state_check;
ALTER TABLE workflow_trigger_runs ADD CONSTRAINT workflow_trigger_runs_state_check
 CHECK(state IN ('scheduled','awaiting_admission','cancelled','skipped'));

CREATE OR REPLACE FUNCTION advance_workflow_schedules() RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE changed integer;
BEGIN
 WITH due AS (
   SELECT r.tenant_id,r.id,o.status='active' AS active FROM public.workflow_trigger_runs r
   JOIN public.organizations o ON o.id=r.tenant_id
   WHERE r.state='scheduled' AND r.due_at<=CURRENT_TIMESTAMP
   ORDER BY r.due_at LIMIT 100 FOR UPDATE OF r SKIP LOCKED
 )
 UPDATE public.workflow_trigger_runs r
 SET state=CASE WHEN due.active THEN 'awaiting_admission' ELSE 'skipped' END,
  triggered_at=CASE WHEN due.active THEN CURRENT_TIMESTAMP END
 FROM due WHERE r.tenant_id=due.tenant_id AND r.id=due.id;
 GET DIAGNOSTICS changed = ROW_COUNT;
 RETURN changed;
END $$;

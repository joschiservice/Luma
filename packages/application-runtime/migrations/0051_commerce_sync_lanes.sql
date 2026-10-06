-- History checkpoints survive live reads, and recent coverage survives worker restarts.
ALTER TABLE commerce_sync_streams
 ADD COLUMN scan_created_since timestamptz,
 ADD COLUMN scan_waiting boolean NOT NULL DEFAULT false,
 ADD COLUMN recent_history_from timestamptz,
 ADD COLUMN recent_history_completed_at timestamptz,
 ADD COLUMN suspended_scan jsonb,
 ADD COLUMN live_enabled boolean NOT NULL DEFAULT false,
 ADD COLUMN live_due_at timestamptz,
 ADD COLUMN provider_due_at timestamptz;
ALTER TABLE commerce_sync_runs ADD COLUMN created_since timestamptz;

-- Keep discovery consistent with claim eligibility: hints never bypass a page's backoff.
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
 ) t LIMIT 1000
$$;

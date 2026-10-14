import type { SqlTransaction } from '@luma/platform';

/**
 * Rewrites the fulfillment list rows of locked orders from their current fulfillment and order
 * projections in the caller's transaction. Callers must hold the orders:<tenant>:<order> lock
 * for each ID.
 */
export async function refreshFulfillmentList(
  tx: SqlTransaction,
  tenant: string,
  orderIds: string[],
) {
  if (!orderIds.length) return;
  await tx.query(
    'DELETE FROM orders_fulfillment_list WHERE tenant_id=$1 AND order_id=ANY($2::uuid[])',
    [tenant, orderIds],
  );
  await tx.query(
    `INSERT INTO orders_fulfillment_list(tenant_id,entity_id,connection_id,snapshot_id,order_id,kind,status,deleted,
      hold_reasons,location_id,location_name,method_type,method_name,fulfill_at,fulfill_by,estimated_delivery_at,
      last_progress_at,delivery,failure_code,tracking_numbers,units,unit,order_number,order_status,order_placed_at,
      observed_at,source_updated_at,open,progress_at,deadline_at,carriers,shipping_stage)
    SELECT p.tenant_id,p.entity_id,p.connection_id,s.id,s.order_id,d->>'kind',s.status,f.deleted,
      CASE WHEN jsonb_typeof(d->'holds')='array' THEN
       ARRAY(SELECT h->>'reason' FROM jsonb_array_elements(d->'holds') h) END,
      (d->'location'->>'locationId')::uuid,d->'location'->>'name',
      d->'method'->>'type',d->'method'->>'name',
      (d->>'fulfillAt')::timestamptz,(d->>'fulfillBy')::timestamptz,(d->>'estimatedDeliveryAt')::timestamptz,
      (d->>'lastProgressAt')::timestamptz,d->>'delivery',d->>'failureCode',
      ARRAY(SELECT t->>'number' FROM jsonb_array_elements(COALESCE(d->'tracking','[]')) t WHERE t->>'number' IS NOT NULL),
      COALESCE((SELECT sum((l->>'quantity')::numeric) FROM jsonb_array_elements(d->'lines') l),0),
      (SELECT CASE WHEN count(DISTINCT l->>'unit')=1 THEN min(l->>'unit') END FROM jsonb_array_elements(d->'lines') l),
      o.display_number,o.status,(o.document->'data'->>'placedAt')::timestamptz,
      s.observed_at,s.source_updated_at,
      s.status IN ('pending','processing') AND NOT f.deleted
       AND COALESCE(o.status,'unknown')<>'cancelled' AND NOT COALESCE((o.document->>'deleted')::boolean,false),
      COALESCE((d->>'lastProgressAt')::timestamptz,s.source_updated_at,s.observed_at),
      COALESCE((d->>'fulfillBy')::timestamptz,(d->>'estimatedDeliveryAt')::timestamptz),
      ARRAY(SELECT DISTINCT left(btrim(t->>'carrier'),200)
       FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d->'tracking')='array' THEN d->'tracking' ELSE '[]'::jsonb END) t
       WHERE btrim(COALESCE(t->>'carrier',''))<>'' ORDER BY 1),
      CASE WHEN d->'shipping'->>'stage' IN ('merchant','warehouse','carrier','delivered','unknown')
       THEN d->'shipping'->>'stage' END
    FROM orders_relationships r
    JOIN orders_projections p ON p.tenant_id=r.tenant_id AND p.entity_id=r.child_id
    JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id AND s.kind='fulfillment'
    CROSS JOIN LATERAL (SELECT s.document->'data',(s.document->>'deleted')::boolean) f(d,deleted)
    LEFT JOIN orders_projections op ON op.tenant_id=p.tenant_id AND op.entity_id=s.order_id AND op.connection_id=p.connection_id
    LEFT JOIN orders_snapshots o ON o.tenant_id=op.tenant_id AND o.id=op.snapshot_id
    WHERE r.tenant_id=$1 AND r.order_id=ANY($2::uuid[])`,
    [tenant, orderIds],
  );
}

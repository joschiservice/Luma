import { requireTenant } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import type {
  OrderMetricRead,
  OrderMetricReader,
} from '../application/metrics.js';

// Select one accepted source per canonical order. Fulfillments are counted only within
// that source, so mirrored provider quantities cannot be added twice.
const facts = `WITH selected AS MATERIALIZED (
 SELECT DISTINCT ON (p.entity_id) p.entity_id, p.connection_id, s.id AS snapshot_id,
 s.document, s.status, s.display_number, s.observed_at, s.source_updated_at
 FROM orders_projections p JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
 WHERE p.tenant_id=$1 AND s.kind='order' AND ($3::uuid IS NULL OR p.connection_id=$3)
 ORDER BY p.entity_id,s.source_updated_at DESC NULLS LAST,s.observed_at DESC,p.connection_id
), scoped AS MATERIALIZED (
 SELECT * FROM selected WHERE ($4::timestamptz IS NULL OR source_updated_at >= $4)
 AND ($5::timestamptz IS NULL OR source_updated_at < $5)
), fulfilled AS MATERIALIZED (
 SELECT s.order_id,p.connection_id,l->>'orderLineId' AS line_id,sum((l->>'quantity')::numeric) AS quantity
 FROM orders_projections p JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
 JOIN scoped o ON o.entity_id=s.order_id AND o.connection_id=p.connection_id
 CROSS JOIN LATERAL jsonb_array_elements(s.document->'data'->'lines') l
 WHERE p.tenant_id=$1 AND s.kind='fulfillment' AND s.status IN ('completed','shipped','delivered')
 AND NOT (s.document->>'deleted')::boolean AND s.observed_at <= $2
 GROUP BY s.order_id,p.connection_id,l->>'orderLineId'
), classified AS MATERIALIZED (
 SELECT o.*, CASE
 WHEN observed_at > $2 THEN NULL
 WHEN (document->>'deleted')::boolean OR status IN ('completed','cancelled') THEN false
 WHEN status <> 'open' OR jsonb_array_length(document->'data'->'lines')=0 THEN NULL
 ELSE (SELECT CASE WHEN bool_or(remaining > 0) THEN true
 WHEN bool_or(remaining IS NULL) THEN NULL ELSE false END FROM (
 SELECT CASE WHEN COALESCE(f.quantity,0) >= (l->>'quantity')::numeric THEN 0
 ELSE (l->>'quantity')::numeric - (l->>'cancelledQuantity')::numeric - COALESCE(f.quantity,0) END AS remaining
 FROM jsonb_array_elements(document->'data'->'lines') l
 LEFT JOIN fulfilled f ON f.order_id=o.entity_id AND f.connection_id=o.connection_id AND f.line_id=l->>'id'
 ) quantities) END AS is_open,
 (document->'data'->>'dueAt')::timestamptz AS due_at,
 ARRAY(SELECT DISTINCT a->>'issueId' FROM jsonb_array_elements($6::jsonb) a WHERE a->>'orderId'=o.entity_id::text ORDER BY a->>'issueId') AS issue_ids
 FROM scoped o
), rows AS MATERIALIZED (
 SELECT entity_id AS id, display_number AS "displayNumber", connection_id AS "connectionId",
 due_at AS "dueAt", observed_at AS "observedAt",source_updated_at AS "sourceUpdatedAt",
 is_open AS open, CASE WHEN is_open=false THEN false WHEN is_open IS NULL OR due_at IS NULL THEN NULL ELSE due_at < $2 END AS overdue,
 cardinality(issue_ids)>0 AND NOT (document->>'deleted')::boolean AS attention, issue_ids AS "issueIds"
 FROM classified
), metrics AS (SELECT unnest(ARRAY['orders.open','orders.overdue','orders.attention']) AS id)
SELECT jsonb_build_object(
 'revision', md5(COALESCE((SELECT string_agg(row_to_json(r)::text,',' ORDER BY r.id) FROM rows r),'')),
 'population',(SELECT count(*) FROM rows),
 'oldestObservedAt',(SELECT CASE WHEN max("observedAt") <= $2 THEN min("observedAt") END FROM rows),
 'observedAt',(SELECT max("observedAt") FROM rows WHERE "observedAt" <= $2),
 'dataThrough',NULL,
 'metrics',(SELECT jsonb_agg(jsonb_build_object('id',m.id,
 'observedCount',(SELECT count(*) FROM rows r WHERE CASE m.id WHEN 'orders.open' THEN open WHEN 'orders.overdue' THEN overdue ELSE attention END),
 'unknownCount',(SELECT count(*) FROM rows r WHERE (CASE m.id WHEN 'orders.open' THEN open WHEN 'orders.overdue' THEN overdue ELSE attention END) IS NULL),
 'items',COALESCE((SELECT jsonb_agg(page) FROM (SELECT * FROM rows r WHERE CASE m.id WHEN 'orders.open' THEN open WHEN 'orders.overdue' THEN overdue ELSE attention END ORDER BY id LIMIT $7 OFFSET $8) page),'[]'::jsonb)
 )) FROM metrics m)
) AS result`;

/** Executes indexed, parameterized order reads; callers may supply a shared read transaction. */
export function createOrderMetricReader(db: TenantDatabase): OrderMetricReader {
  return (context, request) => {
    requireTenant(context, context.tenantId);

    return db.transaction(context.tenantId, async (tx) => {
      await tx.query("SET LOCAL statement_timeout = '3000ms'");
      const result = await tx.query<{ result: OrderMetricRead }>(facts, [
        context.tenantId,
        request.asOf,
        request.scope.connectionId ?? null,
        request.scope.updatedFrom ?? null,
        request.scope.updatedBefore ?? null,
        JSON.stringify(request.attention),
        request.limit,
        request.offset,
      ]);

      return result.rows[0]!.result;
    });
  };
}

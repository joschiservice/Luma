import type { TenantContext } from '@luma/identity';
import { requireTenant } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import type {
  OrderMetricRead,
  OrderMetricReader,
} from '../application/metrics.js';
import {
  currentOrderSources,
  orderProgress,
  sourceSelectionOrder,
} from './order-state.js';

// Select one accepted source per canonical order. Fulfillments are counted only within
// that source, so mirrored provider quantities cannot be added twice.
const facts = (
  attention: string,
) => `WITH ${currentOrderSources('order_sources')}, selected AS MATERIALIZED (
 SELECT DISTINCT ON (entity_id) * FROM order_sources WHERE ($3::uuid IS NULL OR connection_id=$3)
 ORDER BY entity_id,${sourceSelectionOrder}
), scoped AS MATERIALIZED (
 SELECT * FROM selected WHERE NOT deleted AND ($4::timestamptz IS NULL OR source_updated_at >= $4)
 AND ($5::timestamptz IS NULL OR source_updated_at < $5)
), ${orderProgress('scoped')}, order_attention AS MATERIALIZED (${attention}
), attention AS MATERIALIZED (
 SELECT order_id,array_agg(DISTINCT issue_id::text ORDER BY issue_id::text) AS issue_ids
 FROM order_attention GROUP BY order_id
), rows AS MATERIALIZED (
 SELECT o.entity_id AS id, o.display_number AS "displayNumber", o.connection_id AS "connectionId",
 o.due_at AS "dueAt", o.observed_at AS "observedAt",o.source_updated_at AS "sourceUpdatedAt",
 o.open, o.overdue, a.order_id IS NOT NULL AND NOT o.deleted AS attention,
 COALESCE(a.issue_ids,'{}'::text[]) AS "issueIds"
 FROM order_state o LEFT JOIN attention a ON a.order_id=o.entity_id
), metrics AS (SELECT unnest(ARRAY['orders.open','orders.overdue','orders.attention']) AS id)
SELECT jsonb_build_object(
 'nextRefreshAt',(SELECT min(boundary) FROM (
 SELECT CASE WHEN open THEN "dueAt" + interval '1 millisecond' END AS boundary FROM rows
 UNION ALL SELECT "observedAt" FROM rows
 UNION ALL SELECT "observedAt" + interval '24 hours 1 millisecond' FROM rows
 UNION ALL SELECT s.observed_at FROM orders_projections p JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id WHERE p.tenant_id=$1 AND s.kind='fulfillment' AND ($3::uuid IS NULL OR p.connection_id=$3)
 ) boundaries WHERE boundary > $2),
 'population',(SELECT count(*) FROM rows),
 'oldestObservedAt',(SELECT CASE WHEN max("observedAt") <= $2 THEN min("observedAt") END FROM rows),
 'observedAt',(SELECT max("observedAt") FROM rows WHERE "observedAt" <= $2),
 'dataThrough',NULL,
 'metrics',(SELECT jsonb_agg(jsonb_build_object('id',m.id,
 'observedCount',(SELECT count(*) FROM rows r WHERE CASE m.id WHEN 'orders.open' THEN open WHEN 'orders.overdue' THEN overdue ELSE attention END),
 'unknownCount',(SELECT count(*) FROM rows r WHERE (CASE m.id WHEN 'orders.open' THEN open WHEN 'orders.overdue' THEN overdue ELSE attention END) IS NULL),
 'items',COALESCE((SELECT jsonb_agg(page) FROM (SELECT * FROM rows r WHERE CASE m.id WHEN 'orders.open' THEN open WHEN 'orders.overdue' THEN overdue ELSE attention END AND ($7::text IS NULL OR m.id<>$7 OR r.id>$8::uuid) ORDER BY id LIMIT $6) page),'[]'::jsonb)
 )) FROM metrics m)
) AS result`;

/**
 * Executes indexed, parameterized order reads; callers may supply a shared read transaction.
 * `attentionQuery` selects `order_id` and `issue_id` pairs that need a person, bound to `$1`
 * tenant ID and `$2` evaluation time.
 */
export function createOrderMetricReader(
  db: TenantDatabase,
  attentionQuery: string,
  excludedSources: (
    context: TenantContext,
  ) => Promise<string[]> = async () => [],
): OrderMetricReader {
  const query = facts(attentionQuery);

  return async (context, request) => {
    requireTenant(context, context.tenantId);

    const hidden = await excludedSources(context);

    return db.transaction(context.tenantId, async (tx) => {
      await tx.query("SELECT set_config('app.hidden_order_sources',$1,true)", [
        `{${hidden.join(',')}}`,
      ]);
      await tx.query("SET LOCAL statement_timeout = '3000ms'");
      const result = await tx.query<{ result: OrderMetricRead }>(query, [
        context.tenantId,
        request.asOf,
        request.scope.connectionId ?? null,
        request.scope.updatedFrom ?? null,
        request.scope.updatedBefore ?? null,
        request.limit,
        request.after?.metric ?? null,
        request.after?.id ?? null,
      ]);

      return result.rows[0]!.result;
    });
  };
}

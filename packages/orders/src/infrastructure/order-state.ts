import type { OrderStateQueries } from '../application/order-state.js';
import {
  anyDifference,
  comparisonStateSql,
  sourceComparison,
} from './source-comparison.js';

// SQL building blocks for order state under `orderMetricDefinitions` v1. The order metrics,
// the Orders list and the order detail compose these so open, overdue and fulfillment state
// have one definition. Every fragment expects `$1` to be the tenant ID and `$2` the
// evaluation time (`asOf`, timestamptz).

/**
 * Prefers active sources of one canonical order, then the newest source update,
 * the newest observation and the connection ID.
 */
export const sourceSelectionOrder =
  'deleted ASC,source_updated_at DESC NULLS LAST,observed_at DESC,connection_id';

/**
 * Returns a CTE with every current order snapshot, one row per order and source connection.
 * `filter` is an extra SQL condition on `p` (orders_projections) and `s` (orders_snapshots).
 * Rows carry scalar facts only; join `orders_snapshots` on `snapshot_id` for lines and totals.
 *
 * Columns: entity_id, connection_id, snapshot_id, status, payment_status, display_number,
 * observed_at, source_updated_at, deleted, placed_at and due_at.
 */
export function currentOrderSources(name: string, filter = 'true') {
  return `${name} AS MATERIALIZED (
 SELECT p.entity_id,p.connection_id,s.id AS snapshot_id,s.status,s.payment_status,s.display_number,s.observed_at,s.source_updated_at,
 (s.document->>'deleted')::boolean AS deleted,(s.document->'data'->>'placedAt')::timestamptz AS placed_at,
 (s.document->'data'->>'dueAt')::timestamptz AS due_at
 FROM orders_projections p JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
 WHERE p.tenant_id=$1 AND s.kind='order' AND p.connection_id <> ALL(COALESCE(NULLIF(current_setting('app.hidden_order_sources',true),''),'{}')::uuid[]) AND (${filter})
)`;
}

/**
 * Returns CTEs that classify each order source in `set` (shaped like `currentOrderSources`).
 *
 * - `order_line_progress`: entity_id, connection_id, position, line_id, fulfilled and
 *   remaining quantity per line. Fulfilled quantities come only from shipped, delivered or
 *   completed shipments of the same source observed by `asOf`. Remaining uses current units
 *   or ordered minus cancelled units, stays nonnegative and is unknown when neither is read.
 * - `order_state`: every column of `set` plus line_count, fulfillment (`no_lines`,
 *   `unfulfilled`, `partial`, `fulfilled` or `not_required`), open and overdue. Open and
 *   overdue are null when unknown.
 */
export function orderProgress(set: string) {
  return `order_fulfilled AS MATERIALIZED (
 SELECT s.order_id,p.connection_id,l->>'orderLineId' AS line_id,sum((l->>'quantity')::numeric) AS quantity
 FROM (SELECT DISTINCT entity_id,connection_id FROM ${set}) o
 JOIN orders_snapshots s ON s.tenant_id=$1 AND s.order_id=o.entity_id
 JOIN orders_projections p ON p.tenant_id=s.tenant_id AND p.entity_id=s.entity_id AND p.snapshot_id=s.id AND p.connection_id=o.connection_id
 CROSS JOIN LATERAL jsonb_array_elements(s.document->'data'->'lines') l
 WHERE s.kind='fulfillment' AND s.status IN ('completed','shipped','delivered')
 AND s.document->'data'->>'kind' IS DISTINCT FROM 'fulfillment_order'
 AND NOT (s.document->>'deleted')::boolean AND s.observed_at <= $2
 GROUP BY s.order_id,p.connection_id,l->>'orderLineId'
), order_line_progress AS MATERIALIZED (
 SELECT o.entity_id,o.connection_id,l.position,l.value->>'id' AS line_id,COALESCE(f.quantity,0) AS fulfilled,
 CASE WHEN COALESCE(f.quantity,0) >= (l.value->>'quantity')::numeric THEN 0
 WHEN COALESCE(l.value->>'currentQuantity',((l.value->>'quantity')::numeric-(l.value->>'cancelledQuantity')::numeric)::text) IS NULL THEN NULL
 ELSE GREATEST(0,COALESCE((l.value->>'currentQuantity')::numeric,
 (l.value->>'quantity')::numeric-(l.value->>'cancelledQuantity')::numeric)-COALESCE(f.quantity,0)) END AS remaining
 FROM ${set} o JOIN orders_snapshots s ON s.tenant_id=$1 AND s.id=o.snapshot_id
 CROSS JOIN LATERAL jsonb_array_elements(s.document->'data'->'lines') WITH ORDINALITY l(value,position)
 LEFT JOIN order_fulfilled f ON f.order_id=o.entity_id AND f.connection_id=o.connection_id AND f.line_id=l.value->>'id'
), order_line_summary AS MATERIALIZED (
 SELECT entity_id,connection_id,count(*)::int AS line_count,bool_or(remaining>0) AS any_remaining,
 bool_or(remaining IS NULL) AS any_unknown,bool_or(fulfilled>0) AS any_fulfilled
 FROM order_line_progress GROUP BY entity_id,connection_id
), order_state AS MATERIALIZED (
 SELECT o.*,COALESCE(g.line_count,0) AS line_count,
 CASE WHEN g.line_count IS NULL THEN 'no_lines'
 WHEN g.any_remaining OR g.any_unknown THEN CASE WHEN g.any_fulfilled THEN 'partial' ELSE 'unfulfilled' END
 WHEN g.any_fulfilled THEN 'fulfilled' ELSE 'not_required' END AS fulfillment,
 state.open,
 CASE WHEN state.open=false THEN false WHEN state.open IS NULL OR o.due_at IS NULL THEN NULL ELSE o.due_at < $2 END AS overdue
 FROM ${set} o
 LEFT JOIN order_line_summary g ON g.entity_id=o.entity_id AND g.connection_id=o.connection_id
 CROSS JOIN LATERAL (SELECT CASE WHEN o.observed_at > $2 THEN NULL
 WHEN o.deleted OR o.status IN ('completed','cancelled') THEN false
 WHEN o.status<>'open' OR g.line_count IS NULL THEN NULL
 WHEN g.any_remaining THEN true WHEN g.any_unknown THEN NULL ELSE false END AS open) state
)`;
}

/** SQL building blocks that define order state; see `orderProgress` for the rules. */
export const orderStateQueries: OrderStateQueries = {
  sourceSelectionOrder,
  anyDifference,
  comparisonState: comparisonStateSql,
  sourceComparison,
  currentOrderSources,
  orderProgress,
};

// "Differs by source": two or more current, non-removed sources disagree on a known status,
// payment status, total or per-SKU current quantity. Reported ordered units are the fallback
// when reductions are unknown. Unknown values never count, and display
// numbers and dates are not compared because systems number and time the same order
// independently. The list and the detail both use this definition.

/**
 * Returns the `source_values` and `source_differences` CTEs for the orders in `entities`.
 * `sources` must be shaped like `currentOrderSources` and contain every current source of
 * those orders. Orders with fewer than two non-removed sources cannot differ and are left out.
 *
 * - `source_values`: comparable values per non-removed source; null means unknown.
 * - `source_differences`: one row per compared order with a flag per field.
 */
export function sourceComparison(sources: string, entities: string) {
  return `compared_orders AS MATERIALIZED (
 SELECT entity_id FROM ${sources}
 WHERE NOT deleted AND entity_id IN (SELECT entity_id FROM ${entities})
 GROUP BY entity_id HAVING count(*)>1
), source_values AS MATERIALIZED (
 SELECT o.entity_id,o.connection_id,NULLIF(o.status,'unknown') AS status,
 NULLIF(o.payment_status,'unknown') AS payment_status,
 CASE WHEN jsonb_typeof(s.document->'data'->'total')='object'
  THEN trim_scale((s.document->'data'->'total'->>'amount')::numeric)::text||' '||(s.document->'data'->'total'->>'currency') END AS total,
 (SELECT COALESCE(string_agg(k||':'||trim_scale(q)::text,',' ORDER BY (k||':'||trim_scale(q)::text) COLLATE "C"),'')
  FROM (SELECT COALESCE(l->>'skuId','unmapped') AS k,sum(COALESCE((l->>'currentQuantity')::numeric,(l->>'quantity')::numeric-(l->>'cancelledQuantity')::numeric,(l->>'quantity')::numeric)) AS q
  FROM jsonb_array_elements(s.document->'data'->'lines') l GROUP BY 1) lines WHERE q>0) AS lines
 FROM ${sources} o JOIN orders_snapshots s ON s.tenant_id=$1 AND s.id=o.snapshot_id
 WHERE NOT o.deleted AND o.entity_id IN (SELECT entity_id FROM compared_orders)
), source_differences AS MATERIALIZED (
 SELECT entity_id,count(DISTINCT status)>1 AS status,count(DISTINCT payment_status)>1 AS payment_status,
 count(DISTINCT total)>1 AS total,count(DISTINCT lines)>1 AS lines
 FROM source_values GROUP BY entity_id
)`;
}

/** SQL condition that is true when a `source_differences` row `d` reports any difference. */
export const anyDifference =
  '(d.status OR d.payment_status OR d.total OR d.lines)';

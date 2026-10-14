import type { OrderSort, OrderView } from '../../application/orders.js';
import type { OrderReadQueries } from './list-query.js';

/** Sorts the legacy read serves; others need the maintained list projection. */
export type LegacyOrderSort = Extract<
  OrderSort,
  'updated' | 'placed' | 'number' | 'due'
>;

/** Whether the legacy read can serve `sort`. */
export function isLegacySort(sort: string): sort is LegacyOrderSort {
  return Object.hasOwn(sortKeys, sort);
}

// Sort keys are compared as text in byte order. Missing values always sort last.
const sortKeys: Record<LegacyOrderSort, string> = {
  updated: `to_char(COALESCE(o.source_updated_at,o.observed_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')`,
  placed: `to_char(o.placed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')`,
  // Length first keeps "#999" before "#1001" for numbering schemes with a shared prefix. The
  // key is capped so cursors stay small; the order ID still breaks ties deterministically.
  number: `lpad(length(o.display_number)::text,6,'0')||left(lower(o.display_number),120)`,
  due: `to_char(o.due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')`,
};

const viewFilters: Record<Exclude<OrderView, 'differs'>, string> = {
  stuck: `EXISTS (SELECT 1 FROM orders_journey_events j WHERE j.tenant_id=$1 AND j.order_id=o.entity_id AND j.connection_id=o.connection_id AND j.observed_at<=$2
 AND ((j.stage='paid' AND o.payment_status='paid' AND o.open IS TRUE AND j.observed_at<=$2::timestamptz-interval '4 hours') OR j.stage='shipped')
 AND NOT EXISTS(SELECT 1 FROM inventory_native_reservations r WHERE r.tenant_id=$1 AND r.order_id=o.entity_id AND r.order_line_id=j.order_line_id))`,
  all: 'true',
  outstanding: 'o.open IS TRUE',
  overdue: 'o.overdue IS TRUE',
  needs_you:
    'NOT o.deleted AND o.entity_id IN (SELECT order_id FROM attention)',
};

// Current orders whose number, source order ID, SKU text, mapped source SKU ID or Luma ID
// contains the search text. $14 is the raw text and $15 the escaped ILIKE pattern. Row
// security keeps PostgreSQL from using trigram indexes for ILIKE, so this scans the tenant's
// current order snapshots until the tenant backfill completes.
const hits = `sku_hits AS MATERIALIZED (
 SELECT DISTINCT canonical_id::text AS id FROM connector_source_mappings
 WHERE tenant_id=$1 AND ($3::uuid IS NULL OR connection_id=$3) AND resource='sku' AND external_id ILIKE $15
), hits AS MATERIALIZED (
 SELECT p.entity_id AS id FROM orders_snapshots s JOIN orders_projections p ON p.tenant_id=s.tenant_id
  AND p.entity_id=s.entity_id AND p.connection_id=s.connection_id AND p.snapshot_id=s.id
 WHERE s.tenant_id=$1 AND NOT (s.document->>'deleted')::boolean AND ($3::uuid IS NULL OR s.connection_id=$3) AND s.kind='order' AND (s.display_number ILIKE $15
  OR EXISTS (SELECT 1 FROM jsonb_array_elements(s.document->'data'->'lines') l
   WHERE l->>'skuCode' ILIKE $15 OR l->>'skuId' IN (SELECT id FROM sku_hits)))
 UNION SELECT canonical_id FROM connector_source_mappings m
 WHERE tenant_id=$1 AND ($3::uuid IS NULL OR connection_id=$3) AND resource='order' AND external_id ILIKE $15
 AND EXISTS (SELECT 1 FROM orders_projections p JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id WHERE p.tenant_id=$1 AND p.entity_id=m.canonical_id AND p.connection_id=m.connection_id AND s.kind='order' AND NOT (s.document->>'deleted')::boolean)
 UNION SELECT entity_id FROM order_sources WHERE entity_id::text=lower($14)
)`;

/**
 * Builds the list query. Parameters: $1 tenant, $2 as-of time, $3 connection, $4 status,
 * $5 payment status, $6–$7 placed range, $8–$9 source update range, $10 page size plus one,
 * $11–$13 cursor rank, key and order ID. With search, $14 is the text and $15 the escaped
 * ILIKE pattern. `customer` names the parameter that binds the allowed order IDs.
 */
export function legacyListSql(
  queries: OrderReadQueries,
  view: OrderView,
  sort: LegacyOrderSort,
  direction: 'asc' | 'desc',
  search: boolean,
  exactCount = false,
  customer?: number,
) {
  const { state } = queries;
  const { anyDifference, sourceComparison } = state;
  const byProgress = view === 'outstanding' || view === 'overdue';
  const op = direction === 'desc' ? '<' : '>';
  const order = `sort_rank,sort_key ${direction},entity_id ${direction}`;
  const filtered = (set: string) => `filtered AS MATERIALIZED (
 SELECT o.*,CASE WHEN (${sortKeys[sort]}) IS NULL THEN 1 ELSE 0 END AS sort_rank,
 COALESCE(${sortKeys[sort]},'') COLLATE "C" AS sort_key
 FROM ${set} o WHERE NOT o.deleted AND ${view === 'differs' ? `o.entity_id IN (SELECT entity_id FROM source_differences d WHERE ${anyDifference})` : viewFilters[view]}
), page AS MATERIALIZED (
 SELECT * FROM filtered
 WHERE $11::int IS NULL OR sort_rank>$11 OR (sort_rank=$11 AND (sort_key ${op} $12 OR (sort_key=$12 AND entity_id ${op} $13::uuid)))
 ORDER BY ${order} LIMIT $10
)`;
  // Only open, current orders can have outstanding work, so the rest need no classification.
  const candidates = `candidates AS MATERIALIZED (
 SELECT * FROM matched WHERE status='open' AND NOT deleted AND observed_at <= $2${view === 'overdue' ? ' AND due_at < $2' : ''}
)`;
  const steps = byProgress
    ? [
        candidates,
        state.orderProgress('candidates'),
        filtered('order_state'),
        sourceComparison('order_sources', 'page'),
        'rows AS (SELECT * FROM page)',
      ]
    : [
        ...(view === 'differs'
          ? [sourceComparison('order_sources', 'matched')]
          : []),
        filtered('matched'),
        state.orderProgress('page'),
        ...(view === 'differs'
          ? []
          : [sourceComparison('order_sources', 'page')]),
        'rows AS (SELECT * FROM order_state)',
      ];

  return `WITH ${state.currentOrderSources('order_sources')}, selected AS MATERIALIZED (
 SELECT DISTINCT ON (entity_id) * FROM order_sources WHERE ($3::uuid IS NULL OR connection_id=$3)
 ORDER BY entity_id,${state.sourceSelectionOrder}
)${search ? `, ${hits}` : ''}, matched AS MATERIALIZED (
 SELECT o.* FROM selected o
 WHERE ($4::text IS NULL OR o.status=$4) AND ($5::text IS NULL OR o.payment_status=$5)
 AND ($6::timestamptz IS NULL OR o.placed_at >= $6) AND ($7::timestamptz IS NULL OR o.placed_at < $7)
 AND ($8::timestamptz IS NULL OR o.source_updated_at >= $8)
 AND ($9::timestamptz IS NULL OR o.source_updated_at < $9)${
   search
     ? `
 AND o.entity_id IN (SELECT id FROM hits)`
     : ''
 }${
   customer
     ? `
 AND o.entity_id=ANY($${customer}::uuid[])`
     : ''
 }
), attention AS MATERIALIZED (
 SELECT order_id,array_agg(DISTINCT issue_id ORDER BY issue_id) AS issue_ids
 FROM (${queries.attention}) a GROUP BY order_id
), ${steps.join(', ')}, items AS (
SELECT o.entity_id AS id,o.display_number AS "displayNumber",o.placed_at AS "placedAt",
 (SELECT document->'data'->'total' FROM orders_snapshots WHERE tenant_id=$1 AND id=o.snapshot_id) AS total,o.status,o.payment_status AS "paymentStatus",o.fulfillment,
 o.line_count AS "lineCount",o.open,o.overdue,o.due_at AS "dueAt",
 CASE WHEN o.deleted THEN '{}'::uuid[] ELSE COALESCE(a.issue_ids,'{}'::uuid[]) END AS "issueIds",
 COALESCE(${anyDifference},false) AS differs,COALESCE(d.state,'inconclusive') AS "comparisonState",src.sources,o.observed_at AS "observedAt",o.source_updated_at AS "sourceUpdatedAt",
 o.sort_rank AS "sortRank",o.sort_key AS "sortKey"
FROM rows o
LEFT JOIN attention a ON a.order_id=o.entity_id
LEFT JOIN source_differences d ON d.entity_id=o.entity_id
CROSS JOIN LATERAL (
 SELECT jsonb_agg(jsonb_build_object('connectionId',c.connection_id,
  'label',COALESCE(ci.document->>'label',ci.document->'target'->>'kind','Connected source'),
  'system',ci.document->'target'->>'kind','connectionStatus',COALESCE(ci.document->>'status','unknown'),
  'externalId',m.external_id,'selected',c.connection_id=o.connection_id,'deleted',c.deleted,
  'observedAt',c.document->>'observedAt','sourceUpdatedAt',c.document->>'sourceUpdatedAt') ORDER BY c.connection_id) AS sources
 FROM (SELECT p.entity_id,p.connection_id,s.document,(s.document->>'deleted')::boolean AS deleted
  FROM orders_projections p JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
  WHERE p.tenant_id=$1 AND p.entity_id=o.entity_id AND s.kind='order' AND p.connection_id <> ALL(COALESCE(NULLIF(current_setting('app.hidden_order_sources',true),''),'{}')::uuid[])) c
 LEFT JOIN connector_installations ci ON ci.tenant_id=$1 AND ci.id=c.connection_id
 LEFT JOIN LATERAL (SELECT external_id FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=c.connection_id
  AND resource='order' AND canonical_id=c.entity_id ORDER BY created_at,id LIMIT 1) m ON true
) src)
SELECT ${exactCount ? '(SELECT count(*) FROM filtered)::int' : 'NULL::int'} AS "totalCount",
 COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i."sortRank",i."sortKey" ${direction},i.id ${direction}) FROM items i),'[]'::jsonb) AS items`;
}

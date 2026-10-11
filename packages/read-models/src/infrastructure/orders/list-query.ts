import type { OrderStateQueries } from '@luma/orders';

import type { OrderSort, OrderView } from '../../application/orders.js';
import { orderSearchPredicate } from './search-query.js';

/** Owner-provided SQL composed into the Orders reads. */
export interface OrderReadQueries {
  state: OrderStateQueries;
  /** Selects `order_id` and `issue_id` pairs that need a person; binds `$1` and `$2`. */
  attention: string;
  /** Narrows attention evaluation to the named SQL relation of order IDs. */
  attentionFor?: (orders: string) => string;
}

const viewFilters: Record<OrderView, string> = {
  all: 'true',
  outstanding: 'o.open IS TRUE',
  overdue: 'o.open IS TRUE AND o.due_at < $2',
  needs_you:
    'NOT o.deleted AND o.entity_id IN (SELECT order_id FROM attention)',
  differs: 'o.differs',
};

/**
 * Builds the list query. Parameters: $1 tenant, $2 as-of time, $3 connection, $4 status,
 * $5 payment status, $6–$7 placed range, $8–$9 source update range, $10 page size plus one,
 * $11–$13 cursor rank, key and order ID. Selective search binds order IDs at $14. Broad search binds text at $14 and
 * its escaped ILIKE pattern at $15. `customer` names the parameter that binds the allowed order IDs.
 */
export function listSql(
  queries: OrderReadQueries,
  view: OrderView,
  sort: OrderSort,
  direction: 'asc' | 'desc',
  search: false | 'selective' | 'broad',
  connection = false,
  exactCount = false,
  customer?: number,
) {
  const op = direction === 'desc' ? '<' : '>';
  const rank = `${sort}_rank`,
    key = `${sort}_key`;
  const order = `${rank},${key} ${direction},entity_id ${direction}`;
  const attention = `attention AS MATERIALIZED (
    SELECT order_id,array_agg(DISTINCT issue_id ORDER BY issue_id) AS issue_ids
    FROM (${view === 'needs_you' ? queries.attention : (queries.attentionFor?.('page') ?? queries.attention)}) a GROUP BY order_id
  )`;

  // The common path reads maintained scalar rows. Only observations from the future need
  // progress evaluated against the read clock instead of the stored complete state.
  return `WITH future_sources AS MATERIALIZED (
 SELECT entity_id,connection_id,snapshot_id,status,payment_status,display_number,observed_at,source_updated_at,deleted,placed_at,due_at
 FROM orders_list WHERE tenant_id=$1 AND state_valid_from>$2
 AND ${connection ? 'connection_id=$3' : 'selected'}
), ${queries.state.orderProgress('future_sources')},
 ${view === 'needs_you' ? `${attention},` : ''}
 filtered AS NOT MATERIALIZED (
 SELECT o.* FROM orders_list o
 WHERE o.tenant_id=$1 AND NOT o.deleted AND ${connection ? 'o.connection_id=$3' : 'o.selected AND ($3::uuid IS NULL)'}
 AND ($4::text IS NULL OR o.status=$4) AND ($5::text IS NULL OR o.payment_status=$5)
 AND ($6::timestamptz IS NULL OR o.placed_at >= $6) AND ($7::timestamptz IS NULL OR o.placed_at < $7)
 AND ($8::timestamptz IS NULL OR o.source_updated_at >= $8) AND ($9::timestamptz IS NULL OR o.source_updated_at < $9)
 ${search === 'broad' ? `AND ${orderSearchPredicate}` : search === 'selective' ? 'AND o.entity_id=ANY($14::uuid[])' : ''}
 ${customer ? `AND o.entity_id=ANY($${customer}::uuid[])` : ''}
 AND ${
   view === 'outstanding' || view === 'overdue'
     ? `((o.state_valid_from <= $2 AND o.open IS TRUE) OR (o.state_valid_from > $2 AND EXISTS
     (SELECT 1 FROM order_state f WHERE f.entity_id=o.entity_id AND f.connection_id=o.connection_id AND f.open IS TRUE)))${view === 'overdue' ? ' AND o.due_at < $2' : ''}`
     : view === 'differs'
       ? `o.differs AND (${queries.state.comparisonState('o')})='confirmed'`
       : viewFilters[view]
 }
), page AS MATERIALIZED (
 SELECT *,${rank} AS sort_rank,${key} AS sort_key FROM (
  (SELECT * FROM filtered WHERE ${rank}=0 AND ($11::int IS NULL OR
    ($11=0 AND (${key},entity_id) ${op} ($12 COLLATE "C",$13::uuid)))
   ORDER BY ${key} ${direction},entity_id ${direction} LIMIT $10)
  UNION ALL
  (SELECT * FROM filtered WHERE ${rank}=1 AND ($11::int IS NULL OR $11=0 OR
    ($11=1 AND (${key},entity_id) ${op} ($12 COLLATE "C",$13::uuid)))
   ORDER BY ${key} ${direction},entity_id ${direction} LIMIT $10)
 ) candidates ORDER BY ${order} LIMIT $10
), ${view !== 'needs_you' ? `${attention},` : ''} rows AS MATERIALIZED (
 SELECT p.*,${queries.state.comparisonState('p')} AS current_comparison_state,CASE WHEN p.state_valid_from>$2 THEN f.open ELSE p.open END AS current_open,
 CASE WHEN p.state_valid_from>$2 THEN f.fulfillment ELSE p.fulfillment END AS current_fulfillment
 FROM page p LEFT JOIN order_state f ON f.entity_id=p.entity_id AND f.connection_id=p.connection_id
), items AS (
SELECT o.entity_id AS id,o.display_number AS "displayNumber",o.placed_at AS "placedAt",
 (SELECT document->'data'->'total' FROM orders_snapshots WHERE tenant_id=$1 AND id=o.snapshot_id) AS total,o.status,o.payment_status AS "paymentStatus",o.current_fulfillment AS fulfillment,
 o.line_count AS "lineCount",o.current_open AS open,
 CASE WHEN o.current_open=false THEN false WHEN o.current_open IS NULL OR o.due_at IS NULL THEN NULL ELSE o.due_at < $2 END AS overdue,o.due_at AS "dueAt",
 CASE WHEN o.deleted THEN '{}'::uuid[] ELSE COALESCE(a.issue_ids,'{}'::uuid[]) END AS "issueIds",
 o.current_comparison_state='confirmed' AS differs,o.current_comparison_state AS "comparisonState",src.sources,o.observed_at AS "observedAt",o.source_updated_at AS "sourceUpdatedAt",
 o.sort_rank AS "sortRank",o.sort_key AS "sortKey"
FROM rows o
LEFT JOIN attention a ON a.order_id=o.entity_id
CROSS JOIN LATERAL (
 SELECT jsonb_agg(jsonb_build_object('connectionId',c.connection_id,
  'label',COALESCE(ci.document->>'label',ci.document->'target'->>'kind','Connected source'),
  'system',ci.document->'target'->>'kind','connectionStatus',COALESCE(ci.document->>'status','unknown'),
  'externalId',m.external_id,'selected',c.connection_id=o.connection_id,'deleted',c.deleted,
  'observedAt',c.document->>'observedAt','sourceUpdatedAt',c.document->>'sourceUpdatedAt') ORDER BY c.connection_id) AS sources
 FROM (SELECT p.entity_id,p.connection_id,s.document,(s.document->>'deleted')::boolean AS deleted
  FROM orders_projections p JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
  WHERE p.tenant_id=$1 AND p.entity_id=o.entity_id AND s.kind='order') c
 LEFT JOIN connector_installations ci ON ci.tenant_id=$1 AND ci.id=c.connection_id
 LEFT JOIN LATERAL (SELECT external_id FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=c.connection_id
  AND resource='order' AND canonical_id=c.entity_id ORDER BY created_at,id LIMIT 1) m ON true
) src)
SELECT ${exactCount ? '(SELECT count(*) FROM filtered)::int' : 'NULL::int'} AS "totalCount",
 COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i."sortRank",i."sortKey" ${direction},i.id ${direction}) FROM items i),'[]'::jsonb) AS items`;
}

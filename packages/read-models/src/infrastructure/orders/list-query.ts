import type { OrderStateQueries } from '@luma/orders';

import type { OrderView } from '../../application/orders.js';
import {
  type CollectionOrdering,
  keysetCandidates,
  sortColumns,
  sortOrder,
} from '../collection/keyset.js';
import type { OrderFieldPart } from './collection-fields.js';
import {
  orderCustomerSearchPredicate,
  orderSearchPredicate,
} from './search-query.js';

/** Owner-provided SQL composed into the Orders reads. */
export interface OrderReadQueries {
  state: OrderStateQueries;
  /** Selects `order_id` and `issue_id` pairs that need a person; binds `$1` and `$2`. */
  attention: string;
  /** Narrows attention evaluation to the named SQL relation of order IDs. */
  attentionFor?: (orders: string) => string;
}

const viewFilters: Record<OrderView, string> = {
  stuck: `EXISTS (SELECT 1 FROM orders_journey_events j WHERE j.tenant_id=$1 AND j.order_id=o.entity_id AND j.connection_id=o.connection_id AND j.observed_at<=$2
 AND ((j.stage='paid' AND o.payment_status='paid' AND o.open IS TRUE AND j.observed_at<=$2::timestamptz-interval '4 hours') OR j.stage='shipped')
 AND NOT EXISTS(SELECT 1 FROM inventory_native_reservations r WHERE r.tenant_id=$1 AND r.order_id=o.entity_id AND r.order_line_id=j.order_line_id))`,
  all: 'true',
  outstanding: 'o.open IS TRUE',
  overdue: 'o.open IS TRUE AND o.due_at < $2',
  needs_you:
    'NOT o.deleted AND o.entity_id IN (SELECT order_id FROM attention)',
  differs: 'o.differs',
};

const uuidPattern =
  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

// Orders with an unresolved issue about the order or one of its fulfillments, whether or not
// it currently needs a person. Issues name records by Luma ID or by source ID in a connection.
const issueOrders = `issue_orders AS MATERIALIZED (
 SELECT m.canonical_id AS order_id FROM exceptions e JOIN connector_source_mappings m ON m.tenant_id=e.tenant_id
  AND m.resource='order' AND m.external_id=e.subject_id AND m.connection_id::text=e.document->'subject'->'scope'->>0
 WHERE e.tenant_id=$1 AND e.state<>'resolved' AND e.subject_kind='order'
 UNION SELECT e.subject_id::uuid FROM exceptions e
 WHERE e.tenant_id=$1 AND e.state<>'resolved' AND e.subject_kind='order' AND e.subject_id ~* '${uuidPattern}'
 UNION SELECT r.order_id FROM exceptions e JOIN connector_source_mappings m ON m.tenant_id=e.tenant_id
  AND m.resource='fulfillment' AND m.scope_key='' AND m.external_id=e.subject_id AND m.connection_id::text=e.document->'subject'->'scope'->>0
 JOIN orders_relationships r ON r.tenant_id=m.tenant_id AND r.child_id=m.canonical_id
 WHERE e.tenant_id=$1 AND e.state<>'resolved' AND e.subject_kind='fulfillment'
 UNION SELECT r.order_id FROM exceptions e JOIN orders_relationships r ON r.tenant_id=e.tenant_id
  AND r.child_id=CASE WHEN e.subject_id ~* '${uuidPattern}' THEN e.subject_id::uuid END
 WHERE e.tenant_id=$1 AND e.state<>'resolved' AND e.subject_kind='fulfillment'
)`;

/** How the native list query selects the rows it returns. */
export type OrderPageMode =
  | { kind: 'keyset' }
  | { kind: 'adaptive'; sort: string | undefined; offsetParameter: string }
  /** `ctes` come from `groupCtes` over `filtered`; the page holds every group's head rows. */
  | { kind: 'groups'; ctes: string; json: string; headIds: string };

/** Options of the native list query. Every SQL fragment is trusted, parameterized SQL. */
export interface OrderListSqlOptions {
  view: OrderView;
  ordering: CollectionOrdering;
  search: false | 'selective' | 'broad';
  /** A broad search also matches the customer's name and email address. */
  customerSearch?: boolean;
  connection: boolean;
  exactCount: boolean;
  /** Parameter number binding the customer's order IDs. */
  customer?: number | undefined;
  /** Extra predicates over the list row `o`, such as compiled conditions. */
  predicates: readonly string[];
  /** Query parts the predicates or groups read. */
  requires: ReadonlySet<OrderFieldPart>;
  page: OrderPageMode;
}

/**
 * Builds the native list query over maintained orders_list rows. Parameters: $1 tenant,
 * $2 as-of time, $3 connection, $4 status, $5 payment status, $6–$7 placed range, $8–$9 source
 * update range, $10 page size plus one, $11–$13 cursor rank, keys (text[]) and order ID.
 * Selective search binds order IDs at $14; broad search binds text at $14 and its escaped
 * ILIKE pattern at $15. Later parameters are bound by the caller's fragments.
 *
 * Returns one row: `totalCount` (null unless exact), `items` in page order with their cursor
 * positions, and `groups` (JSON, grouped pages only).
 */
export function listSql(
  queries: OrderReadQueries,
  options: OrderListSqlOptions,
) {
  const { view, ordering, search, connection, page, requires } = options;
  const attention = `attention AS MATERIALIZED (
    SELECT order_id,array_agg(DISTINCT issue_id ORDER BY issue_id) AS issue_ids
    FROM (${view === 'needs_you' ? queries.attention : (queries.attentionFor?.('page') ?? queries.attention)}) a GROUP BY order_id
  )`;
  const parts = [
    ...(view === 'needs_you' ? [attention] : []),
    ...(requires.has('needsYou')
      ? [
          `needs_you_orders AS MATERIALIZED (${view === 'needs_you' ? 'SELECT order_id FROM attention' : `SELECT DISTINCT order_id FROM (${queries.attention}) a`})`,
        ]
      : []),
    ...(requires.has('hasIssue') ? [issueOrders] : []),
  ];
  const pageSql =
    page.kind === 'adaptive'
      ? `page AS MATERIALIZED (
 SELECT o.*,${sortColumns(ordering)},row_number() OVER(ORDER BY ${page.sort ?? sortOrder(ordering)}) AS page_position
 FROM filtered o ORDER BY ${page.sort ?? sortOrder(ordering)} LIMIT $10 OFFSET ${page.offsetParameter}
)`
      : page.kind === 'groups'
        ? `${page.ctes}, page AS MATERIALIZED (
 SELECT o.*,0 AS sort_rank,'{}'::text[] AS sort_keys,0 AS page_position FROM filtered o WHERE o.entity_id IN (SELECT id::uuid FROM (${page.headIds}) h)
)`
        : `page AS MATERIALIZED (
 SELECT o.*,row_number() OVER(ORDER BY ${sortOrder(ordering)}) AS page_position FROM (
  ${keysetCandidates('filtered', ordering, '$10', { rank: '$11::int', keys: '$12::text[]', id: '$13::uuid' })}
 ) o ORDER BY ${sortOrder(ordering)} LIMIT $10
)`;

  // The common path reads maintained scalar rows. Only observations from the future need
  // progress evaluated against the read clock instead of the stored complete state.
  return `WITH future_sources AS MATERIALIZED (
 SELECT entity_id,connection_id,snapshot_id,status,payment_status,display_number,observed_at,source_updated_at,deleted,placed_at,due_at
 FROM orders_list WHERE tenant_id=$1 AND state_valid_from>$2
 AND ${connection ? 'connection_id=$3' : 'selected'}
), ${queries.state.orderProgress('future_sources')},
 ${parts.map((part) => `${part},`).join('\n ')}
 filtered AS NOT MATERIALIZED (
 SELECT o.* FROM orders_list o
 WHERE o.tenant_id=$1 AND NOT o.deleted AND ${connection ? 'o.connection_id=$3' : 'o.selected AND ($3::uuid IS NULL)'}
 AND NOT EXISTS (SELECT 1 FROM connector_installations c WHERE c.tenant_id=$1 AND c.id=$3
  AND COALESCE(c.document->>'provider',c.document->'target'->>'kind')='starshipit')
 AND ($4::text IS NULL OR o.status=$4) AND ($5::text IS NULL OR o.payment_status=$5)
 AND ($6::timestamptz IS NULL OR o.placed_at >= $6) AND ($7::timestamptz IS NULL OR o.placed_at < $7)
 AND ($8::timestamptz IS NULL OR o.source_updated_at >= $8) AND ($9::timestamptz IS NULL OR o.source_updated_at < $9)
 AND ($10::int IS NOT NULL) AND ($11::int IS NULL OR $11 IS NOT NULL) AND ($12::text[] IS NULL OR $12 IS NOT NULL) AND ($13::uuid IS NULL OR $13 IS NOT NULL)
 ${search === 'broad' ? `AND (${orderSearchPredicate}${options.customerSearch ? ` OR ${orderCustomerSearchPredicate}` : ''})` : search === 'selective' ? 'AND o.entity_id=ANY($14::uuid[])' : ''}
 ${options.customer ? `AND o.entity_id=ANY($${options.customer}::uuid[])` : ''}
 ${options.predicates.map((predicate) => `AND (${predicate})`).join('\n ')}
 AND ${
   view === 'outstanding' || view === 'overdue'
     ? `((o.state_valid_from <= $2 AND o.open IS TRUE) OR (o.state_valid_from > $2 AND EXISTS
     (SELECT 1 FROM order_state f WHERE f.entity_id=o.entity_id AND f.connection_id=o.connection_id AND f.open IS TRUE)))${view === 'overdue' ? ' AND o.due_at < $2' : ''}`
     : view === 'differs'
       ? `o.differs AND (${queries.state.comparisonState('o')})='confirmed'`
       : viewFilters[view]
 }
), ${pageSql}, ${view !== 'needs_you' ? `${attention},` : ''} rows AS MATERIALIZED (
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
 o.channel,o.test,(SELECT COALESCE(array_agg(t.value ORDER BY t.value),'{}'::text[]) FROM orders_list_facets t WHERE t.tenant_id=$1 AND t.entity_id=o.entity_id AND t.connection_id=o.connection_id AND t.kind='tag') AS tags,
 o.page_position AS "pagePosition",o.sort_rank AS "sortRank",o.sort_keys AS "sortKeys"
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
SELECT ${options.exactCount ? '(SELECT count(*) FROM filtered)::int' : 'NULL::int'} AS "totalCount",
 COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i."pagePosition",i.id) FROM items i),'[]'::jsonb) AS items,
 ${page.kind === 'groups' ? page.json : 'NULL::jsonb'} AS groups`;
}

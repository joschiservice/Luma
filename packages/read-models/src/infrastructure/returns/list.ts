import { stageGroups } from '@luma/orders';
import type { SqlTransaction } from '@luma/platform';

import type {
  ReturnListItem,
  ReturnQuery,
  ReturnSource,
  ReturnStage,
  ReturnView,
} from '../../application/returns.js';
import type { CollectionCursorPosition } from '../collection/cursor.js';
import {
  type CollectionGroupRow,
  groupCtes,
  groupHeadIds,
  groupMemberPredicate,
  groupsJson,
} from '../collection/group.js';
import {
  type CollectionOrdering,
  keysetCandidates,
  sortOrder,
} from '../collection/keyset.js';
import { likePattern } from '../collection/parameters.js';
import {
  collectionContext,
  collectionGrouping,
  collectionGroupLimit,
  maxCollectionGroups,
} from '../collection/request.js';
import { compileWhere } from '../collection/where.js';
import {
  returnCollectionFields,
  returnGroupFields,
  returnSorts,
} from './collection-fields.js';

const iso = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const decimal = (column: string) => `trim_scale(${column})::text`;

/** Selects one `orders_returns` row, aliased `r`, in the shape of a list item. */
export const itemColumns = `r.entity_id AS id,r.kind,r.connection_id AS "connectionId",
 (SELECT m.external_id FROM connector_source_mappings m WHERE m.tenant_id=r.tenant_id AND m.resource=r.kind
  AND m.canonical_id=r.entity_id AND m.connection_id=r.connection_id ORDER BY m.external_id LIMIT 1) AS "externalId",
 r.name,jsonb_build_object('id',r.order_id,'displayNumber',r.order_number) AS "order",r.status,r.stage,
 r.stage_group AS "group",
 jsonb_build_object('state',r.refund_state,'currency',r.currency,'refunded',${decimal('r.refunded_amount')},
  'pending',${decimal('r.pending_amount')},'failedAttempts',r.failed_attempts) AS refund,
 ${decimal('r.quantity')} AS quantity,${decimal('r.received')} AS received,
 ${decimal('r.refunded_units')} AS "refundedUnits",
 CASE WHEN r.value_amount IS NULL THEN NULL
  ELSE jsonb_build_object('amount',${decimal('r.value_amount')},'currency',r.value_currency) END AS value,
 r.reasons,${iso('r.requested_at')} AS "requestedAt",${iso('r.activity_at')} AS "activityAt",
 ${iso('r.observed_at')} AS "observedAt",${iso('r.source_updated_at')} AS "sourceUpdatedAt",r.deleted`;

/** One page of returns, or every group's first rows, with counts per view and stage. */
export interface ReturnPage {
  rows: { item: ReturnListItem; position: CollectionCursorPosition }[];
  counts: {
    views: Record<ReturnView, number>;
    stages: Record<ReturnStage, number>;
  };
  groups: CollectionGroupRow[] | null;
  /** Exact match count, read only for one group's pages. */
  total: number | null;
}

/**
 * Lists up to `limit + 1` returns for the filters and conditions after `after`, or with
 * `group` every group's count and first rows, with counts per view and stage. Removed records
 * are excluded. Search matches the return name, order number, reasons and source IDs of the
 * return, refund or order, and with `customers` the name and email address of the order's
 * customer when the source shares contact details. Throws a 400 error for invalid conditions
 * or grouping. Relative dates resolve against `asOf`.
 */
export async function readReturns(
  tx: SqlTransaction,
  tenantId: string,
  userId: string,
  query: ReturnQuery,
  asOf: string,
  after: CollectionCursorPosition | null,
  customers: boolean,
): Promise<ReturnPage> {
  const q = query.q.trim();
  const values: unknown[] = [
    tenantId,
    query.connectionId ?? null,
    q,
    likePattern(q),
    customers,
    query.view,
    query.stage ?? null,
  ];
  const context = collectionContext(values, asOf, query.timeZone, userId);
  const { parameters } = context;
  const where = query.where?.conditions.length
    ? compileWhere(query.where, returnCollectionFields, context).sql
    : 'true';
  const { request, grouped } = collectionGrouping(query, returnGroupFields);
  const member =
    request && query.groupKey !== undefined
      ? groupMemberPredicate(request, query.groupKey, context)
      : 'true';
  const ordering: CollectionOrdering = {
    sort: returnSorts[query.sort],
    direction: query.direction,
    id: 'o.entity_id',
  };
  let page: string;
  let groups = 'NULL::jsonb';
  let ctes = '';
  if (request && grouped) {
    ctes = `${groupCtes(
      'filtered',
      request,
      ordering,
      parameters.bind(collectionGroupLimit(query), 'integer'),
      maxCollectionGroups,
      {
        field: 'value',
        amount: 'o.value_amount',
        currency: 'o.value_currency',
      },
      context,
    )},`;
    groups = groupsJson;
    page = `SELECT o.*,0 AS sort_rank,'{}'::text[] AS sort_keys,0::bigint AS n FROM filtered o
 WHERE o.entity_id IN (SELECT id::uuid FROM (${groupHeadIds}) h)`;
  } else {
    const limit = parameters.bind(query.limit + 1, 'integer');
    page = `SELECT o.*,row_number() OVER (ORDER BY ${sortOrder(ordering)}) AS n FROM (${keysetCandidates(
      'filtered',
      ordering,
      limit,
      {
        rank: parameters.bind(after?.rank ?? null, 'integer'),
        keys: parameters.bind(after?.keys ?? null, 'text[]'),
        id: parameters.bind(after?.id ?? null, 'uuid'),
      },
    )}) o ORDER BY ${sortOrder(ordering)} LIMIT ${limit}`;
  }
  const result = await tx.query<{
    stages: { stage: ReturnStage; count: number }[];
    total: number | null;
    page: (ReturnListItem & { sortRank: 0 | 1; sortKeys: (string | null)[] })[];
    groups: CollectionGroupRow[] | null;
  }>(
    // Matching customers resolve to their orders once, so search stays one semi-join.
    `WITH customer_orders_matched AS MATERIALIZED (
  SELECT DISTINCT m.canonical_id AS order_id FROM customer_profiles p
  JOIN customer_orders c ON c.tenant_id=p.tenant_id AND c.connection_id=p.connection_id AND c.customer_external_id=p.external_id
  JOIN connector_source_mappings m ON m.tenant_id=c.tenant_id AND m.connection_id=c.connection_id
   AND m.resource='order' AND m.scope_key=c.order_scope_key AND m.external_id=c.order_external_id
  WHERE p.tenant_id=$1 AND $5::boolean AND $3<>'' AND p.contact_shared
   AND (p.display_name ILIKE $4 OR p.email ILIKE $4)
), matched AS MATERIALIZED (
  SELECT o.* FROM orders_returns o
  WHERE o.tenant_id=$1 AND NOT o.deleted AND ($2::uuid IS NULL OR o.connection_id=$2)
   AND ($3='' OR o.name ILIKE $4 OR o.order_number ILIKE $4 OR o.entity_id::text=lower($3)
    OR o.order_id::text=lower($3) OR EXISTS (SELECT 1 FROM unnest(o.reasons) reason WHERE reason ILIKE $4)
    OR EXISTS (SELECT 1 FROM connector_source_mappings m WHERE m.tenant_id=$1
     AND m.resource IN ('return','refund','order') AND m.canonical_id IN (o.entity_id,o.order_id)
     AND m.connection_id=o.connection_id AND m.external_id ILIKE $4)
    OR o.order_id IN (SELECT order_id FROM customer_orders_matched))
   AND ${where}
), filtered AS NOT MATERIALIZED (
  SELECT * FROM matched o WHERE ($6='all' OR o.stage_group=$6) AND ($7::text IS NULL OR o.stage=$7) AND ${member}
), ${ctes} page AS MATERIALIZED (${page})
SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object('stage',stage,'count',count)) FROM
  (SELECT stage,count(*)::int AS count FROM matched GROUP BY stage) s),'[]') AS stages,
 ${query.groupKey !== undefined ? '(SELECT count(*) FROM filtered)::int' : 'NULL::int'} AS total,
 COALESCE((SELECT jsonb_agg(to_jsonb(i)-'n' ORDER BY i.n,i.id) FROM (
  SELECT ${itemColumns},r.sort_rank AS "sortRank",r.sort_keys AS "sortKeys",r.n FROM page r) i),'[]') AS page,
 ${groups} AS groups`,
    values,
  );
  const row = result.rows[0]!;
  const stages: Record<ReturnStage, number> = {
    requested: 0,
    awaiting_items: 0,
    awaiting_refund: 0,
    refund_pending: 0,
    refund_failed: 0,
    ready_to_close: 0,
    closed: 0,
    declined: 0,
    cancelled: 0,
    refunded: 0,
    refund_recorded: 0,
    unknown: 0,
  };
  const byView: Record<ReturnView, number> = {
    action: 0,
    waiting: 0,
    done: 0,
    all: 0,
  };
  for (const { stage, count } of row.stages) {
    stages[stage] = count;
    byView.all += count;
    byView[stageGroups[stage]] += count;
  }

  return {
    rows: row.page.map(({ sortRank, sortKeys, ...item }) => ({
      position: { rank: sortRank, keys: sortKeys, id: item.id },
      item,
    })),
    counts: { views: byView, stages },
    groups: row.groups,
    total: row.total,
  };
}

/**
 * Lists commerce connections with whether they share returns, how many Luma holds and the
 * state of their returns sync. Connections that read orders are included even without returns,
 * so missing access is visible.
 */
export async function readReturnSources(tx: SqlTransaction, tenantId: string) {
  const result = await tx.query<ReturnSource>(
    `WITH counted AS (SELECT connection_id,count(*)::int AS records FROM orders_returns
      WHERE tenant_id=$1 AND NOT deleted GROUP BY connection_id)
     SELECT c.id AS "connectionId",COALESCE(c.document->>'label',c.document->'target'->>'kind','Connected source') AS label,
      COALESCE(c.document->>'provider',c.document->'target'->>'kind') AS system,c.document->>'appId' AS "appId",
      COALESCE(c.document->>'status','unknown') AS status,
      CASE WHEN c.document->'granted' ? 'returns.read' THEN 'granted'
       WHEN c.document->'permissions' ? 'returns.read' THEN 'not_granted' ELSE 'not_requested' END AS access,
      COALESCE(n.records,0) AS records,COALESCE(st.phase='backfill',false) AS importing,
      ${iso('st.last_full_scan_at')} AS "fullReadAt",${iso('st.last_success_at')} AS "lastReadAt",
      st.error_code IS NOT NULL AS failing
     FROM connector_installations c
     LEFT JOIN counted n ON n.connection_id=c.id
     LEFT JOIN commerce_sync_streams st ON st.tenant_id=c.tenant_id AND st.connection_id=c.id AND st.record_type='returns'
     WHERE c.tenant_id=$1 AND (n.connection_id IS NOT NULL OR (c.document->'permissions' ? 'orders.read'
      AND c.document->>'status' NOT IN ('disconnected','revoked')))
     ORDER BY label,c.id`,
    [tenantId],
  );

  return result.rows;
}

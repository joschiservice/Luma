import type { SqlTransaction } from '@luma/platform';

import type {
  FulfillmentItem,
  FulfillmentQuery,
  FulfillmentView,
} from '../../application/fulfillment.js';
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
  fulfillmentCollectionFields,
  fulfillmentDirection,
  fulfillmentGroupFields,
  fulfillmentSort,
} from './collection-fields.js';
import { classified, itemJson, readItem, stalledAfterHours } from './rules.js';

export { fulfillmentDirection } from './collection-fields.js';

// Search matches order numbers, tracking numbers, location names and source order or
// fulfillment IDs literally.
const filters = `($4::uuid IS NULL OR f.connection_id=$4) AND ($5::uuid IS NULL OR f.location_id=$5)
 AND ($6::text IS NULL OR f.kind=$6) AND ($7='' OR f.order_number ILIKE $8 OR f.location_name ILIKE $8
  OR EXISTS (SELECT 1 FROM unnest(f.tracking_numbers) t WHERE t ILIKE $8)
  OR f.entity_id IN (SELECT m.canonical_id FROM connector_source_mappings m WHERE m.tenant_id=$1
   AND m.resource='fulfillment' AND m.external_id ILIKE $8)
  OR f.order_id IN (SELECT m.canonical_id FROM connector_source_mappings m WHERE m.tenant_id=$1
   AND m.resource='order' AND m.external_id ILIKE $8))`;

const views = `($9='all' OR ($9='attention' AND o.attention) OR ($9='held' AND o.held) OR ($9='delayed' AND o.delayed)
  OR ($9='open' AND o.open) OR ($9='in_transit' AND o.in_transit))`;

/** One page of fulfillments, or every group's first rows, with per-view counts. */
export interface FulfillmentPage {
  counts: Record<FulfillmentView, number>;
  /** Page rows in order (up to `limit` + 1), or every group's first rows when grouped. */
  items: { item: FulfillmentItem; position: CollectionCursorPosition }[];
  groups: CollectionGroupRow[] | null;
  /** Exact match count of the view, read only for one group's pages. */
  total: number | null;
}

/**
 * Reads one page of up to `limit` + 1 fulfillments after `after`, or with `group` every
 * group's count and first rows, with per-view counts under the search, filters and
 * conditions, evaluated at `asOf`. Throws a 400 error for invalid conditions or grouping.
 */
export async function readFulfillments(
  tx: SqlTransaction,
  tenantId: string,
  userId: string,
  query: FulfillmentQuery,
  asOf: string,
  after: CollectionCursorPosition | null,
): Promise<FulfillmentPage> {
  const values: unknown[] = [
    tenantId,
    asOf,
    stalledAfterHours,
    query.connectionId ?? null,
    query.locationId ?? null,
    query.kind ?? null,
    query.q,
    likePattern(query.q),
    query.view,
  ];
  const context = collectionContext(values, asOf, query.timeZone, userId);
  const { parameters } = context;
  const where = query.where?.conditions.length
    ? compileWhere(query.where, fulfillmentCollectionFields, context).sql
    : 'true';
  const { request, grouped } = collectionGrouping(
    query,
    fulfillmentGroupFields,
  );
  const member =
    request && query.groupKey !== undefined
      ? groupMemberPredicate(request, query.groupKey, context)
      : 'true';
  const direction = fulfillmentDirection(query);
  const ordering: CollectionOrdering = {
    sort: fulfillmentSort(query.sort, direction),
    direction,
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
      undefined,
      context,
    )},`;
    groups = groupsJson;
    page = `SELECT o.*,0 AS sort_rank,'{}'::text[] AS sort_keys,0::bigint AS n FROM filtered o
 WHERE o.entity_id IN (SELECT id::uuid FROM (${groupHeadIds}) h)`;
  } else {
    const limit = parameters.bind((query.limit ?? 50) + 1, 'integer');
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
    counts: Record<FulfillmentView, number>;
    total: number | null;
    page: (Record<string, unknown> & {
      sortRank: 0 | 1;
      sortKeys: (string | null)[];
    })[];
    groups: CollectionGroupRow[] | null;
  }>(
    `WITH ${classified(filters)},
matched AS MATERIALIZED (SELECT * FROM classified o WHERE ${where}),
filtered AS NOT MATERIALIZED (SELECT * FROM matched o WHERE ${views} AND ${member}),
${ctes} page AS MATERIALIZED (${page})
SELECT (SELECT jsonb_build_object('all',count(*),'attention',count(*) FILTER (WHERE attention),
  'held',count(*) FILTER (WHERE held),'delayed',count(*) FILTER (WHERE delayed),'open',count(*) FILTER (WHERE open),
  'in_transit',count(*) FILTER (WHERE in_transit)) FROM matched) AS counts,
 ${query.groupKey !== undefined ? '(SELECT count(*) FROM filtered)::int' : 'NULL::int'} AS total,
 COALESCE((SELECT jsonb_agg(${itemJson}||jsonb_build_object('sortRank',c.sort_rank,'sortKeys',c.sort_keys)
  ORDER BY c.n,c.entity_id) FROM page c JOIN orders_snapshots s ON s.tenant_id=c.tenant_id AND s.id=c.snapshot_id),'[]') AS page,
 ${groups} AS groups`,
    values,
  );
  const row = result.rows[0]!;

  return {
    counts: row.counts,
    total: row.total,
    groups: row.groups,
    items: row.page.map((value) => {
      const item = readItem(value);

      return {
        item,
        position: { rank: value.sortRank, keys: value.sortKeys, id: item.id },
      };
    }),
  };
}

/**
 * Whether a fulfillment import of the tenant is still reading a source's history, so group
 * counts may miss records.
 */
export async function fulfillmentsImporting(
  tx: SqlTransaction,
  tenantId: string,
) {
  const result = await tx.query(
    `SELECT 1 FROM commerce_sync_streams WHERE tenant_id=$1 AND record_type='fulfillments' AND phase='backfill' LIMIT 1`,
    [tenantId],
  );

  return !!result.rowCount;
}

/** Lists mapped locations with their open fulfillment count. */
export async function readLocations(tx: SqlTransaction, tenantId: string) {
  const result = await tx.query<{
    id: string;
    name: string | null;
    open: number;
  }>(
    `SELECT location_id AS id,max(location_name) AS name,(count(*) FILTER (WHERE open))::int AS open
     FROM orders_fulfillment_list WHERE tenant_id=$1 AND location_id IS NOT NULL
     GROUP BY location_id ORDER BY max(location_name) NULLS LAST,location_id`,
    [tenantId],
  );

  return result.rows;
}

import type { SqlTransaction } from '@luma/platform';

import type {
  FulfillmentItem,
  FulfillmentQuery,
  FulfillmentView,
} from '../../application/fulfillment.js';
import { iso } from '../orders/values.js';
import { classified, itemJson, readItem, stalledAfterHours } from './rules.js';

/** Position of the last fulfillment on a page, in the requested order. */
export interface FulfillmentPosition {
  rank: number;
  key: string;
  entityId: string;
  connectionId: string;
}

const orders = {
  waiting: {
    rank: '0',
    key: 'c.progress_at',
    order: 'sort_key,c.entity_id,c.connection_id',
    after: '>',
  },
  recent: {
    rank: '0',
    key: 'c.progress_at',
    order: 'sort_key DESC,c.entity_id DESC,c.connection_id DESC',
    after: '<',
  },
  deadline: {
    rank: '(c.deadline_at IS NULL)::int',
    key: 'COALESCE(c.deadline_at,c.progress_at)',
    order: 'sort_rank,sort_key,c.entity_id,c.connection_id',
    after: '>',
  },
} as const;

// Search matches order numbers, tracking numbers, location names and source order or
// fulfillment IDs literally.
const filters = `($4::uuid IS NULL OR f.connection_id=$4) AND ($5::uuid IS NULL OR f.location_id=$5)
 AND ($6::text IS NULL OR f.kind=$6) AND ($7='' OR f.order_number ILIKE $8 OR f.location_name ILIKE $8
  OR EXISTS (SELECT 1 FROM unnest(f.tracking_numbers) t WHERE t ILIKE $8)
  OR f.entity_id IN (SELECT m.canonical_id FROM connector_source_mappings m WHERE m.tenant_id=$1
   AND m.resource='fulfillment' AND m.external_id ILIKE $8)
  OR f.order_id IN (SELECT m.canonical_id FROM connector_source_mappings m WHERE m.tenant_id=$1
   AND m.resource='order' AND m.external_id ILIKE $8))`;

function listSql(sort: FulfillmentQuery['sort']) {
  const { rank, key, order, after } = orders[sort];

  return `WITH ${classified(filters)},
selected AS (
 SELECT c.*,${rank} AS sort_rank,${key} AS sort_key FROM classified c
 WHERE ($9='all' OR ($9='attention' AND c.attention) OR ($9='held' AND c.held) OR ($9='delayed' AND c.delayed)
  OR ($9='open' AND c.open) OR ($9='in_transit' AND c.in_transit))
  AND ($10::int IS NULL OR (${rank},${key},c.entity_id,c.connection_id)${after}($10,$11::timestamptz,$12::uuid,$13::uuid))
 ORDER BY ${order.replaceAll('sort_rank', rank).replaceAll('sort_key', key)} LIMIT $14
)
SELECT (SELECT jsonb_build_object('all',count(*),'attention',count(*) FILTER (WHERE attention),
  'held',count(*) FILTER (WHERE held),'delayed',count(*) FILTER (WHERE delayed),'open',count(*) FILTER (WHERE open),
  'in_transit',count(*) FILTER (WHERE in_transit)) FROM classified) AS counts,
 COALESCE((SELECT jsonb_agg(${itemJson}||jsonb_build_object('rank',c.sort_rank,'key',c.sort_key)
  ORDER BY ${order}) FROM selected c JOIN orders_snapshots s ON s.tenant_id=c.tenant_id AND s.id=c.snapshot_id),'[]') AS page`;
}

/**
 * Reads one page of up to `limit` + 1 fulfillments with per-view counts under the current
 * search and filters, evaluated at `asOf`.
 */
export async function readFulfillments(
  tx: SqlTransaction,
  tenantId: string,
  query: FulfillmentQuery,
  asOf: string,
  after: FulfillmentPosition | null,
) {
  const pattern = `%${query.q.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
  const result = await tx.query<{
    counts: Record<FulfillmentView, number>;
    page: (Record<string, unknown> & { rank: number; key: string })[];
  }>(listSql(query.sort), [
    tenantId,
    asOf,
    stalledAfterHours,
    query.connectionId ?? null,
    query.locationId ?? null,
    query.kind ?? null,
    query.q,
    pattern,
    query.view,
    after?.rank ?? null,
    after?.key ?? null,
    after?.entityId ?? null,
    after?.connectionId ?? null,
    (query.limit ?? 50) + 1,
  ]);
  const { counts, page } = result.rows[0]!;

  return {
    counts,
    items: page.map((row) => {
      const item: FulfillmentItem = readItem(row);

      return {
        item,
        position: {
          rank: row.rank,
          key: iso(row.key)!,
          entityId: item.id,
          connectionId: item.connectionId,
        },
      };
    }),
  };
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

import type { TenantContext } from '@luma/identity';
import type { SqlTransaction } from '@luma/platform';

import type {
  OrderList,
  OrderListItem,
  OrderListQuery,
} from '../../application/orders.js';
import { cursorContext, readCursor, writeCursor } from './cursor.js';
import { legacyListSql } from './legacy-list-query.js';
import type { OrderReadQueries } from './list-query.js';
import { listSql } from './list-query.js';
import { orderSearchHits } from './search-query.js';
import { iso, money, source } from './values.js';

type ListRow = Omit<
  OrderListItem,
  'placedAt' | 'dueAt' | 'observedAt' | 'sourceUpdatedAt' | 'sources' | 'total'
> & {
  placedAt: string | null;
  dueAt: string | null;
  observedAt: string;
  sourceUpdatedAt: string | null;
  total: unknown;
  sources: Record<string, unknown>[];
  sortRank: number;
  sortKey: string;
};

// Escape ILIKE wildcards so search text is matched literally.
function pattern(query: string) {
  return `%${query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

/**
 * Current Luma orders whose source order the customer's connection attributes to this imported
 * customer. Linked orders appear once, under their current canonical ID.
 */
async function customerOrderIds(
  tx: SqlTransaction,
  tenantId: string,
  customerId: string,
) {
  const result = await tx.query<{ id: string }>(
    `SELECT DISTINCT m.canonical_id AS id FROM customer_profiles p
     JOIN customer_orders c ON c.tenant_id=p.tenant_id AND c.connection_id=p.connection_id
      AND c.customer_external_id=p.external_id
     JOIN connector_source_mappings m ON m.tenant_id=c.tenant_id AND m.connection_id=c.connection_id
      AND m.resource='order' AND m.scope_key=c.order_scope_key AND m.external_id=c.order_external_id
     WHERE p.tenant_id=$1 AND p.id=$2`,
    [tenantId, customerId],
  );

  return result.rows.map((row) => row.id);
}

/**
 * Reads one page of current orders and, when requested, the exact match count. Throws a 400 error when the
 * cursor was issued for other filters or sorting.
 */
export async function listOrders(
  tx: SqlTransaction,
  queries: OrderReadQueries,
  context: TenantContext,
  query: OrderListQuery,
  asOf: string,
): Promise<OrderList> {
  const scope = cursorContext(context.tenantId, query);
  const after = query.cursor ? readCursor(query.cursor, scope) : null;
  const search = query.q !== '';
  const rebuilding = await tx.query(
    'SELECT 1 FROM orders_list_backfill WHERE tenant_id=$1',
    [context.tenantId],
  );
  const values: unknown[] = [
    context.tenantId,
    asOf,
    query.connectionId ?? null,
    query.status ?? null,
    query.paymentStatus ?? null,
    query.placedFrom ?? null,
    query.placedBefore ?? null,
    query.updatedFrom ?? null,
    query.updatedBefore ?? null,
    query.limit + 1,
    after?.rank ?? null,
    after?.key ?? null,
    after?.id ?? null,
  ];
  let searchPlan: false | 'selective' | 'broad' = false;
  if (search && !rebuilding.rowCount) {
    // Use compact parameter numbers in this independent lookup; unused parameters have no SQL type.
    const hitsSql = orderSearchHits
      .replaceAll('$14', '$4')
      .replaceAll('$15', '$5');
    const hits = await tx.query<{ id: string }>(
      `WITH ${hitsSql} SELECT id FROM hits WHERE $2::timestamptz IS NOT NULL`,
      [
        context.tenantId,
        asOf,
        query.connectionId ?? null,
        query.q,
        pattern(query.q),
      ],
    );
    searchPlan = hits.rows.length > 1000 ? 'broad' : 'selective';
    if (searchPlan === 'selective')
      values.push([...new Set(hits.rows.map(({ id }) => id))]);
    else values.push(query.q, pattern(query.q));
  } else if (search) values.push(query.q, pattern(query.q));
  let customer: number | undefined;
  if (query.customerId) {
    values.push(await customerOrderIds(tx, context.tenantId, query.customerId));
    customer = values.length;
  }
  const sql = rebuilding.rowCount
    ? legacyListSql(
        queries,
        query.view,
        query.sort,
        query.direction,
        search,
        query.count === 'exact',
        customer,
      )
    : listSql(
        queries,
        query.view,
        query.sort,
        query.direction,
        searchPlan,
        !!query.connectionId,
        query.count === 'exact',
        customer,
      );
  const result = await tx.query<{
    totalCount: number | null;
    items: ListRow[];
  }>(sql, values);
  const { totalCount, items } = result.rows[0]!;
  const rows = items.slice(0, query.limit);
  const last = rows.at(-1);

  return {
    items: rows.map((row) => ({
      id: row.id,
      displayNumber: row.displayNumber,
      placedAt: iso(row.placedAt),
      total: money(row.total),
      status: row.status,
      paymentStatus: row.paymentStatus,
      fulfillment: row.fulfillment,
      lineCount: row.lineCount,
      open: row.open,
      overdue: row.overdue,
      dueAt: iso(row.dueAt),
      issueIds: row.issueIds,
      differs: row.differs,
      sources: row.sources.map(source),
      observedAt: iso(row.observedAt)!,
      sourceUpdatedAt: iso(row.sourceUpdatedAt),
    })),
    totalCount,
    nextCursor:
      items.length > query.limit && last
        ? writeCursor(scope, {
            rank: last.sortRank,
            key: last.sortKey,
            id: last.id,
          })
        : null,
    asOf,
  };
}

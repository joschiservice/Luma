import type { TenantContext } from '@luma/identity';
import type { SqlTransaction } from '@luma/platform';

import type {
  OrderList,
  OrderListItem,
  OrderListQuery,
} from '../../application/orders.js';
import { cursorContext, readCursor, writeCursor } from './cursor.js';
import type { OrderReadQueries } from './list-query.js';
import { listSql } from './list-query.js';
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
 * Reads one page of current orders and the total match count. Throws a 400 error when the
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
  const result = await tx.query<{ totalCount: number; items: ListRow[] }>(
    listSql(queries, query.view, query.sort, query.direction, search),
    [
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
      ...(search ? [query.q, pattern(query.q)] : []),
    ],
  );
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

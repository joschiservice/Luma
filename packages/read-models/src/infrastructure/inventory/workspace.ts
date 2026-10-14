import { requirePermission } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import { hiddenSections } from '../../application/access.js';
import type { CollectionGroupKey } from '../../application/collections.js';
import type {
  InventoryDetailSection,
  InventoryQuery,
  InventoryWorkspace,
} from '../../application/inventory.js';
import { collectionCursorContext } from '../collection/cursor.js';
import { collectionScope } from '../collection/request.js';
import { rankedGroupResults } from '../list-groups.js';
import { readListCursor, writeListCursor } from '../list-paging.js';
import { readPositionPage, readPositions } from './positions.js';
import { readStockContext } from './related.js';
import { createTransferWorkspace } from './transfers.js';

/**
 * Binds inventory cursors to the tenant and every filter, condition, grouping and sort of the
 * query, ignoring page sizes. Inside a group (`key`, or the query's `groupKey`) the scope also
 * binds the group key, so a grouped read's group cursors continue that group's pages.
 */
function inventoryScope(
  tenantId: string,
  query: InventoryQuery,
  key?: CollectionGroupKey,
) {
  return collectionCursorContext(
    'inventory-v3',
    tenantId,
    collectionScope(
      {
        ...query,
        sort: query.sort ?? 'sku',
        direction: query.direction ?? 'asc',
        limit: undefined,
        groupLimit: undefined,
      },
      key !== undefined ? key : query.groupKey,
    ),
  );
}

/** Creates tenant-scoped inventory reads in a consistent database snapshot. */
export function createInventoryWorkspace(
  db: TenantDatabase,
): InventoryWorkspace {
  return {
    ...createTransferWorkspace(db),
    async list(context, query) {
      requirePermission(context, 'inventory.read');
      const scope = inventoryScope(context.tenantId, query);
      const after = query.cursor
        ? readListCursor(query.cursor, scope, 'inventory')
        : null;
      const limit = query.limit ?? 50;
      const asOf = new Date().toISOString();

      return db.transaction(
        context.tenantId,
        async (tx) => {
          // Ordering every position is cheaper than compiling the plan.
          await tx.query('SET LOCAL jit = off');
          const page = await readPositionPage(
            tx,
            context.tenantId,
            query,
            after,
            null,
            { userId: context.actor.id, asOf },
          );
          if (page.groups) {
            const grouping = rankedGroupResults(page.groups, (key, last) =>
              writeListCursor(
                inventoryScope(context.tenantId, query, key),
                last,
              ),
            );

            return {
              items: page.rows.map((row) => row.item),
              totalCount: page.totalCount,
              nextCursor: null,
              groups: grouping.groups,
              groupsTruncated: grouping.truncated,
              asOf,
            };
          }
          const rows = page.rows.slice(0, limit);
          const last = page.rows[limit - 1];
          const nextCursor =
            page.rows.length > limit && last
              ? writeListCursor(scope, last.position)
              : null;

          return {
            items: rows.map((row) => row.item),
            totalCount: page.totalCount,
            nextCursor,
            ...(query.groupKey !== undefined
              ? {
                  groups: [
                    {
                      key: query.groupKey,
                      count: page.totalCount ?? 0,
                      complete: true,
                      itemIds: rows.map((row) => row.item.id),
                      nextCursor,
                      sums: [],
                    },
                  ],
                }
              : {}),
            asOf,
          };
        },
        { readOnlySnapshot: true },
      );
    },
    async get(context, positionId) {
      requirePermission(context, 'inventory.read');
      const hidden = hiddenSections<InventoryDetailSection>(context, [
        ['orders', 'orders.read'],
        ['purchaseOrders', 'procurement.read'],
        ['issues', 'issues.read'],
      ]);

      return db.transaction(
        context.tenantId,
        async (tx) => {
          const [position] = await readPositions(
            tx,
            context.tenantId,
            { q: '', view: 'all' },
            null,
            positionId,
          );
          if (!position) return null;

          const related = await readStockContext(
            tx,
            context.tenantId,
            position,
          );

          return {
            position,
            ...related,
            orders: hidden.includes('orders') ? [] : related.orders,
            purchaseOrders: hidden.includes('purchaseOrders')
              ? []
              : related.purchaseOrders,
            issues: hidden.includes('issues') ? [] : related.issues,
            hidden,
            asOf: new Date().toISOString(),
          };
        },
        { readOnlySnapshot: true },
      );
    },
  };
}

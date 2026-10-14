import { requirePermission } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import { hiddenSections } from '../../application/access.js';
import type { CollectionGroupKey } from '../../application/collections.js';
import type {
  ProductDetailSection,
  ProductQuery,
  ProductWorkspace,
} from '../../application/products.js';
import { collectionCursorContext } from '../collection/cursor.js';
import { collectionScope } from '../collection/request.js';
import { rankedGroupResults } from '../list-groups.js';
import { readListCursor, writeListCursor } from '../list-paging.js';
import { readCatalog, readSku, readSources } from './catalog.js';
import { readProductContext } from './detail.js';

/**
 * Binds product cursors to the tenant and every filter, condition, grouping and sort of the
 * query, ignoring page sizes. Inside a group (`key`, or the query's `groupKey`) the scope
 * also binds the group key, so a grouped read's group cursors continue that group's pages.
 */
function productScope(
  tenantId: string,
  query: ProductQuery,
  key?: CollectionGroupKey,
) {
  return collectionCursorContext(
    'products-v3',
    tenantId,
    collectionScope(
      {
        ...query,
        sort: query.sort ?? 'rank',
        direction: query.direction ?? 'asc',
        limit: undefined,
        groupLimit: undefined,
      },
      key !== undefined ? key : query.groupKey,
    ),
  );
}

/** Creates tenant-scoped product catalog reads in a consistent database snapshot. */
export function createProductWorkspace(db: TenantDatabase): ProductWorkspace {
  return {
    async list(context, query) {
      requirePermission(context, 'products.read');
      const scope = productScope(context.tenantId, query);
      const after = query.cursor
        ? readListCursor(query.cursor, scope, 'product')
        : null;
      const asOf = new Date().toISOString();

      return db.transaction(
        context.tenantId,
        async (tx) => {
          const limit = query.limit ?? 50;
          // Comparing a whole catalog aggregates every listing; keep it in memory. JIT
          // compilation of this plan costs more than the comparison itself.
          await tx.query("SET LOCAL work_mem='32MB'");
          await tx.query('SET LOCAL jit = off');
          const catalog = await readCatalog(
            tx,
            context.tenantId,
            query,
            after,
            null,
            { tenant: context, asOf },
          );
          if (catalog.groups) {
            const grouping = rankedGroupResults(catalog.groups, (key, last) =>
              writeListCursor(productScope(context.tenantId, query, key), last),
            );

            return {
              items: catalog.items.map((entry) => entry.item),
              sources: await readSources(tx, context.tenantId),
              counts: catalog.counts,
              nextCursor: null,
              groups: grouping.groups,
              groupsTruncated: grouping.truncated,
              asOf,
            };
          }
          const page = catalog.items.slice(0, limit);
          const last = catalog.items[limit - 1];
          const nextCursor =
            catalog.items.length > limit && last
              ? writeListCursor(scope, last.position)
              : null;

          return {
            items: page.map((entry) => entry.item),
            sources: await readSources(tx, context.tenantId),
            counts: catalog.counts,
            nextCursor,
            ...(query.groupKey !== undefined
              ? {
                  groups: [
                    {
                      key: query.groupKey,
                      count: catalog.matchedCount ?? 0,
                      complete: true,
                      itemIds: page.map((entry) => entry.item.skuId),
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
    async get(context, skuId) {
      requirePermission(context, 'products.read');
      const hidden = hiddenSections<ProductDetailSection>(context, [
        ['stock', 'inventory.read'],
        ['sales', 'orders.read'],
        ['orders', 'orders.read'],
        ['purchaseOrders', 'procurement.read'],
        ['issues', 'issues.read'],
      ]);
      const shown = (section: ProductDetailSection) =>
        !hidden.includes(section);

      return db.transaction(
        context.tenantId,
        async (tx) => {
          const sku = await readSku(tx, context.tenantId, skuId);
          if (!sku) return null;
          const sources = await readSources(tx, context.tenantId);
          const catalog = await readCatalog(
            tx,
            context.tenantId,
            { q: '', view: 'all' },
            null,
            skuId,
          );
          // A SKU known only from stock or order lines has no listing in any catalog.
          const item = catalog.items[0]?.item ?? {
            skuId,
            sku: sku.sku,
            skuKey: sku.skuKey,
            title: null,
            listings: [],
            differences: [],
            gaps: sources.map((source) => ({
              connectionId: source.connectionId,
              match: null,
            })),
          };

          const related = await readProductContext(tx, context.tenantId, item);

          return {
            item,
            sources,
            ...related,
            stock: shown('stock') ? related.stock : [],
            sales: shown('sales')
              ? related.sales
              : { since: related.sales.since, sources: [] },
            orders: shown('orders') ? related.orders : [],
            purchaseOrders: shown('purchaseOrders')
              ? related.purchaseOrders
              : [],
            issues: shown('issues') ? related.issues : [],
            hidden,
            asOf: new Date().toISOString(),
          };
        },
        { readOnlySnapshot: true },
      );
    },
  };
}

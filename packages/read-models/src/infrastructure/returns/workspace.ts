import { hasPermission, requirePermission } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import { hiddenSections } from '../../application/access.js';
import type { CollectionGroupKey } from '../../application/collections.js';
import type { ReturnWorkspace } from '../../application/returns.js';
import {
  collectionCursorContext,
  readCollectionCursor,
  writeCollectionCursor,
} from '../collection/cursor.js';
import { groupResults } from '../collection/group.js';
import { collectionScope, maxCollectionGroups } from '../collection/request.js';
import { readReturnDetail } from './detail.js';
import { readReturns, readReturnSources } from './list.js';

/**
 * Creates tenant-scoped reads of returns and refunds in a consistent database snapshot. List
 * cursors are bound to the tenant, search, filters, conditions, grouping and sort.
 */
export function createReturnWorkspace(db: TenantDatabase): ReturnWorkspace {
  return {
    async list(context, query) {
      requirePermission(context, 'returns.read');
      const scope = (key?: CollectionGroupKey) =>
        collectionCursorContext(
          'returns-v3',
          context.tenantId,
          collectionScope(query, key),
        );
      const after = query.cursor
        ? readCollectionCursor(
            query.cursor,
            scope(query.groupKey),
            'This page link no longer matches the return filters. Start from the first page.',
          )
        : null;
      const asOf = new Date().toISOString();

      return db.transaction(
        context.tenantId,
        async (tx) => {
          const page = await readReturns(
            tx,
            context.tenantId,
            context.actor.id,
            query,
            asOf,
            after,
            hasPermission(context, 'customers.read'),
          );
          const sources = await readReturnSources(tx, context.tenantId);
          // Group counts may miss returns while a source still imports its history.
          const complete = !sources.some((source) => source.importing);
          const grouped =
            query.group !== undefined && query.groupKey === undefined;
          const rows = grouped ? page.rows : page.rows.slice(0, query.limit);
          const last = rows.at(-1);
          const nextCursor =
            !grouped && page.rows.length > query.limit && last
              ? writeCollectionCursor(scope(query.groupKey), last.position)
              : null;
          const grouping =
            grouped && page.groups
              ? groupResults(
                  page.groups,
                  maxCollectionGroups,
                  complete,
                  (key, position) =>
                    writeCollectionCursor(scope(key), position),
                )
              : undefined;

          return {
            items: rows.map((row) => row.item),
            sources,
            counts: page.counts,
            nextCursor,
            ...(grouping
              ? { groups: grouping.groups, groupsTruncated: grouping.truncated }
              : query.groupKey !== undefined
                ? {
                    groups: [
                      {
                        key: query.groupKey,
                        count: page.total ?? 0,
                        complete,
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
    async get(context, id) {
      requirePermission(context, 'returns.read');
      const hidden = hiddenSections<'order'>(context, [
        ['order', 'orders.read'],
      ]);

      return db.transaction(
        context.tenantId,
        async (tx) => {
          const detail = await readReturnDetail(tx, context.tenantId, id);

          return detail
            ? {
                ...detail,
                order: hidden.length ? null : detail.order,
                hidden,
                asOf: new Date().toISOString(),
              }
            : null;
        },
        { readOnlySnapshot: true },
      );
    },
  };
}

import type { TenantContext } from '@luma/identity';
import {
  IdentityError,
  requirePermission,
  requireTenant,
} from '@luma/identity';
import type { SqlTransaction, TenantDatabase } from '@luma/platform';

import type { CollectionGroupKey } from '../../application/collections.js';
import type { FulfillmentWorkspace } from '../../application/fulfillment.js';
import type { OrderActivityReader } from '../../application/orders.js';
import {
  collectionCursorContext,
  readCollectionCursor,
  writeCollectionCursor,
} from '../collection/cursor.js';
import { groupResults } from '../collection/group.js';
import { collectionScope, maxCollectionGroups } from '../collection/request.js';
import type { OrderReadQueries } from '../orders/list-query.js';
import { readFulfillment } from './detail.js';
import {
  fulfillmentDirection,
  fulfillmentsImporting,
  readFulfillments,
  readLocations,
} from './list.js';
import { readSources, stalledAfterHours } from './rules.js';

const pageError = () =>
  Object.assign(
    new Error(
      'This page link no longer matches the fulfillment filters. Start from the first page.',
    ),
    { statusCode: 400, expose: true },
  );

/**
 * Reads the Fulfillment workspace in one repeatable-read snapshot. Pages keep the evaluation
 * time of their first page, so time-based views do not shift while paging. Cursors are bound
 * to the tenant, search, filters, conditions, grouping and sort; any other query gets 400.
 */
export function createFulfillmentWorkspace(
  db: TenantDatabase,
  queries: OrderReadQueries,
  activity: (db: TenantDatabase) => OrderActivityReader,
  refreshContext: (context: TenantContext) => Promise<TenantContext>,
  now = () => new Date(),
): FulfillmentWorkspace {
  async function read<T>(
    context: TenantContext,
    operation: (
      tx: SqlTransaction,
      scoped: TenantDatabase,
      fresh: TenantContext,
    ) => Promise<T>,
  ) {
    const fresh = await refreshContext(context);
    requireTenant(fresh, context.tenantId);
    if (fresh.actor.id !== context.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Actor changed');
    requirePermission(fresh, 'fulfillment.read');

    return db.transaction(
      fresh.tenantId,
      async (tx) => {
        await tx.query("SET LOCAL statement_timeout = '4000ms'");
        await tx.query('SET LOCAL jit = off');
        const scoped: TenantDatabase = {
          transaction: async (tenantId, next) => {
            requireTenant(fresh, tenantId);

            return next(tx);
          },
        };

        return operation(tx, scoped, fresh);
      },
      { readOnlySnapshot: true },
    );
  }

  return {
    async list(context, query) {
      const direction = fulfillmentDirection(query);
      const scope = (key?: CollectionGroupKey) =>
        collectionCursorContext(
          'fulfillment-v3',
          context.tenantId,
          collectionScope(
            { ...query, direction, limit: query.limit ?? 50 },
            key,
          ),
        );
      const cursor = query.cursor
        ? readCollectionCursor(
            query.cursor,
            scope(query.groupKey),
            pageError().message,
          )
        : null;
      // Pages keep the evaluation time of their first page.
      if (cursor && !cursor.asOf) throw pageError();
      const asOf = cursor?.asOf ?? now().toISOString();

      return read(context, async (tx, _scoped, fresh) => {
        const limit = query.limit ?? 50;
        const page = await readFulfillments(
          tx,
          fresh.tenantId,
          fresh.actor.id,
          query,
          asOf,
          cursor,
        );
        const complete = query.group
          ? !(await fulfillmentsImporting(tx, fresh.tenantId))
          : true;
        const grouped =
          query.group !== undefined && query.groupKey === undefined;
        const rows = grouped ? page.items : page.items.slice(0, limit);
        const last = page.items[limit - 1];
        const nextCursor =
          !grouped && page.items.length > limit && last
            ? writeCollectionCursor(scope(query.groupKey), last.position, asOf)
            : null;
        const grouping =
          grouped && page.groups
            ? groupResults(
                page.groups,
                maxCollectionGroups,
                complete,
                (key, position) =>
                  writeCollectionCursor(scope(key), position, asOf),
              )
            : undefined;

        return {
          items: rows.map((entry) => entry.item),
          sources: await readSources(tx, fresh.tenantId),
          locations: await readLocations(tx, fresh.tenantId),
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
                      itemIds: rows.map((entry) => entry.item.id),
                      nextCursor,
                      sums: [],
                    },
                  ],
                }
              : {}),
          stalledAfterHours,
          asOf,
        };
      });
    },
    get: (context, fulfillmentId) =>
      read(context, (tx, scoped, fresh) =>
        readFulfillment(
          tx,
          queries,
          activity(scoped),
          fresh,
          fulfillmentId,
          now().toISOString(),
        ),
      ),
  };
}

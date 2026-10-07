import { createHash } from 'node:crypto';

import type { TenantContext } from '@luma/identity';
import {
  IdentityError,
  requirePermission,
  requireTenant,
} from '@luma/identity';
import type { SqlTransaction, TenantDatabase } from '@luma/platform';
import { z } from 'zod';

import type { FulfillmentWorkspace } from '../../application/fulfillment.js';
import type { OrderActivityReader } from '../../application/orders.js';
import type { OrderReadQueries } from '../orders/list-query.js';
import { readFulfillment } from './detail.js';
import {
  type FulfillmentPosition,
  readFulfillments,
  readLocations,
} from './list.js';
import { readSources, stalledAfterHours } from './rules.js';

const cursorSchema = z
  .object({
    context: z.string(),
    asOf: z.string().datetime(),
    rank: z.number().int().min(0).max(1),
    key: z.string().datetime(),
    entityId: z.string().uuid(),
    connectionId: z.string().uuid(),
  })
  .strict();

const pageError = () =>
  Object.assign(
    new Error(
      'This page link no longer matches the fulfillment filters. Start from the first page.',
    ),
    { statusCode: 400, expose: true },
  );

/**
 * Reads the Fulfillment workspace in one repeatable-read snapshot. Pages keep the evaluation
 * time of their first page, so time-based views do not shift while paging.
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
      const scope = createHash('sha256')
        .update(
          JSON.stringify([
            'fulfillment-v1',
            context.tenantId,
            query.q,
            query.view,
            query.connectionId ?? null,
            query.locationId ?? null,
            query.kind ?? null,
            query.sort,
          ]),
        )
        .digest('hex');
      let after: FulfillmentPosition | null = null;
      let asOf = now().toISOString();
      if (query.cursor) {
        try {
          const bytes = Buffer.from(query.cursor, 'base64url');
          if (bytes.toString('base64url') !== query.cursor)
            throw new Error('Encoding');
          const cursor = cursorSchema.parse(JSON.parse(bytes.toString()));
          if (cursor.context !== scope) throw new Error('Context');
          asOf = cursor.asOf;
          after = {
            rank: cursor.rank,
            key: cursor.key,
            entityId: cursor.entityId,
            connectionId: cursor.connectionId,
          };
        } catch {
          throw pageError();
        }
      }

      return read(context, async (tx, _scoped, fresh) => {
        const limit = query.limit ?? 50;
        const page = await readFulfillments(
          tx,
          fresh.tenantId,
          query,
          asOf,
          after,
        );
        const last = page.items[limit - 1];

        return {
          items: page.items.slice(0, limit).map((entry) => entry.item),
          sources: await readSources(tx, fresh.tenantId),
          locations: await readLocations(tx, fresh.tenantId),
          counts: page.counts,
          nextCursor:
            page.items.length > limit && last
              ? Buffer.from(
                  JSON.stringify({ context: scope, asOf, ...last.position }),
                ).toString('base64url')
              : null,
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

import type { TenantContext } from '@luma/identity';
import { IdentityError, requireTenant } from '@luma/identity';
import type { SqlTransaction, TenantDatabase } from '@luma/platform';

import type {
  OrderActivityReader,
  OrderWorkspace,
} from '../../application/orders.js';
import { readDetail } from './detail.js';
import { listOrders } from './list.js';
import type { OrderReadQueries } from './list-query.js';

/**
 * Reads the Orders workspace from canonical projections in one repeatable-read snapshot.
 * Order state and needs-you come from the owners' SQL in `queries`, so the list, the detail
 * and the order metrics classify an order the same way.
 */
export function createOrderWorkspace(
  db: TenantDatabase,
  queries: OrderReadQueries,
  activity: (db: TenantDatabase) => OrderActivityReader,
  refreshContext: (context: TenantContext) => Promise<TenantContext>,
  now = () => new Date(),
): OrderWorkspace {
  async function read<T>(
    context: TenantContext,
    operation: (
      tx: SqlTransaction,
      scoped: TenantDatabase,
      fresh: TenantContext,
      asOf: string,
    ) => Promise<T>,
  ) {
    const fresh = await refreshContext(context);
    requireTenant(fresh, context.tenantId);
    if (fresh.actor.id !== context.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Actor changed');
    const asOf = now().toISOString();

    return db.transaction(
      fresh.tenantId,
      async (tx) => {
        await tx.query("SET LOCAL statement_timeout = '4000ms'");
        // JIT compilation of these large plans costs more than it saves on interactive reads.
        await tx.query('SET LOCAL jit = off');
        const scoped: TenantDatabase = {
          transaction: async (tenantId, next) => {
            requireTenant(fresh, tenantId);

            return next(tx);
          },
        };

        return operation(tx, scoped, fresh, asOf);
      },
      { readOnlySnapshot: true },
    );
  }

  return {
    list: (context, query) =>
      read(context, (tx, _scoped, fresh, asOf) =>
        listOrders(tx, queries, fresh, query, asOf),
      ),
    get: (context, orderId) =>
      read(context, (tx, scoped, fresh, asOf) =>
        readDetail(tx, queries, activity(scoped), fresh, orderId, asOf),
      ),
  };
}

import type { AuthorityReader } from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import {
  hasPermission,
  IdentityError,
  requirePermission,
  requireTenant,
} from '@luma/identity';
import type { SqlTransaction, TenantDatabase } from '@luma/platform';

import type {
  OrderActivityReader,
  OrderWorkspace,
} from '../../application/orders.js';
import { type ActionPermission, readChangePlan } from './change-plan.js';
import { readDetail } from './detail.js';
import { listOrders } from './list.js';
import type { OrderReadQueries } from './list-query.js';

/**
 * Reads the Orders workspace from canonical projections in one repeatable-read snapshot.
 * Order state and needs-you come from the owners' SQL in `queries`, so the list, the detail
 * and the order metrics classify an order the same way. `actionPermission` names the app
 * permission that lets a person request a provider write, for change plans.
 */
export function createOrderWorkspace(
  db: TenantDatabase,
  queries: OrderReadQueries,
  activity: (db: TenantDatabase) => OrderActivityReader,
  refreshContext: (context: TenantContext) => Promise<TenantContext>,
  authority: (db: TenantDatabase) => AuthorityReader,
  now = () => new Date(),
  excludedSources: (
    context: TenantContext,
  ) => Promise<string[]> = async () => [],
  actionPermission: ActionPermission = () => null,
): OrderWorkspace {
  async function read<T>(
    context: TenantContext,
    operation: (
      tx: SqlTransaction,
      scoped: TenantDatabase,
      fresh: TenantContext,
      asOf: string,
      hidden: string[],
    ) => Promise<T>,
  ) {
    const fresh = await refreshContext(context);
    requireTenant(fresh, context.tenantId);
    if (fresh.actor.id !== context.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Actor changed');
    requirePermission(fresh, 'orders.read');
    const asOf = now().toISOString();
    const hidden = await excludedSources(fresh);

    return db.transaction(
      fresh.tenantId,
      async (tx) => {
        await tx.query(
          "SELECT set_config('app.hidden_order_sources',$1,true)",
          [`{${hidden.join(',')}}`],
        );
        await tx.query("SET LOCAL statement_timeout = '4000ms'");
        // JIT compilation of these large plans costs more than it saves on interactive reads.
        await tx.query('SET LOCAL jit = off');
        const scoped: TenantDatabase = {
          transaction: async (tenantId, next) => {
            requireTenant(fresh, tenantId);

            return next(tx);
          },
        };

        return operation(tx, scoped, fresh, asOf, hidden);
      },
      { readOnlySnapshot: true },
    );
  }

  return {
    list: (context, query) =>
      read(context, async (tx, _scoped, fresh, asOf, hidden) => {
        if (query.view === 'stuck') {
          requirePermission(fresh, 'inventory.read');
          requirePermission(fresh, 'fulfillment.read');
        }
        if (query.locationId || query.stockBlocked)
          requirePermission(fresh, 'fulfillment.read');
        if (query.stockBlocked) requirePermission(fresh, 'inventory.read');
        if (query.customerId) requirePermission(fresh, 'customers.read');
        const list = await listOrders(
          tx,
          queries,
          fresh,
          query,
          asOf,
          hidden.length > 0,
        );

        // The needs-you view still selects by issue, but readers without issue access get no links.
        return hasPermission(fresh, 'issues.read')
          ? list
          : {
              ...list,
              items: list.items.map((item) => ({ ...item, issueIds: [] })),
            };
      }),
    get: (context, orderId) =>
      read(context, (tx, scoped, fresh, asOf) =>
        readDetail(
          tx,
          queries,
          activity(scoped),
          authority(scoped),
          fresh,
          orderId,
          asOf,
        ),
      ),
    changePlan: (context, orderId, request) =>
      read(context, (tx, scoped, fresh, asOf) =>
        readChangePlan(
          tx,
          queries,
          authority(scoped),
          actionPermission,
          fresh,
          orderId,
          request,
          asOf,
        ),
      ),
  };
}

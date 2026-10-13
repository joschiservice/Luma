import { randomUUID } from 'node:crypto';

import { createAuditLog } from '@luma/audit/composition';
import type { AuthorityReader } from '@luma/connections';
import {
  commerceSchema,
  createInternalOrderSource,
} from '@luma/connections/composition';
import type { IdentityService, TenantContext } from '@luma/identity';
import { requireTenant } from '@luma/identity';
import type { Observability, TenantDatabase } from '@luma/platform';
import type { SalesService } from '@luma/sales';
import {
  createSalesPersistence,
  createSalesService,
  createSalesSource,
} from '@luma/sales/composition';

import { createNativeStockRuntime } from './native-stock.js';
import { createCommerceServices } from './services.js';

/** Composes record persistence and evidence publication on one tenant transaction. */
export function createSalesRuntime(
  db: TenantDatabase,
  identity: Pick<IdentityService, 'refreshContext' | 'resolveWorkflowContext'>,
  enabled: (context: TenantContext) => Promise<boolean>,
  authority: (db: TenantDatabase) => AuthorityReader,
): SalesService {
  return createSalesService({
    refreshContext: identity.refreshContext,
    enabled,
    atomic: (context, operation, orderId) =>
      db.transaction(context.tenantId, async (tx) => {
        if (orderId)
          await tx.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
            [`native-stock-order:${context.tenantId}:${orderId}`],
          );
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `sales:${context.tenantId}`,
        ]);
        await tx.query(
          'SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',
          [`commerce-ingestion:${context.tenantId}`],
        );
        const scoped: TenantDatabase = {
          transaction: async (tenantId, work) => {
            requireTenant(context, tenantId);

            return work(tx);
          },
        };
        const commerce = createCommerceServices(scoped);

        return operation(
          createSalesPersistence(tx, context, {
            sources: commerce.sources,
            orders: commerce.orders,
            source: createInternalOrderSource(scoped),
            authority: authority(scoped),
            audit: createAuditLog(scoped),
            reconcileStock: async (previous, next, commandId) => {
              if (
                previous.status === next.status &&
                JSON.stringify(
                  previous.lines.map((line) => line.currentQuantity),
                ) ===
                  JSON.stringify(next.lines.map((line) => line.currentQuantity))
              )
                return;
              await createNativeStockRuntime(
                scoped,
                identity,
                enabled,
                authority,
              ).reservations.reconcileDemand(context, {
                commandId,
                orderId: next.orderId,
                status: next.status,
                lines: next.lines.map((line) => ({
                  id: line.id,
                  currentQuantity: line.currentQuantity,
                })),
              });
            },
          }),
        );
      }),
  });
}

/** Evaluates the workspace release in application code; workflow replay receives only its result. */
function createSalesRelease(observability?: Observability) {
  return async (context: TenantContext) => {
    if (!observability) return false;
    const observation = observability.request(context.requestId);
    try {
      return await observability.flag(
        observability.forTenant(
          observation.context,
          context.tenantId,
          context.dataRegion,
        ),
        'luma-erp-orders',
        false,
      );
    } finally {
      observation.end();
    }
  };
}

/** Composes the credential-free internal source with normal observation boundary validation. */
export function createSalesReadSource(
  db: TenantDatabase,
  observability?: Observability,
) {
  return createSalesSource(db, createSalesRelease(observability), (value) => {
    const parsed = commerceSchema.parse({
      capability: 'orders.read',
      observation: value,
    });
    if (parsed.capability !== 'orders.read')
      throw new Error('Expected an order observation');
    // Validation rejects malformed observations; the source owns the typed construction.
  });
}

/** Evaluates a release for a trusted tenant selected by an application service. */
export function createSalesTenantRelease(observability?: Observability) {
  return async (tenantId: string) => {
    if (!observability) return false;
    const observation = observability.request(randomUUID());
    try {
      return await observability.flag(
        observability.forTenant(observation.context, tenantId, 'EU'),
        'luma-erp-orders',
        false,
      );
    } finally {
      observation.end();
    }
  };
}

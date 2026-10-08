import type { TenantContext } from '@luma/identity';
import { requireTenant } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import {
  classifyStockPositions,
  summarizePurchaseOrderMetrics,
  summarizeStockMetrics,
} from '../domain/metrics.js';
import type { PurchaseOrder } from '../domain/procurement.js';
import { createReplenishmentStore } from './replenishment-store.js';

async function readOrders(
  db: TenantDatabase,
  context: TenantContext,
  scope: { supplierId?: string | undefined; authority?: string | undefined },
) {
  return db.transaction(context.tenantId, async (tx) =>
    (
      await tx.query<{ document: PurchaseOrder }>(
        `SELECT document FROM procurement_purchase_orders WHERE tenant_id=$1
       AND ($2::uuid IS NULL OR supplier_id=$2) AND ($3::text IS NULL OR document->>'authority'=$3)
       ORDER BY created_at,id`,
        [context.tenantId, scope.supplierId ?? null, scope.authority ?? null],
      )
    ).rows.map((row) => row.document),
  );
}

async function readStock(
  db: TenantDatabase,
  context: TenantContext,
  connectionId: string | undefined,
) {
  const store = createReplenishmentStore(db);
  const rules = (await store.list(context)).filter(
    (rule) =>
      rule.active && (!connectionId || rule.connectionId === connectionId),
  );

  return { rules, stocks: await store.stocksFor(context, rules) };
}

/** Reads selected procurement families inside the caller's authorized snapshot. */
export function createProcurementMetricReader(db: TenantDatabase) {
  return async (
    context: TenantContext,
    asOf: string,
    family: 'inventory' | 'procurement',
    scope: {
      connectionId?: string | undefined;
      supplierId?: string | undefined;
      authority?: 'luma' | 'external' | undefined;
    },
  ) => {
    requireTenant(context, context.tenantId);
    const orders = await readOrders(db, context, scope);
    if (family === 'procurement')
      return summarizePurchaseOrderMetrics(orders, asOf);
    const { rules, stocks } = await readStock(db, context, scope.connectionId);

    return summarizeStockMetrics(rules, stocks, orders, asOf);
  };
}

/**
 * Classifies every position under an active replenishment rule at `asOf`, optionally for one
 * inventory connection, inside the caller's authorized snapshot. Unusable stock has an
 * `unknownReason` and is never below or above minimum. Purchase orders are draft or open orders
 * for the same SKU; they do not establish sufficient incoming stock.
 */
export function createStockRiskReader(db: TenantDatabase) {
  return async (
    context: TenantContext,
    asOf: string,
    connectionId: string | undefined,
  ) => {
    requireTenant(context, context.tenantId);
    const orders = await readOrders(db, context, {});
    const { rules, stocks } = await readStock(db, context, connectionId);

    return classifyStockPositions(rules, stocks, orders, asOf).classified.map(
      ({ item, below }) => ({
        id: item.id,
        ruleId: item.ruleId,
        connectionId: item.connectionId,
        sku: item.sku,
        minimum: item.minimum,
        available: item.available,
        unit: item.unit,
        observedAt: item.observedAt,
        unknownReason: item.reason,
        belowMinimum: below,
        purchaseOrderIds: item.commitmentIds,
      }),
    );
  };
}

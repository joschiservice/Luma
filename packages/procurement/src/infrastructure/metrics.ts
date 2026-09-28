import type { TenantContext } from '@luma/identity';
import { requireTenant } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import {
  summarizePurchaseOrderMetrics,
  summarizeStockMetrics,
} from '../domain/metrics.js';
import type { PurchaseOrder } from '../domain/procurement.js';
import { createReplenishmentStore } from './replenishment-store.js';

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
    const orders = await db.transaction(context.tenantId, async (tx) =>
      (
        await tx.query<{ document: PurchaseOrder }>(
          `SELECT document FROM procurement_purchase_orders WHERE tenant_id=$1
       AND ($2::uuid IS NULL OR supplier_id=$2) AND ($3::text IS NULL OR document->>'authority'=$3)
       ORDER BY created_at,id`,
          [context.tenantId, scope.supplierId ?? null, scope.authority ?? null],
        )
      ).rows.map((row) => row.document),
    );
    if (family === 'procurement')
      return summarizePurchaseOrderMetrics(orders, asOf);
    const store = createReplenishmentStore(db);
    const rules = (await store.list(context)).filter(
      (rule) => !scope.connectionId || rule.connectionId === scope.connectionId,
    );
    const stocks = await store.stocks(context);

    return summarizeStockMetrics(rules, stocks, orders, asOf);
  };
}

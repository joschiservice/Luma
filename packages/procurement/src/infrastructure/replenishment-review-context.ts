import type { TenantContext } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import type { ProcurementService } from '../application/procurement.js';
import type { ReplenishmentActivation } from '../application/replenishment.js';
import type { SupplierTermsService } from '../application/supplier-terms.js';
import { replenishmentReviewContext } from '../domain/replenishment-review-context.js';
import type { createPurchasingInputs } from './purchasing-inputs.js';

/** Reads exact tenant product and purchasing evidence for one proposal; never calls providers. */
export function createReplenishmentReviewContext(deps: {
  database: TenantDatabase;
  terms: Pick<SupplierTermsService, 'list'>;
  inputs: ReturnType<typeof createPurchasingInputs>;
  procurement: Pick<ProcurementService, 'orders'>;
}) {
  return async (
    context: TenantContext,
    rule: ReplenishmentActivation,
    quantity: number,
    available: number | null,
  ) => {
    const product = await deps.database.transaction(
      context.tenantId,
      async (tx) =>
        (
          await tx.query<{
            skuId: string;
            locationId: string;
            title: string | null;
          }>(
            `SELECT s.sku_id AS "skuId",s.document->'data'->>'locationId' AS "locationId",
       (SELECT concat_ws(' · ', k.product_title, nullif(k.variant_title, 'Default Title'))
         FROM inventory_product_skus k WHERE k.tenant_id=s.tenant_id AND k.sku_id=s.sku_id AND k.product_title IS NOT NULL
         ORDER BY (k.connection_id=$3) DESC, k.connection_id, k.product_id LIMIT 1) AS title
       FROM inventory_projections i JOIN inventory_snapshots s ON s.tenant_id=i.tenant_id AND s.id=i.snapshot_id
       WHERE i.tenant_id=$1 AND i.entity_id=$2 AND i.connection_id=$3 AND s.kind='position'`,
            [context.tenantId, rule.positionId, rule.connectionId],
          )
        ).rows[0],
    );
    const [terms, facts, orders] = await Promise.all([
      product
        ? deps.terms.list(context, {
            supplierId: rule.supplierId,
            skuId: product.skuId,
          })
        : Promise.resolve({ items: [] }),
      product
        ? deps.inputs(context, [product.skuId], {
            demandPeriodDays: 30,
            safetyDays: 0,
            locationIds: [product.locationId],
            revision: 0,
          })
        : Promise.resolve(null),
      deps.procurement.orders(context),
    ]);
    const aliases = new Set([rule.sku, product?.skuId].filter(Boolean));
    const openOrders = orders.items
      .filter(
        (order) =>
          ['draft', 'open'].includes(order.status) &&
          order.lines.some((line) => aliases.has(line.sku)),
      )
      .map((order) => ({
        id: order.id,
        reference: order.reference,
        status: order.status,
        quantity: order.lines
          .filter((line) => aliases.has(line.sku))
          .reduce((total, line) => total + line.quantity, 0),
      }));

    return replenishmentReviewContext({
      productTitle: product?.title ?? null,
      terms: terms.items[0] ?? null,
      demand:
        product && !facts?.truncated
          ? (facts?.demand.get(product.skuId) ?? null)
          : null,
      available,
      quantity,
      openOrders,
      now: new Date().toISOString(),
    });
  };
}

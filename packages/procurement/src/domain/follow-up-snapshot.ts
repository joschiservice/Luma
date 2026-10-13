import { canonicalJson } from '@luma/platform';

import type { PurchaseOrder } from './procurement.js';

/** Pins the exact owned revision and scope-relevant values; missing prices and locations stay null. */
export function followUpScopeFingerprint(order: PurchaseOrder): string {
  return canonicalJson({
    revision: order.revision,
    supplierId: order.supplierId,
    authority: order.authority,
    externalReferences: order.externalReferences,
    lines: order.lines.map((line) => ({
      id: line.id,
      sku: line.sku,
      quantity: line.quantity,
      unit: line.unit,
      locationId: line.locationId ?? null,
      unitPrice: line.unitPrice ?? null,
      requestedDeliveryDate: line.requestedDeliveryDate ?? null,
    })),
  });
}

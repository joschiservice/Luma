import type { TenantContext } from '@luma/identity';

import type { StockPosition } from '../domain/inventory.js';

/** Current stock and product identity for one SKU on purchase orders. */
export interface SkuContext {
  /** The text on the order line. */
  sku: string;
  /** The canonical SKU the line resolves to; null when Luma knows no such SKU. */
  skuId: string | null;
  title: string | null;
  /** Stock per location. Sources are never added together. */
  positions: StockPosition[];
  /** Units on other draft or open purchase orders for this SKU, per unit. */
  otherOrders: {
    id: string;
    label: string;
    status: string;
    quantity: number;
    unit: string;
  }[];
}

/** The replenishment decision that created a purchase-order draft, from its run evidence. */
export interface ReplenishmentTrace {
  runId: string;
  definitionId: string;
  startedAt: string;
  positionId: string | null;
  location: string | null;
  minimum: number | null;
  target: number | null;
  stock: {
    available: number | null;
    unit: string | null;
    checkedAt: string | null;
  };
  proposedQuantity: number | null;
  approval: 'approved' | 'rejected' | 'pending' | 'not_required' | 'unknown';
  approvedAt: string | null;
  verification: 'verified' | 'failed' | 'inconclusive' | 'not_verified';
  verifiedAt: string | null;
}

export interface PurchaseOrderContext {
  lines: (SkuContext & { lineId: string })[];
  issues: { id: string; label: string; state: string }[];
  replenishment: ReplenishmentTrace | null;
  truncated: boolean;
  asOf: string;
}

export interface SupplierContext {
  skus: (SkuContext & { onOrder: { quantity: number; unit: string }[] })[];
  issues: { id: string; label: string; state: string }[];
  truncated: boolean;
  asOf: string;
}

/**
 * Reads the stock, products, issues and replenishment evidence around purchase orders. Returns
 * null when the tenant has no such order or supplier.
 */
export interface ProcurementContextReader {
  order(
    context: TenantContext,
    purchaseOrderId: string,
  ): Promise<PurchaseOrderContext | null>;
  supplier(
    context: TenantContext,
    supplierId: string,
  ): Promise<SupplierContext | null>;
}

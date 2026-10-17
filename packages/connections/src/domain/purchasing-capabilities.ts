import type {
  ExternalId,
  Page,
  PageQuery,
  Quantity,
  SupplierOrderSnapshot,
  SupplierSnapshot,
  WriteReceipt,
} from './capabilities.js';
import type { PurchaseOrderRevisionInput } from './purchase-order-revisions.js';

/** Creates one purchase order in the purchasing system for an approved Luma order. */
interface PurchaseOrderSubmission {
  /** The Luma purchase-order ID; the adapter stores it so the order can be found again. */
  lumaOrderId: string;
  /** Buyer reference shown to the supplier. */
  reference: string;
  supplier: ExternalId;
  /** Calendar date (YYYY-MM-DD). */
  requestedDeliveryDate: string;
  lines: { sku: ExternalId; quantity: Quantity }[];
}

/** Suppliers and purchase orders in the merchant's purchasing system. */
export interface PurchasingCapabilities {
  'suppliers.read': {
    input: PageQuery & { supplier?: ExternalId };
    output: Page<SupplierSnapshot>;
  };
  /**
   * Reads purchase orders by source ID, or finds the orders created for a Luma purchase order
   * at or after `createdSince`. Resource `purchase_order`.
   */
  'purchase-orders.read': {
    input: PageQuery & {
      order?: ExternalId;
      created?: { lumaOrderId: string; createdSince: string };
    };
    output: Page<SupplierOrderSnapshot>;
  };
  /** Acceptance means the purchasing system recorded the order, not that a supplier saw it. */
  'purchase-orders.submit': {
    input: PurchaseOrderSubmission;
    output: WriteReceipt;
  };
  'purchase-orders.revise': {
    input: PurchaseOrderRevisionInput;
    output: WriteReceipt;
  };
}

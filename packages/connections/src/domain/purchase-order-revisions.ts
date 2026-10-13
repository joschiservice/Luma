import type { ExternalId, SupplierOrderSnapshot } from './capabilities.js';

/** One supplier-order operation, dispatched once against a frozen source read. */
export interface PurchaseOrderRevisionInput {
  order: ExternalId;
  expected: SupplierOrderSnapshot;
  operation:
    | {
        kind: 'update_line';
        line: ExternalId;
        quantity?: number | undefined;
        requestedDeliveryDate?: string | undefined;
      }
    | {
        kind: 'add_line';
        sku: ExternalId;
        quantity: number;
        requestedDeliveryDate: string;
      }
    | { kind: 'remove_line'; line: ExternalId };
}

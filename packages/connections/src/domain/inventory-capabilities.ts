import type {
  ExternalId,
  InventorySnapshot,
  Page,
  PageQuery,
  Quantity,
  WriteReceipt,
} from './capabilities.js';
import type {
  InventoryShipmentSnapshot,
  InventoryTransferSnapshot,
} from './inventory-transfers.js';

/** Stock reads, transfers and stock corrections. */
export interface InventoryCapabilities {
  /** Places, tightens or releases an incident-owned stock hold through exact CAS. */
  'inventory.available.protect': {
    input: {
      inventoryItemId: string;
      locationId: string;
      expectedRevision: string;
      expectedAvailable: number;
      available: number;
    };
    output: WriteReceipt;
  };
  /** Corrects one approved item/location's available stock using provider CAS and idempotency. */
  'inventory.available.reconcile': {
    input: {
      inventoryItemId: string;
      locationId: string;
      expectedRevision: string;
      expectedAvailable: number;
      available: number;
    };
    output: WriteReceipt;
  };
  'inventory.read': {
    input: PageQuery & {
      sku?: ExternalId;
      location?: ExternalId;
      includeComposition?: boolean;
    };
    output: Page<InventorySnapshot>;
  };
  'inventory.transfers.read': {
    input: PageQuery;
    output: Page<InventoryTransferSnapshot>;
  };
  'inventory.shipments.read': {
    input: PageQuery;
    output: Page<InventoryShipmentSnapshot>;
  };
  'inventory.write': {
    input: {
      sku: ExternalId;
      location: ExternalId;
      available: Quantity;
      expectedRevision: string;
    };
    output: WriteReceipt;
  };
}

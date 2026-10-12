import type { ExternalId } from './capabilities.js';

/** Historical warehouse details; a missing live link never establishes another location by name. */
interface InventoryTransferLocation {
  id: ExternalId | null;
  name: string;
  snapshottedAt: string;
  address: {
    address1: string | null;
    address2: string | null;
    city: string | null;
    provinceCode: string | null;
    countryCode: string | null;
    zip: string | null;
  };
}

/** Transfer requests and their explicit shipment identities, separate from stock-position balances. */
export interface InventoryTransferSnapshot {
  name: string;
  status:
    'draft' | 'ready' | 'in_progress' | 'received' | 'cancelled' | 'unknown';
  createdAt: string | null;
  origin: InventoryTransferLocation | null;
  destination: InventoryTransferLocation | null;
  requestedQuantity: string;
  /** Source aggregate; it need not mean accepted or sellable units. */
  receivedQuantity: string;
  /** Null means unavailable, while an empty list is a complete empty collection. */
  lines:
    | {
        id: ExternalId;
        sku: ExternalId | null;
        title: string | null;
        unit: string;
        requested: string;
        picked: string;
        ready: string;
        shipped: string;
      }[]
    | null;
  /** Null when shipment identities are not shared by this read grant. */
  shipments: ExternalId[] | null;
}

/** Receiving evidence keeps accepted, rejected, unreceived and source totals distinct. */
export interface InventoryShipmentSnapshot {
  name: string;
  status:
    'draft' | 'in_transit' | 'partially_received' | 'received' | 'unknown';
  createdAt: string | null;
  shippedAt: string | null;
  /** First receiving time, not a completion timestamp. */
  receivedAt: string | null;
  expectedArrivalAt: string | null;
  quantity: string;
  /** Includes source-reported cancellations; never treated as accepted stock. */
  receivedQuantity: string;
  acceptedQuantity: string;
  rejectedQuantity: string;
  lines:
    | {
        id: ExternalId;
        sku: ExternalId | null;
        unit: string;
        quantity: string;
        accepted: string;
        rejected: string;
        unreceived: string;
      }[]
    | null;
  tracking: {
    carrier: string | null;
    number: string | null;
    url: string | null;
  } | null;
}

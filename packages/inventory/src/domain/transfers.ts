/** Retained source identifiers describe exact records; names never establish a stock-pool relationship. */
interface TransferSourceId {
  externalId: string;
  scopeKey: string;
}

/** Location details as captured by the transfer, with an independently mapped live identity when available. */
export interface TransferLocation {
  sourceId: TransferSourceId | null;
  locationId: string | null;
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

/** A source transfer request; quantities provide context and never augment a position's available or incoming balance. */
export interface TransferData {
  type: 'inventory_transfer';
  name: string;
  status:
    'draft' | 'ready' | 'in_progress' | 'received' | 'cancelled' | 'unknown';
  createdAt: string | null;
  origin: TransferLocation | null;
  destination: TransferLocation | null;
  requestedQuantity: string;
  receivedQuantity: string;
  lines:
    | {
        sourceId: TransferSourceId;
        sourceSku: TransferSourceId | null;
        skuId: string | null;
        title: string | null;
        unit: string;
        requested: string;
        picked: string;
        ready: string;
        shipped: string;
      }[]
    | null;
  shipmentSources: TransferSourceId[] | null;
}

/** Shipment receiving facts retain rejected and cancellation-inclusive totals separately from accepted units. */
export interface ShipmentData {
  type: 'inventory_shipment';
  name: string;
  status:
    'draft' | 'in_transit' | 'partially_received' | 'received' | 'unknown';
  createdAt: string | null;
  shippedAt: string | null;
  receivedAt: string | null;
  expectedArrivalAt: string | null;
  quantity: string;
  receivedQuantity: string;
  acceptedQuantity: string;
  rejectedQuantity: string;
  lines:
    | {
        sourceId: TransferSourceId;
        sourceSku: TransferSourceId | null;
        skuId: string | null;
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

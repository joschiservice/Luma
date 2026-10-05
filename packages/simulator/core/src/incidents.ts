/** Where Luma is expected to show an operational incident. */
export type IncidentSurface =
  'case' | 'fulfillment' | 'returns' | 'orders' | 'connections';

export interface IncidentKind {
  label: string;
  description: string;
  /** Rates count incidents per thousand orders, or per simulated day. */
  unit: 'order' | 'day';
  /** Luma exception class that should open a case, when a detection rule covers it. */
  exceptionClass:
    | 'inventory_mismatch'
    | 'stuck_fulfillment'
    | 'sync_failure'
    | 'workflow_failure'
    | null;
  surface: IncidentSurface;
}

/**
 * Operational incidents the merchant world can produce. Each one is recorded as ground truth
 * that Luma never reads; the scorecard compares it with Luma's cases.
 */
export const incidentKinds = {
  'inventory-drift': {
    label: 'Stock sync drift',
    description:
      'The stock sync stops updating one SKU at one shop location, so the shop shows more or less stock than the ERP.',
    unit: 'order',
    exceptionClass: 'inventory_mismatch',
    surface: 'case',
  },
  oversell: {
    label: 'Oversell risk',
    description:
      'A stale stock push leaves the shop selling units the ERP no longer has.',
    unit: 'order',
    exceptionClass: 'inventory_mismatch',
    surface: 'case',
  },
  'order-import-failure': {
    label: 'Order not imported',
    description:
      'The order integration drops a shop order, so it never reaches the ERP or the warehouse.',
    unit: 'order',
    exceptionClass: null,
    surface: 'orders',
  },
  'warehouse-stall': {
    label: 'Warehouse stall',
    description:
      'The warehouse never picks an order, so its fulfillment makes no progress.',
    unit: 'order',
    exceptionClass: 'stuck_fulfillment',
    surface: 'case',
  },
  'shipment-sync-failure': {
    label: 'Shipment not synced',
    description:
      'The ERP ships an order, but the shipment never reaches the shop, which keeps the order open.',
    unit: 'order',
    exceptionClass: 'stuck_fulfillment',
    surface: 'case',
  },
  'fraud-hold': {
    label: 'Unreleased fraud hold',
    description: 'An order is held for fraud review and nobody releases it.',
    unit: 'order',
    exceptionClass: 'stuck_fulfillment',
    surface: 'fulfillment',
  },
  'carrier-delay': {
    label: 'Carrier delay',
    description: 'A parcel stays in transit far beyond the carrier estimate.',
    unit: 'order',
    exceptionClass: null,
    surface: 'fulfillment',
  },
  'lost-parcel': {
    label: 'Lost parcel',
    description: 'The carrier reports a delivery failure.',
    unit: 'order',
    exceptionClass: null,
    surface: 'fulfillment',
  },
  'refund-failure': {
    label: 'Refund payment failed',
    description: 'A return is refunded, but the payment fails.',
    unit: 'order',
    exceptionClass: null,
    surface: 'returns',
  },
  'shipping-method-mismatch': {
    label: 'Shipping method lost',
    description:
      'The integration imports an express order with the standard shipping method.',
    unit: 'order',
    exceptionClass: null,
    surface: 'orders',
  },
  'provider-outage': {
    label: 'Provider outage',
    description: 'One provider API is unavailable for 20 to 40 minutes.',
    unit: 'day',
    exceptionClass: 'sync_failure',
    surface: 'connections',
  },
  'auth-revoked': {
    label: 'Access revoked',
    description:
      'One provider rejects Luma’s credentials for an hour, as after a revoked token.',
    unit: 'day',
    exceptionClass: 'sync_failure',
    surface: 'connections',
  },
} as const satisfies Record<string, IncidentKind>;

export type IncidentKindName = keyof typeof incidentKinds;

export const incidentKindNames = Object.keys(
  incidentKinds,
) as IncidentKindName[];

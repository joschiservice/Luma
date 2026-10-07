import type { IncidentView } from '@luma/simulator-contract';
import type { FaultKind } from '@luma/simulator-core';

/** Labels for transport failures and manual fault kinds. */
export const faultLabels: Record<FaultKind, string> = {
  unavailable: 'Unavailable (HTTP 503)',
  'rate-limit': 'Rate limited (HTTP 429)',
  'server-error': 'Server error (HTTP 500)',
  timeout: 'Timeout',
  reset: 'Connection reset',
  malformed: 'Malformed response',
  'schema-drift': 'Schema drift',
  unauthorized: 'Unauthorized (HTTP 401)',
  'response-loss': 'Write commits, response lost',
};

/** Operations the provider simulators name in faults; `*` matches every operation. */
export const knownOperations = [
  '*',
  'orders.read',
  'products.read',
  'items.read',
  'inventory.read',
  'inventory.available.reconcile',
  'fulfillment.read',
  'returns.read',
  'orders.shipping-method.read',
  'orders.shipping-method.write',
  'suppliers.read',
  'purchase-orders.read',
  'purchase-orders.submit',
];

/** What a planned incident waits for, by kind. */
const plannedTrigger: Partial<Record<IncidentView['kind'], string>> = {
  'shipment-sync-failure': 'waits for the order to ship',
  'carrier-delay': 'waits for the order to ship',
  'lost-parcel': 'waits for the order to ship',
  'refund-failure': 'waits for the return to be refunded',
  'warehouse-stall': 'waits for the order to reach the warehouse',
  'fraud-hold': 'waits for the order to be placed',
  'order-import-failure': 'waits for the order to be imported',
  'shipping-method-mismatch': 'waits for the order to be imported',
};

/** Describes an incident's lifecycle in words, including what a planned one waits for. */
export function incidentStatusText(
  incident: Pick<IncidentView, 'status' | 'kind'>,
) {
  if (incident.status === 'active') return 'Active';
  if (incident.status === 'recovered') return 'Recovered';

  return `Planned · ${plannedTrigger[incident.kind] ?? 'waits for its order to reach the affected step'}`;
}

/** Names the Luma surface where an incident is expected to show. */
export const surfaceLabels: Record<string, string> = {
  case: 'Issue case',
  fulfillment: 'Fulfillment view',
  returns: 'Returns view',
  orders: 'Orders view',
  procurement: 'Supplier orders',
  connections: 'Connection status',
};

/** Names a Luma exception class. */
export const exceptionClassLabel = (value: string | null) =>
  value === null
    ? 'No detection rule'
    : value.charAt(0).toUpperCase() + value.slice(1).replaceAll('_', ' ');

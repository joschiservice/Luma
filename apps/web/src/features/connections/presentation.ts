import type { InstallationCapability } from '@luma/api-contract';

export const reads = [
  'orders.read',
  'products.read',
  'inventory.read',
  'fulfillment.read',
] as const;

export const capabilities: Record<InstallationCapability, string> = {
  'orders.read': 'Read orders',
  'products.read': 'Read products',
  'inventory.read': 'Read inventory',
  'inventory.available.reconcile': 'Reconcile Shopify available stock',
  'fulfillment.read': 'Read fulfillment',
  'fulfillment.hold.release': 'Release a fulfillment hold',
  'fulfillment.open': 'Reopen fulfillment',
  'fulfillment.move': 'Move fulfillment',
  'customers.read': 'Read customers',
  'returns.read': 'Read returns and refunds',
  'orders.shipping-method.read': 'Read shipping method',
  'orders.shipping-method.write': 'Correct shipping method',
  'suppliers.read': 'Read suppliers',
  'purchase-orders.read': 'Read purchase orders and goods receipts',
  'purchase-orders.submit': 'Place approved purchase orders',
};

export const statuses = {
  pending: 'Awaiting validation',
  active: 'Validated',
  degraded: 'Needs attention',
  disconnected: 'Disconnected',
  revoked: 'Revoked',
};

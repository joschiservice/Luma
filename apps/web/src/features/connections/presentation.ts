import type { InstallationCapability } from '@luma/api-contract';

export const providers = {
  shopify: 'Shopify',
  'jtl-cloud': 'JTL Cloud',
  'jtl-onprem': 'JTL-Wawi on-premise',
} as const;

export type Provider = keyof typeof providers;

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
  'fulfillment.read': 'Read fulfillment',
  'orders.shipping-method.read': 'Read shipping method',
  'orders.shipping-method.write': 'Correct shipping method',
};

export const statuses = {
  pending: 'Awaiting validation',
  active: 'Validated',
  degraded: 'Needs attention',
  disconnected: 'Disconnected',
  revoked: 'Revoked',
};

import { createHash } from 'node:crypto';

import type { ReadCapability } from '@luma/connections';
import { fail, verifyWebhook } from '@luma/connector-shopify';

/** Supported change subscriptions and the authoritative reads each delivery refreshes. */
export const shopifyChangeTopics: Record<string, ReadCapability[]> = {
  'order_transactions/create': ['orders.read'],
  'orders/paid': ['orders.read'],
  'refunds/create': ['orders.read', 'returns.read'],
  'returns/request': ['orders.read', 'returns.read'],
  'returns/approve': ['orders.read', 'returns.read'],
  'returns/decline': ['orders.read', 'returns.read'],
  'returns/update': ['orders.read', 'returns.read'],
  'returns/process': ['orders.read', 'returns.read'],
  'returns/close': ['orders.read', 'returns.read'],
  'returns/cancel': ['orders.read', 'returns.read'],
  'returns/reopen': ['orders.read', 'returns.read'],
  'reverse_fulfillment_orders/dispose': ['returns.read'],
  'customers/create': ['customers.read'],
  'customers/update': ['orders.read', 'customers.read'],
  'customers/delete': ['orders.read', 'customers.read'],
  'fulfillment_holds/added': ['fulfillment.read'],
  'fulfillment_holds/released': ['fulfillment.read'],
  'inventory_items/update': ['inventory.read', 'products.read'],
  'locations/update': ['inventory.read'],
  'locations/create': ['inventory.read'],
  'locations/delete': ['inventory.read'],
  'locations/activate': ['inventory.read'],
  'locations/deactivate': ['inventory.read'],
  'inventory_items/create': ['inventory.read', 'products.read'],
  'inventory_items/delete': ['inventory.read', 'products.read'],
  'orders/create': ['orders.read', 'fulfillment.read'],
  'orders/edited': ['orders.read', 'fulfillment.read'],
  'orders/updated': ['orders.read', 'fulfillment.read', 'returns.read'],
  'orders/cancelled': ['orders.read', 'fulfillment.read'],
  'orders/delete': ['orders.read', 'fulfillment.read'],
  'products/create': ['products.read', 'inventory.read'],
  'products/update': ['products.read', 'inventory.read'],
  'products/delete': ['products.read', 'inventory.read'],
  'inventory_levels/update': ['inventory.read'],
  'inventory_levels/connect': ['inventory.read'],
  'inventory_levels/disconnect': ['inventory.read'],
  'fulfillments/create': ['fulfillment.read'],
  'fulfillments/update': ['fulfillment.read'],
  'fulfillment_orders/moved': ['orders.read', 'fulfillment.read'],
  'fulfillment_orders/split': ['orders.read', 'fulfillment.read'],
  'fulfillment_orders/merged': ['orders.read', 'fulfillment.read'],
  'fulfillment_orders/cancelled': ['orders.read', 'fulfillment.read'],
  'fulfillment_orders/order_routing_complete': ['fulfillment.read'],
  'fulfillment_orders/placed_on_hold': ['fulfillment.read'],
  'fulfillment_orders/hold_released': ['fulfillment.read'],
};

/** Verify the original bytes and schedule authoritative reads; partial events never replace snapshots. */
export function mapShopifyWebhook(options: {
  tenantId: string;
  connectionId: string;
  expectedShop: string;
  shop: string;
  secret: string;
  hmac: string;
  eventId: string;
  topic: string;
  body: Uint8Array;
}): {
  eventKey: string;
  tenantId: string;
  connectionId: string;
  capabilities: ReadCapability[];
} | null {
  if (
    !options.secret ||
    options.shop !== options.expectedShop ||
    !options.tenantId ||
    !options.connectionId
  )
    fail('authentication');
  verifyWebhook(options);
  const capabilities = Object.hasOwn(shopifyChangeTopics, options.topic)
    ? shopifyChangeTopics[options.topic]
    : undefined;
  if (!capabilities) return null;

  return {
    tenantId: options.tenantId,
    connectionId: options.connectionId,
    eventKey: createHash('sha256')
      .update(
        JSON.stringify([
          options.tenantId,
          options.connectionId,
          options.topic,
          options.eventId,
        ]),
      )
      .digest('hex'),
    capabilities: [...capabilities],
  };
}

/** Actual grants required by the pinned Shopify webhook schema; write grants imply reads. */
export function canSubscribe(
  topic: string,
  scopes: string[],
  customerApproved: boolean,
) {
  const has = (read: string) =>
    scopes.includes(read) || scopes.includes(read.replace(/^read_/, 'write_'));
  if (topic.startsWith('customers/'))
    return customerApproved && has('read_customers');
  if (
    topic.startsWith('fulfillment_orders/') ||
    topic.startsWith('fulfillment_holds/')
  )
    return [
      'read_merchant_managed_fulfillment_orders',
      'read_assigned_fulfillment_orders',
      'read_third_party_fulfillment_orders',
    ].some(has);
  if (topic.startsWith('inventory_levels/')) return has('read_inventory');
  if (topic.startsWith('inventory_items/'))
    return has('read_inventory') || has('read_products');
  if (topic.startsWith('locations/')) return has('read_locations');
  if (topic.startsWith('products/')) return has('read_products');
  if (
    [
      'returns/approve',
      'returns/cancel',
      'returns/close',
      'returns/reopen',
    ].includes(topic)
  )
    return has('read_returns') || has('read_orders');
  if (
    topic.startsWith('returns/') ||
    topic.startsWith('reverse_fulfillment_orders/')
  )
    return has('read_returns');
  if (topic.startsWith('fulfillments/'))
    return has('read_orders') || has('read_fulfillments');

  return has('read_orders');
}

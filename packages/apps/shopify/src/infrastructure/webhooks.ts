import { createHash } from 'node:crypto';

import type { ReadCapability } from '@luma/connections';
import { fail, verifyWebhook } from '@luma/connector-shopify';

const topics: Record<string, ReadCapability[]> = {
  'orders/create': ['orders.read', 'fulfillment.read'],
  'orders/updated': ['orders.read', 'fulfillment.read'],
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
  const capabilities = Object.hasOwn(topics, options.topic)
    ? topics[options.topic]
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

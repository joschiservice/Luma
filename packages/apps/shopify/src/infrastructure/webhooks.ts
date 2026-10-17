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

/**
 * GraphQL types a delivery in each topic family is about. The topic header is not signed, so
 * a delivery counts only when its signed body names one of these types.
 */
const topicResources: Record<string, string[]> = {
  orders: ['Order', 'OrderEdit'],
  order_transactions: ['OrderTransaction'],
  refunds: ['Refund'],
  returns: ['Return'],
  reverse_fulfillment_orders: ['ReverseFulfillmentOrder'],
  customers: ['Customer'],
  fulfillment_holds: ['FulfillmentHold', 'FulfillmentOrder'],
  fulfillment_orders: ['FulfillmentOrder'],
  fulfillments: ['Fulfillment'],
  inventory_items: ['InventoryItem'],
  inventory_levels: ['InventoryLevel'],
  locations: ['Location'],
  products: ['Product'],
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const gidType = (value: unknown) =>
  typeof value === 'string'
    ? /^gid:\/\/shopify\/([A-Za-z]+)\//.exec(value)?.[1]
    : undefined;

const snake = (type: string) =>
  type.replace(
    /[A-Z]/g,
    (letter, index: number) => `${index ? '_' : ''}${letter.toLowerCase()}`,
  );

/**
 * The deduplication scope of a signed body under the claimed topic, or null when the body is
 * not about the topic's resource. A body naming its own GraphQL ID must name a topic type;
 * payloads without one qualify through a top-level resource such as `fulfillment_order`, an
 * inventory level's item and location, or, for deletions, a bare `id`. Shopify's bare
 * deletion payloads look alike for every resource, so they share one scope: relabelling a
 * deletion cannot request another resource's full reread. Removal topics reject bodies with
 * an update time.
 */
function deliveryScope(topic: string, body: Uint8Array) {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body).toString('utf8'));
  } catch {
    return null;
  }
  if (!isRecord(payload)) return null;
  // Removal payloads describe a record that no longer exists and carry no update time, so a
  // replayed change body cannot be relabelled as a deletion that requests a full reread.
  if (/\/(delete|disconnect)$/.test(topic) && payload.updated_at !== undefined)
    return null;
  const resources = topicResources[topic.slice(0, topic.indexOf('/'))] ?? [];
  const names = (value: unknown) => resources.includes(gidType(value) ?? '');
  if (payload.admin_graphql_api_id !== undefined)
    return names(payload.admin_graphql_api_id) ? topic : null;
  // A member such as `original_fulfillment_order` must be named for the type, and its own
  // GraphQL ID, when it has one, must agree.
  const nested = Object.entries(payload).some(([key, value]) =>
    isRecord(value)
      ? resources.some((type) => {
          const own = gidType(value.admin_graphql_api_id ?? value.id);

          return (
            (key === snake(type) || key.endsWith(`_${snake(type)}`)) &&
            (own === undefined || own === type)
          );
        })
      : key.endsWith('_id') && names(value),
  );
  if (
    nested ||
    (resources.includes('InventoryLevel') &&
      payload.inventory_item_id !== undefined &&
      payload.location_id !== undefined)
  )
    return topic;
  if (
    topic.endsWith('/delete') &&
    (typeof payload.id === 'number' || typeof payload.id === 'string')
  )
    return 'deleted';

  return null;
}

/**
 * Verify the original bytes and schedule authoritative reads; partial events never replace
 * snapshots. The topic, Shopify's delivery IDs and their timestamps are unsigned headers, so
 * the refresh key covers a hash of the signed body and a delivery counts only when that body
 * is about the claimed topic's resource. A replayed body is therefore deduplicated whatever
 * its delivery ID, and relabelling it reaches only topics of the same resource. Retries
 * resend the same body; a repeated identical body would refresh the same state. Returns null
 * for unmapped topics and for bodies that do not match the topic, which are acknowledged
 * without a refresh.
 */
export function mapShopifyWebhook(options: {
  tenantId: string;
  connectionId: string;
  expectedShop: string;
  shop: string;
  secret: string;
  hmac: string;
  /** Shopify's delivery ID; checked for presence but not trusted, since it is unsigned. */
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
  const scope = deliveryScope(options.topic, options.body);
  if (!scope) return null;

  return {
    tenantId: options.tenantId,
    connectionId: options.connectionId,
    eventKey: createHash('sha256')
      .update(
        JSON.stringify([
          options.tenantId,
          options.connectionId,
          scope,
          createHash('sha256').update(options.body).digest('hex'),
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

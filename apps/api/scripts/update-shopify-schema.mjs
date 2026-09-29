import { writeFile } from 'node:fs/promises';

import {
  assertValidSchema,
  buildClientSchema,
  buildSchema,
  getIntrospectionQuery,
  parse,
  print,
  printType,
  visit,
} from 'graphql';

const version = process.argv[2];

if (!/^\d{4}-(01|04|07|10)$/.test(version ?? '')) {
  throw new Error('Usage: node scripts/update-shopify-schema.mjs YYYY-MM');
}

const source = `https://shopify.dev/admin-graphql-direct-proxy/${version}`;

const response = await fetch(source, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: getIntrospectionQuery({ descriptions: false }),
  }),
});

if (!response.ok) throw new Error(`Schema request failed: ${response.status}`);

const body = await response.json();

if (body.errors) throw new Error(JSON.stringify(body.errors));

const schema = buildClientSchema(body.data);

// Retain provider definitions for the adapter's surface, including every argument and its type.
const fields = {
  QueryRoot: [
    'node',
    'orders',
    'products',
    'inventoryItems',
    'shop',
    'currentAppInstallation',
    'webhookSubscriptions',
  ],
  Mutation: ['webhookSubscriptionCreate'],
  Shop: ['id', 'myshopifyDomain'],
  AppInstallation: ['id', 'accessScopes'],
  AccessScope: ['handle'],
  WebhookSubscriptionConnection: ['nodes'],
  WebhookSubscription: ['id', 'uri'],
  WebhookSubscriptionCreatePayload: ['webhookSubscription', 'userErrors'],
  UserError: ['message'],
  Node: ['id'],
  Order: [
    'id',
    'updatedAt',
    'name',
    'cancelledAt',
    'closed',
    'displayFinancialStatus',
    'lineItems',
    'fulfillmentOrders',
    'fulfillments',
    'createdAt',
    'displayFulfillmentStatus',
    'currentTotalPriceSet',
    'totalOutstandingSet',
    'transactions',
    'customer',
    'returns',
    'refunds',
    'events',
  ],
  LineItem: ['id', 'name', 'quantity', 'variant'],
  Product: ['id', 'updatedAt', 'title', 'status', 'variants'],
  ProductVariant: [
    'id',
    'sku',
    'inventoryItem',
    'title',
    'price',
    'updatedAt',
    'product',
  ],
  InventoryItem: [
    'id',
    'tracked',
    'inventoryLevels',
    'updatedAt',
    'sku',
    'variant',
  ],
  InventoryLevel: ['id', 'updatedAt', 'location', 'quantities'],
  InventoryQuantity: ['id', 'name', 'quantity'],
  Location: ['id', 'name', 'isActive'],
  FulfillmentOrder: [
    'id',
    'updatedAt',
    'status',
    'lineItems',
    'requestStatus',
    'order',
    'assignedLocation',
    'fulfillmentHolds',
  ],
  FulfillmentOrderLineItem: [
    'id',
    'remainingQuantity',
    'totalQuantity',
    'lineItem',
  ],
  Fulfillment: [
    'id',
    'updatedAt',
    'status',
    'deliveredAt',
    'inTransitAt',
    'fulfillmentLineItems',
  ],
  FulfillmentLineItem: ['id', 'quantity', 'lineItem'],
  Customer: ['id', 'updatedAt', 'numberOfOrders', 'amountSpent', 'orders'],
  MoneyBag: ['shopMoney'],
  MoneyV2: ['amount', 'currencyCode'],
  OrderTransaction: [
    'id',
    'createdAt',
    'processedAt',
    'kind',
    'status',
    'gateway',
    'amountSet',
    'parentTransaction',
  ],
  Refund: ['id', 'createdAt', 'updatedAt', 'totalRefundedSet', 'order'],
  Return: ['id', 'name', 'status', 'order', 'returnLineItems'],
  ReturnConnection: ['nodes', 'pageInfo'],
  ReturnLineItemTypeConnection: ['nodes', 'pageInfo'],
  ReturnLineItemType: ['id', 'quantity', 'returnReason'],
  ReturnLineItem: ['id', 'quantity', 'returnReason', 'fulfillmentLineItem'],
  FulfillmentOrderAssignedLocation: ['location'],
  FulfillmentHold: ['id', 'reason'],
  EventConnection: ['nodes', 'pageInfo'],
  Event: ['id', 'createdAt'],
  BasicEvent: ['id', 'createdAt', 'action'],
  PageInfo: ['hasNextPage', 'endCursor'],
};

for (const type of [
  'Order',
  'Product',
  'InventoryItem',
  'LineItem',
  'ProductVariant',
  'InventoryLevel',
  'FulfillmentOrder',
  'FulfillmentOrderLineItem',
  'FulfillmentLineItem',
]) {
  fields[`${type}Connection`] = ['nodes', 'pageInfo'];
}

const definitions = new Map();

function include(name) {
  if (definitions.has(name)) return;
  const type = schema.getType(name);
  if (!type) throw new Error(`Missing Shopify type: ${name}`);
  let definition = parse(printType(type)).definitions[0];
  const selection = fields[name];
  if (selection) {
    for (const field of selection) {
      if (
        !definition.fields.some((candidate) => candidate.name.value === field)
      ) {
        throw new Error(`Missing Shopify field: ${name}.${field}`);
      }
    }
    definition = {
      ...definition,
      fields: definition.fields.filter((field) =>
        selection.includes(field.name.value),
      ),
    };
  } else if (
    definition.kind === 'ObjectTypeDefinition' ||
    definition.kind === 'InterfaceTypeDefinition'
  ) {
    throw new Error(`Add a field selection for ${name}`);
  }
  if ('interfaces' in definition) {
    definition = {
      ...definition,
      interfaces: definition.interfaces.filter((item) =>
        ['Node', 'Event', 'ReturnLineItemType'].includes(item.name.value),
      ),
    };
  }
  definition = visit(definition, { Directive: () => null });
  definitions.set(name, definition);
  visit(definition, {
    NamedType(node) {
      include(node.name.value);
    },
  });
}

for (const name of Object.keys(fields)) include(name);

const document = `# Generated from ${source}\n# Adapter surface only; regenerate with scripts/update-shopify-schema.mjs.\nschema { query: QueryRoot mutation: Mutation }\n\n${[...definitions.values()].map(print).join('\n\n')}\n`;

assertValidSchema(buildSchema(document));

const destination = new URL(
  `../../../packages/apps/shopify/src/infrastructure/fixtures/admin-${version}.graphql`,
  import.meta.url,
);

await writeFile(destination, document);

console.log(`Saved ${destination.pathname}`);

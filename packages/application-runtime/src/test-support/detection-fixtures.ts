import { readFileSync } from 'node:fs';

import { createJtlConnector } from '@luma/app-jtl';
import { createShopifyConnector } from '@luma/app-shopify';
import { createCapabilityRuntime } from '@luma/connections/adapters';
import type { TenantContext } from '@luma/identity';

const jtl = JSON.parse(
  readFileSync(
    new URL(
      '../../../apps/jtl/src/infrastructure/fixtures/commerce.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

const shopify = JSON.parse(
  readFileSync(
    new URL(
      '../../../apps/shopify/src/infrastructure/fixtures/commerce.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

/** Real adapter normalization over synthetic provider HTTP responses. */
export async function detectionFixtures(context: TenantContext, now: Date) {
  const page = (nodes: unknown[]) => ({
    nodes,
    pageInfo: { hasNextPage: false, endCursor: null },
  });
  const jtlData = structuredClone(jtl);
  // Explicitly align the fixture's stock unit; equal SKU labels are never used as mappings.
  jtlData.items[0]!.unit = 'each';
  const jtlConnector = createJtlConnector({
    tenantId: context.tenantId,
    connectionId: '11111111-1111-4111-8111-111111111111',
    connection: {
      kind: 'onprem',
      baseUrl: 'http://127.0.0.1:5883/api/eazybusiness/',
      appId: 'Luma',
      appVersion: '0',
      challengeCode: 'fixture',
      apiKey: async () => 'fixture',
    },
    now: () => now,
    recordObservations: async () => {},
    fetch: async (input) => {
      const url = new URL(String(input));
      const path = url.pathname.replace('/api/eazybusiness/', '');
      const paged = (items: unknown[]) =>
        Response.json({
          items,
          totalItems: items.length,
          pageNumber: 1,
          pageSize: Number(url.searchParams.get('pageSize')),
        });
      if (path === 'sales-orders/10/line-items')
        return Response.json(jtlData.orderLines);
      if (path === 'items') return paged(jtlData.items);
      if (path === 'delivery-notes') return paged(jtlData.notes);
      const match = /^delivery-notes\/(30|31)(\/line-items)?$/.exec(path);
      if (match) {
        const i = Number(match[1]) - 30;

        return match[2]
          ? paged(jtlData.noteLines[i]!)
          : Response.json(jtlData.details[i]);
      }
      throw new Error(`Unexpected JTL fixture request: ${path}`);
    },
  });
  const shopifyConnector = createShopifyConnector({
    tenantId: context.tenantId,
    connectionId: '22222222-2222-4222-8222-222222222222',
    shop: 'fixture.myshopify.com',
    accessToken: async () => 'fixture',
    now: () => now,
    recordObservations: async () => {},
    fetch: async (_url, init) => {
      const { query, variables } = JSON.parse(String(init?.body)) as {
        query: string;
        variables: { id?: string };
      };
      let data: unknown;
      if (query.includes('LumaPage'))
        data = {
          page: page([
            {
              id: query.includes('inventoryItems(')
                ? shopify.inventoryItem.id
                : shopify.order.id,
            },
          ]),
        };
      else if (query.includes('children:'))
        data = {
          node: {
            children: page(
              query.includes('inventoryLevels(')
                ? shopify.levels
                : query.includes('fulfillmentOrders(')
                  ? shopify.work
                  : query.includes('fulfillmentLineItems(')
                    ? shopify.shipmentLines
                    : variables.id?.includes('/FulfillmentOrder/')
                      ? shopify.workLines
                      : shopify.orderLines,
            ),
          },
        };
      else
        data = {
          node: query.includes('... on InventoryItem')
            ? shopify.inventoryItem
            : query.includes('fulfillments {')
              ? { fulfillments: shopify.shipments }
              : shopify.order,
        };

      return Response.json({ data });
    },
  });
  const runtime = createCapabilityRuntime({
    resolve: async (_context, id) =>
      id === jtlConnector.id ? jtlConnector : shopifyConnector,
    record: async () => {},
  });

  async function inventory(connectionId: string) {
    const result = await runtime.read(context, {
      connectionId,
      capability: 'inventory.read',
      version: '0',
      input: { limit: 10 },
    });
    if (!result.ok)
      throw new Error(`Inventory fixture failed: ${result.error.code}`);

    return result.value;
  }

  async function fulfillment(connectionId: string) {
    const result = await runtime.read(context, {
      connectionId,
      capability: 'fulfillment.read',
      version: '0',
      input: { limit: 10 },
    });
    if (!result.ok)
      throw new Error(`Fulfillment fixture failed: ${result.error.code}`);

    return result.value;
  }

  return {
    jtlInventory: await inventory(jtlConnector.id),
    shopifyInventory: await inventory(shopifyConnector.id),
    jtlFulfillment: await fulfillment(jtlConnector.id),
    shopifyFulfillment: await fulfillment(shopifyConnector.id),
  };
}

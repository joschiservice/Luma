import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { createCapabilityRuntime } from '@luma/connections/adapters';
import { builtInMembership, makeTenantContext } from '@luma/identity';
import { buildSchema, parse, validate } from 'graphql';
import { expect, it, vi } from 'vitest';

import { createShopifyConnector } from './adapter.js';

const schema = buildSchema(
  readFileSync(
    new URL('./fixtures/admin-2026-07.graphql', import.meta.url),
    'utf8',
  ),
);
const tenantId = randomUUID(),
  connectionId = randomUUID();
const context = makeTenantContext(
  { userId: 'reader', sessionId: 's' },
  {
    id: tenantId,
    name: 'Shop',
    slug: 'shop',
    dataRegion: 'EU',
    status: 'active',
  },
  builtInMembership(
    { id: randomUUID(), organizationId: tenantId, userId: 'reader' },
    'owner',
  ),
  randomUUID(),
);
const info = { hasNextPage: false, endCursor: null };
const gid = (kind: string, id = '1') => `gid://shopify/${kind}/${id}`;

function fixture({
  scopes = [
    'read_inventory_transfers',
    'read_inventory_shipments',
    'read_inventory',
  ],
  duplicates = false,
  nullable = false,
  shipments = true,
} = {}) {
  const recordObservations = vi.fn().mockResolvedValue(undefined);
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const { query, variables } = JSON.parse(String(init?.body)) as {
      query: string;
      variables: { after?: string };
    };
    expect(validate(schema, parse(query))).toEqual([]);
    if (query.includes('LumaInventoryTransferAccess'))
      return Response.json({
        data: {
          currentAppInstallation: {
            accessScopes: scopes.map((handle) => ({ handle })),
          },
        },
      });
    if (query.includes('LumaInventoryTransferPage'))
      return Response.json({
        data: {
          page: {
            nodes: [
              {
                id: gid('InventoryTransfer'),
                name: 'Move',
                status: 'IN_PROGRESS',
                dateCreated: null,
                totalQuantity: 2,
                receivedQuantity: 0,
                origin: {
                  name: 'Removed location',
                  snapshottedAt: '2026-10-12T00:00:00Z',
                  address: {
                    address1: null,
                    address2: null,
                    city: null,
                    provinceCode: null,
                    countryCode: null,
                    zip: null,
                  },
                  ...(query.includes('location { id }')
                    ? { location: null }
                    : {}),
                },
                destination: null,
              },
            ],
            pageInfo: info,
          },
        },
      });
    const shipmentQuery = query.includes('children: shipments');
    const line = {
      id: gid('InventoryTransferLineItem'),
      title: null,
      totalQuantity: 2,
      pickedForShipmentQuantity: 0,
      shippableQuantity: 0,
      shippedQuantity: 2,
      ...(query.includes('inventoryItem { id }')
        ? { inventoryItem: { id: gid('InventoryItem') } }
        : {}),
    };
    if (shipmentQuery)
      return Response.json({
        data: {
          node: {
            children: {
              nodes: [{ id: gid('InventoryShipment') }],
              pageInfo: info,
            },
          },
        },
      });
    if (nullable) return Response.json({ data: { node: { children: null } } });
    if (!variables.after)
      return Response.json({
        data: {
          node: {
            children: {
              nodes: [line],
              pageInfo: { hasNextPage: true, endCursor: 'line-page' },
            },
          },
        },
      });

    return Response.json({
      data: {
        node: { children: { nodes: duplicates ? [line] : [], pageInfo: info } },
      },
    });
  });
  const connector = createShopifyConnector({
    tenantId,
    connectionId,
    shop: 'shop.myshopify.com',
    accessToken: async () => 'synthetic',
    fetch,
    now: () => new Date('2026-10-12T00:00:00Z'),
    recordObservations,
    inventoryShipmentAccess: shipments,
  });
  const runtime = createCapabilityRuntime({
    resolve: async () => connector,
    record: async () => {},
  });
  const read = () =>
    runtime.read(context, {
      connectionId,
      capability: 'inventory.transfers.read',
      version: '0',
      input: { limit: 100 },
    });

  return { read, recordObservations, fetch };
}

it('drains exact lines, retains historical deleted locations and separates shipment identities', async () => {
  const f = fixture();
  const result = await f.read();
  expect(result).toMatchObject({
    ok: true,
    value: {
      items: [
        {
          sourceUpdatedAt: null,
          data: {
            origin: { id: null, name: 'Removed location' },
            lines: [
              {
                id: { externalId: gid('InventoryTransferLineItem') },
                shipped: '2',
              },
            ],
            shipments: [{ externalId: gid('InventoryShipment') }],
          },
        },
      ],
    },
  });
  expect(f.recordObservations).toHaveBeenCalledOnce();
});
it('omits inaccessible nested resources without replacing them with empty or guessed identities', async () => {
  const f = fixture({ scopes: ['read_inventory_transfers'], shipments: false });
  expect(await f.read()).toMatchObject({
    ok: true,
    value: {
      items: [
        {
          data: {
            origin: { id: null },
            lines: [{ sku: null }],
            shipments: null,
          },
        },
      ],
    },
  });
  const queries = f.fetch.mock.calls.map(([, init]) => String(init?.body));
  expect(queries.some((q) => q.includes('inventoryItem { id }'))).toBe(false);
  expect(queries.some((q) => q.includes('children: shipments'))).toBe(false);
});
it('rejects duplicated child identities before persisting or returning quantities', async () => {
  const f = fixture({ duplicates: true });
  expect(await f.read()).toMatchObject({
    ok: false,
    error: { code: 'invalid_response' },
  });
  expect(f.recordObservations).not.toHaveBeenCalled();
});
it('preserves an unavailable line collection as null', async () => {
  const f = fixture({ nullable: true });
  expect(await f.read()).toMatchObject({
    ok: true,
    value: { items: [{ data: { lines: null } }] },
  });
});

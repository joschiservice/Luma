import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { ConnectorError, type ReadCapability } from '@luma/connections';
import { createCapabilityRuntime } from '@luma/connections/adapters';
import { commerceSchema } from '@luma/connections/composition';
import { API_VERSION } from '@luma/connector-shopify';
import type { TenantContext } from '@luma/identity';
import { buildSchema, parse, validate } from 'graphql';
import { describe, expect, it, vi } from 'vitest';

import type { ShopifyConnectorOptions } from './adapter.js';
import { createShopifyConnector } from './adapter.js';
import commerce from './fixtures/commerce.json' with { type: 'json' };
import { mapShopifyWebhook } from './webhooks.js';

vi.mock('@luma/identity', () => ({
  requireTenant(context: TenantContext, tenantId: string) {
    if (context.tenantId !== tenantId) throw new Error('Tenant mismatch');
  },
}));

const context = {
  tenantId: 'tenant-a',
  requestId: 'request-a',
} as TenantContext;

const ref = (externalId: string) => ({ externalId, scopeKey: '' });

const page = (nodes: unknown[], cursor: string | null = null) => ({
  nodes,
  pageInfo: { hasNextPage: cursor !== null, endCursor: cursor },
});

const response = (data: unknown) => Response.json({ data });

function fixture(overrides: Partial<ShopifyConnectorOptions> = {}) {
  const data = structuredClone(commerce);
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const { query, variables } = JSON.parse(String(init?.body)) as {
      query: string;
      variables: { id?: string };
    };
    if (query.includes('LumaScanStart'))
      return response({
        currentAppInstallation: { accessScopes: data.scopes },
        ...(query.includes('Count(')
          ? { count: { count: 1, precision: 'EXACT' } }
          : {}),
      });
    if (query.includes('LumaCustomers'))
      return response({ page: page(data.customers) });
    if (query.includes('LumaPage'))
      return response({
        page: page([
          {
            id: query.includes('products(')
              ? data.product.id
              : query.includes('inventoryItems(')
                ? data.inventoryItem.id
                : data.order.id,
          },
        ]),
      });
    if (query.includes('children:')) {
      const nodes = query.includes('inventoryLevels(')
        ? data.levels
        : query.includes('variants(')
          ? data.variants
          : query.includes('fulfillmentOrders(')
            ? data.work
            : query.includes('fulfillmentLineItems(')
              ? data.shipmentLines
              : variables.id?.includes('/FulfillmentOrder/')
                ? data.workLines
                : data.orderLines;

      return response({ node: { children: page(nodes) } });
    }

    return response({
      node: query.includes('... on InventoryItem')
        ? data.inventoryItem
        : query.includes('... on Product')
          ? data.product
          : query.includes('fulfillments {')
            ? { fulfillments: data.shipments }
            : data.order,
    });
  });
  const accessToken = vi.fn().mockResolvedValue('private-token');
  const recordObservations = vi.fn().mockResolvedValue(undefined);
  const options = {
    tenantId: 'tenant-a',
    connectionId: 'connection-a',
    shop: 'example.myshopify.com',
    accessToken,
    fetch,
    recordObservations,
    now: () => new Date('2026-09-17T01:00:00Z'),
    ...overrides,
  };
  const connection = createShopifyConnector(options);
  const record = vi.fn().mockResolvedValue(undefined);
  const runtime = createCapabilityRuntime({
    resolve: async () => connection,
    record,
  });
  const read = <K extends ReadCapability>(
    capability: K,
    input = { limit: 10 },
  ) =>
    runtime.read(context, {
      capability,
      connectionId: connection.id,
      version: '0',
      input,
    });

  return {
    data,
    fetch,
    accessToken,
    recordObservations,
    record,
    connection,
    runtime,
    read,
  };
}

describe('Shopify read capabilities', () => {
  it('discovers only reads, normalizes all four resources and persists evidence before returning', async () => {
    const f = fixture({ rawRetentionMs: 3600000 });
    expect(
      (await f.runtime.discover(context, 'connection-a')).map(
        (item) => item.capability,
      ),
    ).toEqual([
      'orders.read',
      'products.read',
      'inventory.read',
      'fulfillment.read',
    ]);
    const orders = await f.read('orders.read');
    expect(orders).toMatchObject({
      ok: true,
      value: {
        completeness: 'complete',
        items: [
          {
            source: { provider: 'shopify', externalId: commerce.order.id },
            adapterVersion: 'shopify/1',
            data: {
              paymentStatus: 'paid',
              placedAt: '2026-09-14T08:30:00Z',
              total: { amount: '42.50', currency: 'EUR' },
              lines: [
                {
                  sku: ref(commerce.inventoryItem.id),
                  quantity: { amount: '3' },
                  cancelledQuantity: null,
                  skuCode: 'MUG-Blue',
                  title: 'Blue mug',
                },
                { sku: null, skuCode: null, title: null },
              ],
            },
          },
        ],
      },
    });
    expect(await f.read('products.read')).toMatchObject({
      ok: true,
      value: {
        items: [
          {
            data: {
              skus: [{ id: ref(commerce.inventoryItem.id), code: 'MUG-Blue' }],
            },
          },
        ],
      },
    });
    expect(await f.read('inventory.read')).toMatchObject({
      ok: true,
      value: {
        items: [
          {
            source: { scopeKey: 'gid://shopify/Location/41' },
            data: { onHand: '3', reserved: '5', available: '-2' },
          },
          { data: { onHand: null, reserved: null, available: '0' } },
        ],
      },
    });
    expect(await f.read('fulfillment.read')).toMatchObject({
      ok: true,
      value: {
        items: [
          {
            source: { externalId: commerce.work[0]!.id },
            data: {
              status: 'processing',
              lines: [{ quantity: { amount: '2' } }],
              lastProgressAt: '2026-09-15T00:00:00Z',
            },
          },
          {
            source: { externalId: commerce.shipments[0]!.id },
            data: { status: 'shipped', lines: [{ quantity: { amount: '1' } }] },
          },
        ],
      },
    });
    expect(f.recordObservations).toHaveBeenCalledTimes(4);
    expect(f.recordObservations.mock.calls[0]![0]).toMatchObject({
      apiVersion: '2026-07',
      raw: { expiresAt: '2026-09-17T02:00:00.000Z' },
    });
    for (const [url, init] of f.fetch.mock.calls) {
      expect(url).toBe(
        'https://example.myshopify.com/admin/api/2026-07/graphql.json',
      );
      expect(init).toMatchObject({
        method: 'POST',
        redirect: 'error',
        headers: { 'X-Shopify-Access-Token': 'private-token' },
      });
      expect(String(init?.body)).not.toContain('mutation');
    }
    expect(f.accessToken).toHaveBeenCalledTimes(f.fetch.mock.calls.length);
    expect(JSON.stringify(f.record.mock.calls)).not.toContain('private-token');
  });
  it('uses rotated credentials for the next SDK request', async () => {
    const f = fixture();
    f.accessToken
      .mockResolvedValueOnce('first-token')
      .mockResolvedValue('rotated-token');
    expect(await f.read('orders.read')).toMatchObject({ ok: true });
    const headers = f.fetch.mock.calls.map(
      ([, init]) => new Headers(init?.headers),
    );
    expect(headers[0]?.get('X-Shopify-Access-Token')).toBe('first-token');
    expect(
      headers
        .slice(1)
        .every(
          (header) => header.get('X-Shopify-Access-Token') === 'rotated-token',
        ),
    ).toBe(true);
    expect(JSON.stringify(f.recordObservations.mock.calls)).not.toMatch(
      /first-token|rotated-token/,
    );
  });
  it('drains nested pages before publishing a complete order', async () => {
    const f = fixture();
    const fallback = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url, init) => {
      const { query, variables } = JSON.parse(String(init?.body));
      if (query.includes('children: lineItems'))
        return response({
          node: {
            children: variables.after
              ? page([commerce.orderLines[1]])
              : page([commerce.orderLines[0]], 'line-page-2'),
          },
        });

      return fallback(url, init);
    });
    const result = await f.read('orders.read');
    expect(result.ok && result.value.items[0]?.data.lines).toHaveLength(2);
    // Scan start, root page, order node and two line pages.
    expect(f.fetch).toHaveBeenCalledTimes(5);
  });
  it('binds pagination to the tenant, connection, capability and filters', async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(response({ page: page([], 'next-page') }));
    const first = await f.read('inventory.read');
    if (!first.ok || !first.value.nextCursor) throw new Error('Missing cursor');
    const input = { limit: 10, cursor: first.value.nextCursor };
    expect(await f.read('orders.read', input)).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(
      await f.runtime.read(context, {
        capability: 'inventory.read',
        connectionId: 'connection-a',
        version: '0',
        input: { ...input, location: ref('gid://shopify/Location/41') },
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(
      await fixture({ connectionId: 'connection-b' }).read(
        'inventory.read',
        input,
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    f.fetch.mockResolvedValueOnce(response({ page: page([]) }));
    expect(await f.read('inventory.read', input)).toMatchObject({
      ok: true,
      value: { nextCursor: null },
    });
    expect(
      JSON.parse(String(f.fetch.mock.calls.at(-1)?.[1]?.body)).variables.after,
    ).toBe('next-page');
  });
  it('uses typed identity filters without relying on SKU text or search syntax', async () => {
    const f = fixture();
    const result = await f.runtime.read(context, {
      capability: 'inventory.read',
      connectionId: 'connection-a',
      version: '0',
      input: {
        limit: 1,
        sku: ref(commerce.inventoryItem.id),
        location: ref('gid://shopify/Location/42'),
      },
    });
    expect(result).toMatchObject({
      ok: true,
      value: { items: [{ data: { available: '0' } }] },
    });
    expect(result.ok && result.value.items).toHaveLength(1);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(
      await f.runtime.read(context, {
        capability: 'fulfillment.read',
        connectionId: 'connection-a',
        version: '0',
        input: { limit: 1, order: ref(commerce.order.id) },
      }),
    ).toMatchObject({ ok: true });
  });
  it.each([
    ['IN_PROGRESS', 1, 'processing'],
    ['CLOSED', 0, 'completed'],
  ])(
    'retains total quantity for %s work and accepts it for ingestion',
    async (status, remaining, expected) => {
      const f = fixture();
      f.data.work[0]!.status = status;
      f.data.workLines[0]!.remainingQuantity = Number(remaining);
      f.data.workLines[0]!.totalQuantity = 3;
      const result = await f.read('fulfillment.read');
      expect(result).toMatchObject({
        ok: true,
        value: {
          items: [
            {
              data: {
                status: expected,
                lines: [{ quantity: { amount: '3' } }],
              },
            },
            {
              data: {
                status: 'shipped',
                lines: [{ quantity: { amount: '1' } }],
              },
            },
          ],
        },
      });
      if (!result.ok) throw new Error('Expected successful fulfillment read');
      for (const observation of result.value.items) {
        expect(() =>
          commerceSchema.parse({
            capability: 'fulfillment.read',
            observation: {
              ...observation,
              source: {
                ...observation.source,
                tenantId: '00000000-0000-4000-8000-000000000001',
                connectionId: '00000000-0000-4000-8000-000000000002',
              },
            },
          }),
        ).not.toThrow();
      }
    },
  );
  it('preserves unknown statuses and untracked stock', async () => {
    const f = fixture();
    f.data.inventoryItem.tracked = false;
    f.data.order.displayFinancialStatus = 'constructor';
    f.data.work[0]!.status = 'UNRECOGNIZED';
    f.data.product.status = 'DRAFT';
    expect(await f.read('inventory.read')).toMatchObject({
      ok: true,
      value: {
        items: [
          {
            data: {
              available: null,
              onHand: null,
              reserved: null,
              availabilityBasis: 'unknown',
            },
          },
          { data: { available: null } },
        ],
      },
    });
    expect(await f.read('orders.read')).toMatchObject({
      ok: true,
      value: { items: [{ data: { paymentStatus: 'unknown' } }] },
    });
    expect(await f.read('products.read')).toMatchObject({
      ok: true,
      value: { items: [{ data: { status: 'unknown' } }] },
    });
    expect(await f.read('fulfillment.read')).toMatchObject({
      ok: true,
      value: {
        items: [
          { data: { status: 'unknown' } },
          { data: { status: 'shipped' } },
        ],
      },
    });
  });
  it('fails the whole page when a nested fetch fails, without publishing observations', async () => {
    const f = fixture();
    const fallback = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url, init) =>
      String(init?.body).includes('children: lineItems')
        ? Response.json({
            errors: [
              { message: 'secret', extensions: { code: 'ACCESS_DENIED' } },
            ],
          })
        : fallback(url, init),
    );
    expect(await f.read('orders.read')).toMatchObject({
      ok: false,
      error: { code: 'permission_denied' },
    });
    expect(f.recordObservations).not.toHaveBeenCalled();
  });
  it('rejects malformed provider data and repeated nested cursors', async () => {
    const f = fixture();
    f.data.levels[0]!.quantities[0]!.quantity = 0.5;
    expect(await f.read('inventory.read')).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' },
    });
    const g = fixture();
    const fallback = g.fetch.getMockImplementation()!;
    g.fetch.mockImplementation(async (url, init) =>
      String(init?.body).includes('children:')
        ? response({ node: { children: page([], 'same') } })
        : fallback(url, init),
    );
    expect(await g.read('orders.read')).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' },
    });
    expect(g.recordObservations).not.toHaveBeenCalled();
  });
  it('rejects cross-tenant or inactive connections and unsupported writes before network access', async () => {
    const f = fixture();
    expect(
      await f.runtime.read({ ...context, tenantId: 'other' } as TenantContext, {
        capability: 'orders.read',
        connectionId: 'connection-a',
        version: '0',
        input: { limit: 10 },
      }),
    ).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    f.connection.status = 'revoked';
    expect(await f.read('orders.read')).toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    });
    f.connection.status = 'active';
    expect(
      await f.runtime.write(context, {
        capability: 'orders.write',
        connectionId: 'connection-a',
        version: '0',
        idempotencyKey: 'key',
        input: {
          order: ref(commerce.order.id),
          operation: 'cancel',
          expectedRevision: '1',
        },
      }),
    ).toMatchObject({ ok: false, error: { code: 'unsupported_capability' } });
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it('validates destinations and inputs before resolving credentials', async () => {
    expect(() => fixture({ shop: 'example.myshopify.com.evil.test' })).toThrow(
      'invalid_input',
    );
    const f = fixture();
    expect(await f.read('orders.read', { limit: 101 })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(f.accessToken).not.toHaveBeenCalled();
  });
  it('allowlists captured payloads, defaults raw capture off, and fails closed on storage failure', async () => {
    const f = fixture({ rawRetentionMs: 1000 });
    Object.assign(f.data.order, {
      email: 'private@example.com',
      accessToken: 'secret',
    });
    await f.read('orders.read');
    expect(JSON.stringify(f.recordObservations.mock.calls)).not.toMatch(
      /private@example|secret/,
    );
    const g = fixture();
    await g.read('orders.read');
    expect(g.recordObservations.mock.calls[0]![0]).not.toHaveProperty('raw');
    g.recordObservations.mockRejectedValueOnce(
      new Error('storage unavailable'),
    );
    expect(await g.read('orders.read')).toMatchObject({
      ok: false,
      error: { code: 'internal' },
    });
  });
});

describe('Shopify failures', () => {
  it('returns retry advice when token storage fails without dispatching or exposing the error', async () => {
    const f = fixture();
    f.accessToken.mockRejectedValueOnce(
      new Error('secret-store unavailable: private-token'),
    );
    expect(await f.read('orders.read')).toEqual({
      ok: false,
      error: {
        code: 'transient',
        effect: 'none',
        retry: 'after_delay',
        retryAfterMs: 1000,
      },
    });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.recordObservations).not.toHaveBeenCalled();
    expect(JSON.stringify(f.record.mock.calls)).not.toContain('private-token');
    expect(await f.read('orders.read')).toMatchObject({ ok: true });
  });
  it('preserves classified token errors and treats empty credentials as authentication failures', async () => {
    const f = fixture();
    const failure = {
      code: 'authentication',
      effect: 'none',
      retry: 'never',
    } as const;
    f.accessToken.mockRejectedValueOnce(new ConnectorError(failure));
    expect(await f.read('orders.read')).toEqual({ ok: false, error: failure });
    f.accessToken.mockResolvedValueOnce('');
    expect(await f.read('orders.read')).toEqual({ ok: false, error: failure });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'authentication'],
    [403, 'permission_denied'],
    [404, 'not_found'],
    [429, 'rate_limited'],
    [500, 'transient'],
    [400, 'invalid_response'],
  ] as const)(
    'normalizes HTTP %s without exposing provider content',
    async (status, code) => {
      const f = fixture();
      f.fetch.mockResolvedValueOnce(
        new Response('private provider message', {
          status,
          headers: { 'retry-after': '2' },
        }),
      );
      const result = await f.read('orders.read');
      expect(result).toMatchObject({
        ok: false,
        error: { code, effect: 'none' },
      });
      if (status === 429)
        expect(result).toMatchObject({
          error: { retryAfterMs: 2000, retry: 'after_delay' },
        });
      expect(JSON.stringify([result, f.record.mock.calls])).not.toContain(
        'private provider message',
      );
      expect(f.fetch).toHaveBeenCalledTimes(1);
    },
  );
  it('uses GraphQL throttle cost and rejects partial GraphQL success', async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(
      Response.json({
        data: { page: page([]) },
        errors: [{ message: 'private', extensions: { code: 'THROTTLED' } }],
        extensions: {
          cost: {
            requestedQueryCost: 100,
            throttleStatus: { currentlyAvailable: 10, restoreRate: 20 },
          },
        },
      }),
    );
    expect(await f.read('orders.read')).toEqual({
      ok: false,
      error: {
        code: 'rate_limited',
        effect: 'none',
        retry: 'after_delay',
        retryAfterMs: 4500,
      },
    });
    expect(f.recordObservations).not.toHaveBeenCalled();
  });
  it.each([
    ['TimeoutError', 'timeout'],
    ['TypeError', 'transient'],
  ])('normalizes %s', async (name, code) => {
    const f = fixture();
    f.fetch.mockRejectedValueOnce(
      Object.assign(new Error('private'), { name }),
    );
    expect(await f.read('orders.read')).toMatchObject({
      ok: false,
      error: { code, effect: 'none', retry: 'after_delay' },
    });
  });
  it('rejects malformed JSON and silent API version fallback', async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(new Response('not JSON'));
    expect(await f.read('orders.read')).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' },
    });
    f.fetch.mockResolvedValueOnce(
      Response.json(
        { data: {} },
        { headers: { 'x-shopify-api-version': '2027-01' } },
      ),
    );
    expect(await f.read('orders.read')).toMatchObject({
      ok: false,
      error: { code: 'unsupported_version' },
    });
  });
});

describe('Shopify webhook refresh hints', () => {
  const body = Buffer.from(
    '{"id":9007199254740993,"email":"private@example.com"}',
  );
  const options = {
    tenantId: 'tenant-a',
    connectionId: 'connection-a',
    expectedShop: 'example.myshopify.com',
    shop: 'example.myshopify.com',
    secret: 'webhook-secret',
    hmac: createHmac('sha256', 'webhook-secret').update(body).digest('base64'),
    eventId: 'event-1',
    topic: 'orders/updated',
    body,
  };
  it('verifies original bytes and creates a scoped, stable refresh key without copying partial data', () => {
    const event = mapShopifyWebhook(options);
    expect(event).toEqual(mapShopifyWebhook(options));
    expect(event?.capabilities).toEqual(['orders.read', 'fulfillment.read']);
    expect(JSON.stringify(event)).not.toMatch(
      /private@example|9007199254740993/,
    );
    expect(
      mapShopifyWebhook({ ...options, connectionId: 'connection-b' })?.eventKey,
    ).not.toBe(event?.eventKey);
    expect(mapShopifyWebhook({ ...options, topic: 'unknown' })).toBeNull();
    expect(mapShopifyWebhook({ ...options, topic: 'constructor' })).toBeNull();
  });
  it('rejects bad signatures, modified payloads and wrong shops', () => {
    expect(() => mapShopifyWebhook({ ...options, hmac: '' })).toThrow(
      'authentication',
    );
    expect(() =>
      mapShopifyWebhook({ ...options, body: Buffer.from('{}') }),
    ).toThrow('authentication');
    expect(() =>
      mapShopifyWebhook({ ...options, shop: 'other.myshopify.com' }),
    ).toThrow('authentication');
  });
});

describe('Shopify history import reads', () => {
  it('reports the 60-day order window, collection size and changed-record filters', async () => {
    const f = fixture();
    const first = await f.read('orders.read', {
      limit: 10,
      updatedSince: '2026-09-01T00:00:00.000Z',
    } as { limit: number });
    expect(first).toMatchObject({
      ok: true,
      value: {
        total: 1,
        history: {
          availableFrom: '2026-07-19T01:00:00.000Z',
          requirement: 'read_all_orders',
        },
      },
    });
    const request = f.fetch.mock.calls
      .map(([, init]) => JSON.parse(String(init?.body)))
      .find((body: { query: string }) => body.query.includes('LumaPage'));
    expect(request.variables.query).toBe(
      "updated_at:>='2026-09-01T00:00:00.000Z'",
    );
    expect(request.query).toContain('sortKey: UPDATED_AT');
    expect(
      (await f.runtime.discover(context, 'connection-a')).find(
        (item) => item.capability === 'inventory.read',
      )?.filters,
    ).toBeUndefined();

    f.data.scopes.push({ handle: 'read_all_orders' });
    const full = await f.read('orders.read');
    expect(full.ok && full.value.history).toBeNull();
  });

  it('reads customers only when approved and withholds unapproved fields', async () => {
    expect(
      (await fixture().runtime.discover(context, 'connection-a')).some(
        (item) => item.capability === 'customers.read',
      ),
    ).toBe(false);
    const contactOnly = fixture({
      customerAccess: { contact: true, address: false },
    });
    const result = await contactOnly.read('customers.read');
    expect(result).toMatchObject({
      ok: true,
      value: {
        total: 1,
        items: [
          {
            source: {
              resource: 'customer',
              externalId: 'gid://shopify/Customer/7',
            },
            sourceUpdatedAt: '2026-09-10T09:00:00Z',
            data: {
              displayName: 'Ada Lovelace',
              email: 'ada@example.test',
              phone: null,
              address: null,
              state: 'enabled',
              orderCount: 4,
              amountSpent: { amount: '120.50', currency: 'EUR' },
              tags: ['vip'],
              shared: { contact: true, address: false },
            },
          },
        ],
      },
    });
    const query = contactOnly.fetch.mock.calls
      .map(([, init]) => JSON.parse(String(init?.body)).query as string)
      .find((text) => text.includes('LumaCustomers'));
    expect(query).toContain('defaultEmailAddress');
    expect(query).not.toContain('defaultAddress');
  });
});

describe('Shopify query contract', () => {
  // Pin the fixture independently so changing the API version requires a schema refresh.
  const schemaVersion = '2026-07';
  const schema = buildSchema(
    readFileSync(
      new URL('./fixtures/admin-2026-07.graphql', import.meta.url),
      'utf8',
    ),
  );

  it('validates all emitted operations against the matching Shopify schema', async () => {
    expect(API_VERSION).toBe(schemaVersion);
    const f = fixture();
    const customers = fixture({
      customerAccess: { contact: true, address: true },
    });
    for (const capability of [
      'orders.read',
      'products.read',
      'inventory.read',
      'fulfillment.read',
    ] as const) {
      expect(await f.read(capability)).toMatchObject({ ok: true });
      expect(
        await f.read(capability, {
          limit: 10,
          ...(capability === 'inventory.read'
            ? {}
            : { updatedSince: '2026-09-01T00:00:00.000Z' }),
        }),
      ).toMatchObject({ ok: true });
    }
    expect(await customers.read('customers.read')).toMatchObject({ ok: true });
    const operations = new Set(
      [...f.fetch.mock.calls, ...customers.fetch.mock.calls].map(
        ([, init]) =>
          (JSON.parse(String(init?.body)) as { query: string }).query,
      ),
    );
    expect(operations.size).toBe(20);
    for (const query of operations) {
      expect(
        validate(schema, parse(query)).map((error) => error.message),
        query,
      ).toEqual([]);
    }
  });

  it.each([
    'query { orders(first: 1) { nodes { misspelledField } } }',
    'query { orders(invalidArgument: 1) { nodes { id } } }',
    'query($first: String) { orders(first: $first) { nodes { id } } }',
  ])('rejects incompatible operations: %s', (query) => {
    expect(validate(schema, parse(query)).length).toBeGreaterThan(0);
  });
});

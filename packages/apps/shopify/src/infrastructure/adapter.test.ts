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
import { returnNode } from './schemas.js';
import { mapShopifyWebhook } from './webhooks.js';

// Reads repeat after transient failures; tests skip the waits.
const readRetry = {
  attempts: 3,
  maxDelayMs: 2000,
  sleep: async () => undefined,
};

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
  const data = {
    ...structuredClone(commerce),
    returns: commerce.returns.map((item) => returnNode.parse(item)),
  };
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
    if (query.includes('LumaPage')) {
      const order = {
        ...data.order,
        lineItems: page(data.orderLines),
        shippingLines: page(data.shippingLines),
        discountApplications: page(data.discounts),
        fulfillmentOrders: page(
          data.work.map((item) => ({
            ...item,
            lineItems: page(data.workLines),
          })),
        ),
        fulfillments: data.shipments.map((item) => ({
          ...item,
          fulfillmentLineItems: page(data.shipmentLines),
        })),
        returns: page(
          data.returns.map((item) => ({
            ...item,
            returnLineItems: page(data.returnLines),
            reverseFulfillmentOrders: page(
              data.reverseOrders.map((reverse) => ({
                ...reverse,
                lineItems: page(data.reverseLines),
              })),
            ),
          })),
        ),
        refunds: data.refunds.map((item) => ({
          ...item,
          refundLineItems: page(data.refundLines),
          transactions: page(data.refundTransactions),
        })),
      };

      return response({
        page: page([
          query.includes('products(')
            ? { ...data.product, variants: page(data.variants) }
            : query.includes('inventoryItems(')
              ? { ...data.inventoryItem, inventoryLevels: page(data.levels) }
              : order,
        ]),
      });
    }
    if (query.includes('children:')) {
      const nodes = query.includes('children: returns(')
        ? data.returns
        : query.includes('children: shippingLines(')
          ? data.shippingLines
          : query.includes('children: discountApplications(')
            ? data.discounts
            : query.includes('returnLineItems(')
              ? data.returnLines
              : query.includes('reverseFulfillmentOrders(')
                ? data.reverseOrders
                : variables.id?.includes('/ReverseFulfillmentOrder/')
                  ? data.reverseLines
                  : query.includes('refundLineItems(')
                    ? data.refundLines
                    : query.includes('children: transactions(')
                      ? data.refundTransactions
                      : query.includes('inventoryLevels(')
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
            : query.includes('refunds {')
              ? { refunds: data.refunds }
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
    readRetry,
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
  it('discovers available capabilities, normalizes commerce reads and persists evidence before returning', async () => {
    const f = fixture({ rawRetentionMs: 3600000 });
    expect(
      (await f.runtime.discover(context, 'connection-a')).map(
        (item) => item.capability,
      ),
    ).toEqual([
      'returns.options.read',
      'returns.created.read',
      'returns.create',

      'returns.settlement.quote.read',
      'returns.settlement.proof.read',
      'returns.refund',
      'returns.exchange.options.read',
      'returns.exchange.quote.read',
      'returns.exchange.proof.read',
      'returns.exchange.price.read',
      'returns.exchange.request',
      'returns.exchange.process',
      'returns.exchange.cancel',
      'returns.exchange.release',

      'orders.read',
      'products.read',
      'inventory.read',
      'inventory.transfers.read',
      'inventory.shipments.read',
      'fulfillment.read',
      'returns.read',
    ]);
    const orders = await f.read('orders.read');
    expect(orders).toMatchObject({
      ok: true,
      value: {
        completeness: 'complete',
        items: [
          {
            source: { provider: 'shopify', externalId: commerce.order.id },
            adapterVersion: 'shopify/12',
            data: {
              paymentStatus: 'paid',
              placedAt: '2026-09-14T08:30:00Z',
              total: { amount: '42.50', currency: 'EUR' },
              addresses: { shared: false },
              currencies: { shop: 'EUR', presentment: 'CHF' },
              amounts: {
                total: {
                  original: {
                    shop: { amount: '52.00', currency: 'EUR' },
                    presentment: { amount: '50.30', currency: 'CHF' },
                  },
                  current: {
                    shop: { amount: '42.50', currency: 'EUR' },
                    presentment: { amount: '41.10', currency: 'CHF' },
                  },
                },
                subtotal: {
                  current: { shop: { amount: '37.00', currency: 'EUR' } },
                },
                // A malformed amount is unknown, never a parse failure of the order.
                tax: {
                  original: { shop: { amount: '8.30' } },
                  current: null,
                },
                duties: { original: null, current: null },
              },
              taxesIncluded: true,
              dutiesIncluded: false,
              taxLines: [
                {
                  title: 'MwSt',
                  rate: '0.19',
                  amount: { presentment: { amount: '6.56', currency: 'CHF' } },
                },
              ],
              shippingLines: [
                {
                  id: 'gid://shopify/ShippingLine/71',
                  title: 'Standard',
                  code: 'STANDARD',
                  carrier: null,
                  removed: false,
                },
                {
                  title: 'Express',
                  carrier: 'dhl',
                  removed: true,
                  original: { shop: { amount: '9.90', currency: 'EUR' } },
                  current: { shop: { amount: '0.0', currency: 'EUR' } },
                },
              ],
              discounts: [
                {
                  index: 0,
                  kind: 'code',
                  label: 'WELCOME10',
                  target: 'line_item',
                  allocation: 'across',
                  value: { type: 'percentage', percentage: '10' },
                },
                {
                  kind: 'automatic',
                  label: 'Free mug',
                  allocation: 'each',
                  value: {
                    type: 'fixed',
                    amount: { amount: '2.00', currency: 'EUR' },
                  },
                },
                {
                  kind: 'manual',
                  label: 'Goodwill',
                  target: 'shipping_line',
                  value: { type: 'percentage', percentage: '12.5' },
                },
              ],
              tags: ['wholesale', 'priority'],
              attributes: {
                edited: true,
                requiresShipping: true,
                test: false,
                cancelReason: null,
                cancelledAt: null,
                closedAt: null,
                processedAt: '2026-09-14T08:30:05Z',
                channel: 'web',
                fulfillmentStatus: 'partially_fulfilled',
              },
              lines: [
                {
                  sku: ref(commerce.inventoryItem.id),
                  quantity: { amount: '3' },
                  currentQuantity: { amount: '3' },
                  cancelledQuantity: { amount: '0' },
                  unitPrice: { amount: '14.50', currency: 'EUR' },
                  taxIncluded: true,
                  taxRate: '0.19',
                  skuCode: 'MUG-Blue',
                  title: 'Blue mug',
                  variantTitle: 'Blue',
                  requiresShipping: true,
                  catalog: 'variant',
                  prices: {
                    originalUnit: {
                      shop: { amount: '14.50', currency: 'EUR' },
                      presentment: { amount: '14.03', currency: 'CHF' },
                    },
                    discountedUnit: { shop: { amount: '13.05' } },
                    totalDiscount: { shop: { amount: '4.35' } },
                  },
                },
                {
                  sku: null,
                  skuCode: null,
                  title: null,
                  unitPrice: null,
                  taxIncluded: null,
                  taxRate: null,
                  variantTitle: null,
                  requiresShipping: false,
                  // No variant and no product: a custom item or a deleted product.
                  catalog: 'no_product',
                },
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
              title: 'Blue mug',
              status: 'active',
              vendor: 'Harbor Ceramics',
              published: true,
              skus: [
                {
                  id: ref(commerce.inventoryItem.id),
                  code: 'MUG-Blue',
                  title: 'Blue',
                  price: { amount: '14.50', currency: 'EUR' },
                  barcode: '0012345678905',
                },
              ],
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
            data: {
              onHand: '3',
              committed: '5',
              reserved: '1',
              available: '-2',
              incoming: '7',
              damaged: '0',
              qualityControl: '2',
              safetyStock: '3',
              locationActive: true,
              itemActive: false,
              tracked: true,
              inventorySemantics: 'shopify/1',
            },
          },
          { data: { onHand: null, reserved: null, available: '0' } },
        ],
      },
    });
    // A second fulfillment order is on hold, with one reason Luma does not name.
    const work: Record<string, unknown>[] = f.data.work;
    work.push({
      ...commerce.work[0]!,
      id: 'gid://shopify/FulfillmentOrder/52',
      status: 'ON_HOLD',
      fulfillmentHolds: [
        { reason: 'INCORRECT_ADDRESS' },
        { reason: 'ONLINE_STORE_POST_PURCHASE_CROSS_SELL' },
      ],
    });
    expect(await f.read('fulfillment.read')).toMatchObject({
      ok: true,
      value: {
        items: [
          {
            source: { externalId: commerce.work[0]!.id },
            data: {
              status: 'processing',
              kind: 'fulfillment_order',
              holds: [],
            },
          },
          {
            source: { externalId: 'gid://shopify/FulfillmentOrder/52' },
            data: {
              status: 'pending',
              kind: 'fulfillment_order',
              lines: [{ quantity: { amount: '2' } }],
              lastProgressAt: '2026-09-15T00:00:00Z',
              holds: [{ reason: 'incorrect_address' }, { reason: 'other' }],
              location: {
                id: ref('gid://shopify/Location/41'),
                name: 'Tokyo warehouse',
              },
              fulfillAt: null,
              fulfillBy: '2026-09-18T00:00:00Z',
              method: { type: 'shipping', name: 'Express' },
            },
          },
          {
            source: { externalId: commerce.shipments[0]!.id },
            data: {
              status: 'shipped',
              kind: 'shipment',
              lines: [{ quantity: { amount: '1' } }],
              location: {
                id: ref('gid://shopify/Location/41'),
                name: 'Tokyo warehouse',
              },
              estimatedDeliveryAt: '2026-09-17T00:00:00Z',
              // Entries without a number or web link are not tracking.
              tracking: [
                {
                  carrier: 'Yamato',
                  number: '4521-8876-0012',
                  url: 'https://tracking.example.test/4521-8876-0012',
                },
              ],
              delivery: 'attempted_delivery',
            },
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
      if (query.includes('LumaPage'))
        return response({
          page: page([
            {
              ...commerce.order,
              lineItems: page([commerce.orderLines[0]], 'line-page-2'),
              shippingLines: page(commerce.shippingLines),
              discountApplications: page([]),
            },
          ]),
        });
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
    // Scan start, nested root page and one overflow page.
    expect(f.fetch).toHaveBeenCalledTimes(3);
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
  it('reads stock-bearing composition only when requested and retains unavailable composition as unknown', async () => {
    const f = fixture(),
      fallback = f.fetch.getMockImplementation()!;
    let variant: unknown = {
      id: 'gid://shopify/ProductVariant/900',
      requiresComponents: false,
      productVariantComponents: page([]),
    };
    f.fetch.mockImplementation(async (url, init) => {
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      if (
        query.includes('LumaPage') &&
        query.includes('inventoryItems') &&
        query.includes('productVariantComponents')
      )
        return response({
          page: page([
            {
              ...f.data.inventoryItem,
              variant,
              inventoryLevels: page(f.data.levels),
            },
          ]),
        });
      if (
        query.includes('... on InventoryItem') &&
        query.includes('productVariantComponents')
      )
        return response({ node: { ...f.data.inventoryItem, variant } });

      return fallback(url, init);
    });
    const plain = await f.read('inventory.read');
    expect(plain.ok && plain.value.items[0]?.data).not.toHaveProperty(
      'composition',
    );
    expect(
      f.fetch.mock.calls.every(
        (call) => !String(call[1]?.body).includes('productVariantComponents'),
      ),
    ).toBe(true);
    const input = { limit: 10, includeComposition: true };

    async function composition() {
      const result = await f.read('inventory.read', input);
      if (!result.ok) throw new Error(result.error.code);

      return result.value.items[0]?.data.composition;
    }

    expect(await composition()).toEqual({
      variant: ref('gid://shopify/ProductVariant/900'),
      requiresComponents: false,
      hasComponents: false,
    });
    variant = {
      id: 'gid://shopify/ProductVariant/900',
      requiresComponents: true,
      productVariantComponents: page(
        [{ id: 'gid://shopify/ProductVariantComponent/1' }],
        'more',
      ),
    };
    expect(await composition()).toMatchObject({
      requiresComponents: true,
      hasComponents: true,
    });
    variant = null;
    expect(await composition()).toBeNull();
    variant = undefined;
    expect(await f.read('inventory.read', input)).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' },
    });
    f.data.scopes = f.data.scopes.filter(
      (scope) => !['read_products', 'write_products'].includes(scope.handle),
    );
    expect(await f.read('inventory.read', input)).toMatchObject({
      ok: false,
      error: { code: 'permission_denied' },
    });
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
    ['IN_PROGRESS', 1, 3, 'processing'],
    ['CLOSED', 0, 3, 'completed'],
    ['CANCELLED', 0, 0, 'cancelled'],
  ])(
    'retains total quantity for %s work and accepts it for ingestion',
    async (status, remaining, total, expected) => {
      const f = fixture();
      f.data.work[0]!.status = status;
      f.data.workLines[0]!.remainingQuantity = Number(remaining);
      f.data.workLines[0]!.totalQuantity = Number(total);
      const result = await f.read('fulfillment.read');
      expect(result).toMatchObject({
        ok: true,
        value: {
          items: [
            {
              data: {
                status: expected,
                lines: [
                  {
                    quantity: { amount: String(total) },
                    remainingQuantity: { amount: String(remaining) },
                  },
                ],
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
    f.data.product.status = 'UNLISTED';
    expect(await f.read('inventory.read')).toMatchObject({
      ok: true,
      value: {
        items: [
          {
            data: {
              available: null,
              onHand: null,
              reserved: null,
              committed: null,
              incoming: null,
              damaged: null,
              qualityControl: null,
              safetyStock: null,
              tracked: false,
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
  it('reads draft products and treats missing catalog facts as unknown', async () => {
    const f = fixture();
    Object.assign(f.data.product, {
      status: 'DRAFT',
      publishedAt: null,
      priceRangeV2: null,
      vendor: ' ',
    });
    Object.assign(f.data.variants[0]!, {
      title: 'Default Title',
      price: 'not-a-price',
      barcode: null,
    });
    expect(await f.read('products.read')).toMatchObject({
      ok: true,
      value: {
        items: [
          {
            data: {
              status: 'draft',
              vendor: null,
              published: false,
              skus: [{ title: null, price: null, barcode: null }],
            },
          },
        ],
      },
    });
    f.data.variants[0]!.price = '14.50';
    expect(await f.read('products.read')).toMatchObject({
      value: {
        items: [
          { data: { skus: [{ price: { amount: '14.50', currency: null } }] } },
        ],
      },
    });
  });
  it('fails the whole page when a nested fetch fails, without publishing observations', async () => {
    const f = fixture();
    const fallback = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url, init) =>
      String(init?.body).includes('LumaPage')
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
      String(init?.body).includes('LumaPage')
        ? response({
            page: page([{ ...commerce.order, lineItems: page([], 'same') }]),
          })
        : String(init?.body).includes('children:')
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
    f.accessToken.mockRejectedValue(
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
    f.accessToken.mockResolvedValue('private-token');
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
      f.fetch.mockImplementation(
        async () =>
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
      expect(f.fetch).toHaveBeenCalledTimes(
        status === 429 || status === 500 ? 3 : 1,
      );
    },
  );
  it('repeats a query after a transient failure', async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(new Response('', { status: 502 }));
    expect(await f.read('orders.read')).toMatchObject({ ok: true });
  });
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
    f.fetch.mockRejectedValue(Object.assign(new Error('private'), { name }));
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

describe('Shopify edited order lines', () => {
  it.each([1, 0])(
    'retains original units and reads %s current units',
    async (current) => {
      const f = fixture();
      f.data.orderLines[0]!.quantity = 2;
      f.data.orderLines[0]!.currentQuantity = current;
      const result = await f.read('orders.read');
      expect(result).toMatchObject({
        ok: true,
        value: {
          items: [
            {
              data: {
                lines: [
                  {
                    quantity: { amount: '2' },
                    currentQuantity: { amount: String(current) },
                    cancelledQuantity: { amount: String(2 - current) },
                  },
                  {},
                ],
              },
            },
          ],
        },
      });
      if (!result.ok) throw new Error('Expected order read');
      const item = result.value.items[0]!;
      const observation = {
        ...item,
        source: {
          ...item.source,
          tenantId: '00000000-0000-4000-8000-000000000001',
          connectionId: '00000000-0000-4000-8000-000000000002',
        },
      };
      // Sync removes addresses before recording; recorded evidence refuses them.
      expect(() =>
        commerceSchema.parse({ capability: 'orders.read', observation }),
      ).toThrow();
      const data = { ...item.data };
      delete data.addresses;
      expect(() =>
        commerceSchema.parse({
          capability: 'orders.read',
          observation: { ...observation, data },
        }),
      ).not.toThrow();
    },
  );
  it.each([-1, 4, null])(
    'rejects invalid current quantity %s',
    async (current) => {
      const f = fixture();
      Object.assign(f.data.orderLines[0]!, { currentQuantity: current });
      expect(await f.read('orders.read')).toMatchObject({
        ok: false,
        error: { code: 'invalid_response' },
      });
      expect(f.recordObservations).not.toHaveBeenCalled();
    },
  );
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
    expect(event?.capabilities).toEqual([
      'orders.read',
      'fulfillment.read',
      'returns.read',
    ]);
    expect(JSON.stringify(event)).not.toMatch(
      /private@example|9007199254740993/,
    );
    expect(
      mapShopifyWebhook({ ...options, connectionId: 'connection-b' })?.eventKey,
    ).not.toBe(event?.eventKey);
    expect(mapShopifyWebhook({ ...options, topic: 'unknown' })).toBeNull();
    expect(mapShopifyWebhook({ ...options, topic: 'constructor' })).toBeNull();
  });
  it.each([
    'orders/edited',
    'fulfillment_orders/moved',
    'fulfillment_orders/split',
    'fulfillment_orders/merged',
    'fulfillment_orders/cancelled',
  ])('rereads orders and fulfillment work after %s', (topic) => {
    const event = mapShopifyWebhook({ ...options, topic });
    expect(event?.capabilities).toEqual(['orders.read', 'fulfillment.read']);
    expect(event?.eventKey).not.toBe(mapShopifyWebhook(options)?.eventKey);
    expect(event).toEqual(mapShopifyWebhook({ ...options, topic }));
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

describe('Shopify returns and refunds', () => {
  it('reads returns with receipts and refunds with payment outcomes, only for orders that have them', async () => {
    const f = fixture();
    const result = await f.read('returns.read');
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    const [returned, refund] = result.value.items;
    expect(result.value.items).toHaveLength(2);
    expect(returned).toMatchObject({
      source: { resource: 'return', externalId: 'gid://shopify/Return/91' },
      // Shopify reports no update time for returns; ordering uses the read time.
      sourceUpdatedAt: null,
      data: {
        type: 'return',
        order: ref(commerce.order.id),
        name: '#1001-R1',
        status: 'open',
        requestedAt: '2026-09-18T09:00:00Z',
        approvedAt: '2026-09-18T10:00:00Z',
        declineReason: null,
        receivedAt: '2026-09-19T08:00:00Z',
        lines: [
          {
            orderLine: {
              externalId: 'gid://shopify/LineItem/11',
              scopeKey: commerce.order.id,
            },
            quantity: { amount: '2', unit: 'each' },
            reason: 'Size too small',
            // A missing unit was not received.
            receivedQuantity: '1',
            restockedQuantity: '1',
            refundedQuantity: '1',
            value: { amount: '29.00', currency: 'EUR' },
          },
          {
            orderLine: null,
            reason: null,
            receivedQuantity: null,
            restockedQuantity: null,
            refundedQuantity: '0',
            value: null,
          },
        ],
      },
    });
    expect(refund).toMatchObject({
      source: { resource: 'refund', externalId: 'gid://shopify/Refund/96' },
      sourceUpdatedAt: '2026-09-19T10:05:00Z',
      data: {
        type: 'refund',
        return: ref('gid://shopify/Return/91'),
        total: { amount: '14.50', currency: 'EUR' },
        lines: [
          { quantity: { amount: '1' }, restock: 'return', restocked: true },
        ],
        // Sales are not refunds; awaiting a response is pending, not returned money.
        transactions: [
          { status: 'failed', amount: { amount: '14.50', currency: 'EUR' } },
          { status: 'pending', processedAt: null },
        ],
      },
    });
    expect(
      commerceSchema.safeParse({
        capability: 'returns.read',
        observation: {
          ...returned,
          source: {
            ...returned!.source,
            tenantId: crypto.randomUUID(),
            connectionId: crypto.randomUUID(),
          },
          id: crypto.randomUUID(),
        },
      }).success,
    ).toBe(true);
    // The order without returns or refunds is not read further.
    const bodies = f.fetch.mock.calls.map(([, init]) => String(init?.body));
    expect(bodies.some((body) => body.includes('Order/2'))).toBe(false);
  });

  it('maps declined returns and unknown statuses without guessing', async () => {
    const f = fixture();
    const returned = f.data.returns[0]!;
    returned.status = 'DECLINED';
    returned.decline = { reason: 'FINAL_SALE' };
    returned.closedAt = '2026-09-19T00:00:00Z';
    f.data.returns.push({
      ...returned,
      id: 'gid://shopify/Return/90',
      status: 'NEW',
    });
    f.data.refunds.splice(0);
    const result = await f.read('returns.read');
    expect(
      result.ok && result.value.items.map((item) => item.data),
    ).toMatchObject([
      { status: 'declined', declineReason: 'final_sale' },
      { status: 'unknown' },
    ]);
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
    ).toEqual(['historyImport', 'confirmMissing']);

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

  it('reports who placed each order only with customer access and a customer grant', async () => {
    const queries = (f: ReturnType<typeof fixture>) =>
      f.fetch.mock.calls.map(
        ([, init]) => JSON.parse(String(init?.body)).query as string,
      );
    const unapproved = fixture({ orderCustomers: true });
    Object.assign(unapproved.data.order, {
      customer: { id: 'gid://shopify/Customer/7' },
    });
    const plain = await unapproved.read('orders.read');
    expect(plain.ok && plain.value.items[0]!.data).not.toHaveProperty(
      'customer',
    );
    expect(queries(unapproved).some((q) => q.includes('customer {'))).toBe(
      false,
    );

    const f = fixture({
      customerAccess: { contact: false, address: false },
      orderCustomers: true,
    });
    Object.assign(f.data.order, {
      customer: { id: 'gid://shopify/Customer/7' },
    });
    expect(await f.read('orders.read')).toMatchObject({
      ok: true,
      value: {
        items: [{ data: { customer: ref('gid://shopify/Customer/7') } }],
      },
    });
    expect(queries(f).some((q) => q.includes('customer { id }'))).toBe(true);
    // Guest checkouts have no customer.
    Object.assign(f.data.order, { customer: null });
    expect(await f.read('orders.read')).toMatchObject({
      ok: true,
      value: { items: [{ data: { customer: null } }] },
    });
  });
  it('reads order addresses only with address approval and never captures them as evidence', async () => {
    const queries = (f: ReturnType<typeof fixture>) =>
      f.fetch.mock.calls.map(
        ([, init]) => JSON.parse(String(init?.body)).query as string,
      );
    const unapproved = fixture({
      customerAccess: { contact: true, address: false },
    });
    expect(await unapproved.read('orders.read')).toMatchObject({
      ok: true,
      value: { items: [{ data: { addresses: { shared: false } } }] },
    });
    expect(queries(unapproved).some((q) => q.includes('shippingAddress'))).toBe(
      false,
    );

    const f = fixture({
      customerAccess: { contact: false, address: true },
      rawRetentionMs: 1000,
    });
    expect(await f.read('orders.read')).toMatchObject({
      ok: true,
      value: {
        items: [
          {
            data: {
              addresses: {
                shared: true,
                shipping: {
                  line1: 'Hafenstrasse 1',
                  line2: null,
                  city: 'Hamburg',
                  region: 'HH',
                  postalCode: '20457',
                  country: 'DE',
                },
                billing: null,
              },
            },
          },
        ],
      },
    });
    expect(queries(f).some((q) => q.includes('shippingAddress {'))).toBe(true);
    const raw = f.recordObservations.mock.calls[0]![0].raw;
    expect(raw?.payloads.length).toBeGreaterThan(0);
    expect(JSON.stringify(raw)).not.toMatch(/Hafenstrasse|20457/);
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
      'returns.read',
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
    const buyers = fixture({
      customerAccess: { contact: false, address: true },
      orderCustomers: true,
    });
    expect(await buyers.read('orders.read')).toMatchObject({ ok: true });
    const operations = new Set(
      [
        ...f.fetch.mock.calls,
        ...customers.fetch.mock.calls,
        ...buyers.fetch.mock.calls,
      ].map(
        ([, init]) =>
          (JSON.parse(String(init?.body)) as { query: string }).query,
      ),
    );
    expect(operations.size).toBe(15);
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

describe('Shopify independent deletion confirmation', () => {
  const schema = buildSchema(
    readFileSync(
      new URL('./fixtures/admin-2026-07.graphql', import.meta.url),
      'utf8',
    ),
  );

  function confirmationFixture(
    options: {
      scopes?: string[];
      present?: boolean;
      connected?: boolean;
      errors?: boolean;
      persistFailure?: boolean;
    } = {},
  ) {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      expect(
        validate(schema, parse(query)).map((error) => error.message),
      ).toEqual([]);
      if (query.includes('LumaDeletionAccess'))
        return response({
          currentAppInstallation: {
            accessScopes: (
              options.scopes ?? [
                'read_orders',
                'read_all_orders',
                'read_products',
                'read_inventory',
              ]
            ).map((handle) => ({ handle })),
          },
        });
      if (options.errors)
        return Response.json({
          data: { node: null },
          errors: [
            { message: 'Denied', extensions: { code: 'ACCESS_DENIED' } },
          ],
        });
      if (query.includes('LumaDeletionLevel'))
        return response({
          node: {
            inventoryLevel: options.connected
              ? { id: 'gid://shopify/InventoryLevel/1' }
              : null,
          },
        });

      return response({
        node: options.present
          ? {
              id: query.includes('InventoryItem')
                ? 'gid://shopify/InventoryItem/1'
                : query.includes('Product')
                  ? 'gid://shopify/Product/1'
                  : 'gid://shopify/Order/1',
            }
          : null,
      });
    });

    return {
      ...fixture({
        fetch,
        ...(options.persistFailure
          ? {
              recordObservations: async () => {
                throw new Error('Evidence unavailable');
              },
            }
          : {}),
      }),
      fetch,
    };
  }

  it.each(['orders.read', 'products.read', 'inventory.read'] as const)(
    'confirms absence through a fresh point read for %s',
    async (capability) => {
      const f = confirmationFixture();
      const result = await f.runtime.read(context, {
        capability,
        connectionId: f.connection.id,
        version: '0',
        input: {
          limit: 1,
          confirmMissing: {
            externalId: `gid://shopify/${capability === 'orders.read' ? 'Order' : capability === 'products.read' ? 'Product' : 'InventoryItem'}/1`,
            scopeKey:
              capability === 'inventory.read' ? 'gid://shopify/Location/1' : '',
            createdAt: '2026-09-01T00:00:00Z',
          },
        },
      });
      expect(result).toMatchObject({
        ok: true,
        value: {
          confirmation: 'deleted',
          items: [{ kind: 'tombstone', sourceUpdatedAt: null }],
        },
      });
      expect(f.recordObservations).toHaveBeenCalledOnce();
      expect(result.ok, JSON.stringify(result)).toBe(true);
    },
  );
  it('confirms a disconnected level independently from its readable inventory item', async () => {
    const f = confirmationFixture({ present: true });
    expect(
      await f.runtime.read(context, {
        connectionId: f.connection.id,
        capability: 'inventory.read',
        version: '0',
        input: {
          limit: 1,
          confirmMissing: {
            externalId: 'gid://shopify/InventoryItem/1',
            scopeKey: 'gid://shopify/Location/1',
            createdAt: null,
          },
        },
      }),
    ).toMatchObject({ ok: true, value: { confirmation: 'deleted' } });
    expect(f.fetch).toHaveBeenCalledTimes(3);
  });
  it.each([null, '2026-01-01T00:00:00Z'])(
    'does not retire history-limited orders created at %s',
    async (createdAt) => {
      const f = confirmationFixture({ scopes: ['read_orders'] });
      expect(
        await f.runtime.read(context, {
          connectionId: f.connection.id,
          capability: 'orders.read',
          version: '0',
          input: {
            limit: 1,
            confirmMissing: {
              externalId: 'gid://shopify/Order/1',
              scopeKey: '',
              createdAt,
            },
          },
        }),
      ).toMatchObject({
        ok: true,
        value: { confirmation: 'history_limited', items: [] },
      });
      expect(f.fetch).toHaveBeenCalledOnce();
      expect(f.recordObservations).not.toHaveBeenCalled();
    },
  );
  it.each([{ scopes: [] }, { errors: true }, { persistFailure: true }])(
    'rejects scope loss, partial errors and failed evidence persistence: %j',
    async (options) => {
      const f = confirmationFixture(options);
      expect(
        await f.runtime.read(context, {
          connectionId: f.connection.id,
          capability: 'products.read',
          version: '0',
          input: {
            limit: 1,
            confirmMissing: {
              externalId: 'gid://shopify/Product/1',
              scopeKey: '',
              createdAt: null,
            },
          },
        }),
      ).toMatchObject({ ok: false });
    },
  );
  it('does not retire a record that reappeared after a missing scan', async () => {
    const f = confirmationFixture({ present: true });
    expect(
      await f.runtime.read(context, {
        connectionId: f.connection.id,
        capability: 'products.read',
        version: '0',
        input: {
          limit: 1,
          confirmMissing: {
            externalId: 'gid://shopify/Product/1',
            scopeKey: '',
            createdAt: null,
          },
        },
      }),
    ).toMatchObject({
      ok: true,
      value: { confirmation: 'present', items: [] },
    });
    expect(f.recordObservations).not.toHaveBeenCalled();
  });
});

describe('Shopify single-order reads', () => {
  const schema = buildSchema(
    readFileSync(
      new URL('./fixtures/admin-2026-07.graphql', import.meta.url),
      'utf8',
    ),
  );

  function orderFixture(node: (id: string) => unknown) {
    const f = fixture();
    const fallback = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url, init) => {
      const { query, variables } = JSON.parse(String(init?.body)) as {
        query: string;
        variables: { id: string };
      };
      expect(
        validate(schema, parse(query)).map((error) => error.message),
      ).toEqual([]);
      if (query.includes('LumaOrder'))
        return response({ node: node(variables.id) });

      return fallback(url, init);
    });
    const read = (input: Record<string, unknown>) =>
      f.runtime.read(context, {
        capability: 'orders.read',
        connectionId: f.connection.id,
        version: '0',
        input: { limit: 1, ...input },
      });

    return { ...f, readOrder: read };
  }

  const stored = (id: string) =>
    id === commerce.order.id
      ? {
          ...commerce.order,
          lineItems: page(commerce.orderLines),
          shippingLines: page(commerce.shippingLines),
          discountApplications: page(commerce.discounts),
        }
      : null;

  it('reads one order in one request, observed exactly as an order page observes it', async () => {
    const f = orderFixture(stored);
    expect(
      (await f.runtime.discover(context, 'connection-a')).find(
        (item) => item.capability === 'orders.read',
      )?.filters,
    ).toContain('order');
    const scanned = await f.read('orders.read');
    const calls = f.fetch.mock.calls.length;
    const single = await f.readOrder({ order: ref(commerce.order.id) });
    expect(f.fetch.mock.calls.length - calls).toBe(1);
    if (!scanned.ok || !single.ok) throw new Error('Expected order reads');
    expect(single.value).toMatchObject({
      nextCursor: null,
      completeness: 'complete',
    });
    expect(single.value).not.toHaveProperty('total');
    // Only the observation's own ID differs.
    expect(single.value.items).toEqual([
      { ...scanned.value.items[0], id: expect.any(String) },
    ]);
    expect(f.recordObservations).toHaveBeenLastCalledWith(
      expect.objectContaining({ observations: single.value.items }),
    );
  });

  it('returns an empty complete page with the history limit when Shopify has no such order', async () => {
    const f = orderFixture(stored);
    expect(
      await f.readOrder({ order: ref('gid://shopify/Order/999') }),
    ).toMatchObject({
      ok: true,
      value: {
        items: [],
        nextCursor: null,
        completeness: 'complete',
        history: { requirement: 'read_all_orders' },
      },
    });
    f.data.scopes.push({ handle: 'read_all_orders' });
    const full = await f.readOrder({ order: ref('gid://shopify/Order/999') });
    expect(full.ok && full.value.history).toBeNull();
  });

  it('rejects an order Shopify returns under another ID', async () => {
    const f = orderFixture(() => stored(commerce.order.id));
    expect(
      await f.readOrder({ order: ref('gid://shopify/Order/2') }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_response' } });
    expect(f.recordObservations).not.toHaveBeenCalled();
  });

  it.each([
    { cursor: 'next' },
    { updatedSince: '2026-09-01T00:00:00.000Z' },
    { createdSince: '2026-09-01T00:00:00.000Z' },
    { historyImport: { key: '00000000-0000-4000-8000-000000000001' } },
    {
      confirmMissing: {
        externalId: 'gid://shopify/Order/1',
        scopeKey: '',
        createdAt: null,
      },
    },
    { order: ref('gid://shopify/Product/1') },
  ])('rejects a point read combined with scan input: %j', async (input) => {
    const f = orderFixture(stored);
    expect(
      await f.readOrder({ order: ref(commerce.order.id), ...input }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(f.fetch).not.toHaveBeenCalled();
  });
});

import type { CapabilityInput, ReadCapability } from '@luma/connections';
import { createCapabilityRuntime } from '@luma/connections/adapters';
import type { TenantContext } from '@luma/identity';
import { describe, expect, it, vi } from 'vitest';

import type { JtlConnectorOptions } from './adapter.js';
import { createJtlConnector } from './adapter.js';
import { cloudId, cloudPayload } from './fixtures/cloud.js';
import commerce from './fixtures/commerce.json' with { type: 'json' };

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

/** A sales-order list row as `GET sales-orders/{id}` reports it, with nested detail objects. */
function detail({
  externalSalesOrderNumber,
  currencyIso,
  deliveryStatus,
  paymentStatus,
  totalGrossAmount,
  ...order
}: (typeof commerce.orders)[number]) {
  return {
    ...order,
    externalDetails: { externalSalesOrderNumber },
    paymentDetails: { currencyIso },
    keyFigures: {
      salesOrderId: order.id,
      deliveryStatus,
      paymentStatus,
      totalGrossAmount,
    },
  };
}

function fixture(overrides: Partial<JtlConnectorOptions> = {}) {
  const data = structuredClone(commerce);
  const cloud = overrides.connection?.kind === 'cloud';
  const json = (value: unknown) =>
    Response.json(cloud ? cloudPayload(value) : value);
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = new URL(String(input));
    const path = url.pathname
      .replace(/aaaaaaaa-aaaa-4aaa-8aaa-(\d{12})/g, (_match, id: string) =>
        String(Number(id)),
      )
      .replace(/^\/erp\/v2\/|^\/api\/eazybusiness\//, '');

    function page(items: unknown[]) {
      const pageNumber = Number(url.searchParams.get('pageNumber'));
      const pageSize = Number(url.searchParams.get('pageSize'));

      return json({
        items: items.slice((pageNumber - 1) * pageSize, pageNumber * pageSize),
        totalItems: items.length,
        pageNumber,
        pageSize,
      });
    }

    if (path === 'items') return page(data.items);
    const item = /^items\/(\d+)$/.exec(path);
    if (item) {
      const found = data.items.find(({ id }) => String(id) === item[1]);

      return found ? json(found) : new Response('', { status: 404 });
    }
    if (path === 'sales-orders') return page(data.orders);
    const order = /^sales-orders\/(\d+)$/.exec(path);
    if (order) {
      const found = data.orders.find(({ id }) => String(id) === order[1]);

      return found ? json(detail(found)) : new Response('', { status: 404 });
    }
    if (path === 'customers') return page(data.customers);
    if (path === 'sales-orders/10/line-items') return json(data.orderLines);
    if (path === 'delivery-notes') return page(data.notes);
    if (path === 'warehouses/7/items/20/stocks')
      return json(data.warehouseStock);
    const match = /^delivery-notes\/(30|31)(\/line-items)?$/.exec(path);
    if (match) {
      const index = Number(match[1]) - 30;

      return match[2]
        ? page(data.noteLines[index] ?? [])
        : json(data.details[index]);
    }
    throw new Error(`Unexpected request ${path}`);
  });
  const apiKey = vi.fn().mockResolvedValue('private-key');
  const recordObservations = vi.fn().mockResolvedValue(undefined);
  const options: JtlConnectorOptions = {
    tenantId: 'tenant-a',
    connectionId: 'connection-a',
    connection: {
      kind: 'onprem',
      baseUrl: 'http://127.0.0.1:5883/api/eazybusiness/',
      appId: 'Luma',
      appVersion: '0',
      challengeCode: 'registered-challenge',
      apiKey,
    },
    fetch,
    readRetry,
    recordObservations,
    now: () => new Date('2026-09-17T00:00:00Z'),
    ...overrides,
  };
  const connection = createJtlConnector(options);
  const runtime = createCapabilityRuntime({
    resolve: async () => connection,
    record: vi.fn().mockResolvedValue(undefined),
  });
  const read = <K extends ReadCapability>(
    capability: K,
    input: CapabilityInput<K> = { limit: 10 } as CapabilityInput<K>,
  ) =>
    runtime.read(context, {
      capability,
      connectionId: connection.id,
      version: '0',
      input,
    });

  return { data, fetch, apiKey, recordObservations, connection, runtime, read };
}

describe('JTL read adapter', () => {
  it.each(['onprem', 'cloud'] as const)(
    'normalizes all four capabilities through %s',
    async (kind) => {
      const accessToken = vi.fn().mockResolvedValue('cloud-token');
      const f = fixture(
        kind === 'cloud'
          ? {
              connection: {
                kind,
                jtlTenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                accessToken,
              },
            }
          : {},
      );
      const key = (value: number) =>
        kind === 'cloud' ? cloudId(value) : String(value);
      const orders = await f.read('orders.read');
      expect(orders).toMatchObject({
        ok: true,
        value: {
          items: [
            {
              source: { provider: 'jtl', externalId: key(10) },
              sourceUpdatedAt: null,
              adapterVersion: 'jtl/7',
              data: {
                externalOrderNumber: '#1001',
                status: 'open',
                paymentStatus: 'paid',
                placedAt: '2026-09-12T09:15:00+02:00',
                total: { amount: '107.1', currency: 'EUR' },
                lines: [
                  {
                    id: { externalId: key(101), scopeKey: key(10) },
                    quantity: { amount: '3.5', unit: 'each' },
                    unitPrice: { amount: '25.5', currency: 'EUR' },
                    taxIncluded: false,
                    taxRate: '0.19',
                    skuCode: 'Mixed-Case-SKU',
                    title: 'Rolled oats',
                  },
                  {
                    sku: null,
                    skuCode: null,
                    title: null,
                    unitPrice: null,
                    taxIncluded: null,
                    taxRate: null,
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
                title: 'Sample item',
                status: 'active',
                vendor: 'Harbor Ceramics',
                published: false,
                skus: [
                  {
                    id: ref(key(20)),
                    code: 'Mixed-Case-SKU',
                    title: null,
                    price: { amount: '19.99', currency: null },
                    barcode: '4006381333931',
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
              source: { scopeKey: 'all-warehouses' },
              data: { onHand: '3.5', reserved: '5', available: '-1.5' },
            },
          ],
        },
      });
      expect(await f.read('fulfillment.read')).toMatchObject({
        ok: true,
        value: {
          items: [
            {
              sourceUpdatedAt: null,
              data: {
                status: 'shipped',
                kind: 'shipment',
                lines: [{ quantity: { amount: '1.5', unit: 'each' } }],
                tracking: [
                  {
                    carrier: null,
                    number: '00340434161094042557',
                    url: 'https://tracking.example.test/00340434161094042557',
                  },
                ],
              },
            },
            {
              sourceUpdatedAt: null,
              // Blank numbers and non-web links are not tracking.
              data: {
                status: 'processing',
                kind: 'shipment',
                lines: [{ quantity: { amount: '2' } }],
                tracking: [],
              },
            },
          ],
        },
      });
      for (const [url, init] of f.fetch.mock.calls) {
        expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
        const headers = new Headers(init?.headers);
        expect(headers.get('authorization')).toBe(
          kind === 'cloud' ? 'Bearer cloud-token' : 'Wawi private-key',
        );
        expect(headers.get('x-tenant-id')).toBe(
          kind === 'cloud' ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : null,
        );
        expect(headers.get('api-version')).toBe(
          kind === 'onprem' ? '2.2' : null,
        );
        expect(String(url)).toContain(
          kind === 'cloud'
            ? 'https://api.jtl-cloud.com/erp/v2/'
            : '/api/eazybusiness/',
        );
      }
      expect(kind === 'cloud' ? accessToken : f.apiKey).toHaveBeenCalledTimes(
        f.fetch.mock.calls.length,
      );
      expect(Object.keys(f.connection.capabilities).sort()).toEqual([
        'fulfillment.read',
        'inventory.read',
        'orders.read',
        'products.read',
        'purchase-orders.read',
        'returns.created.read',
        'returns.exchange.reservation.read',
        'returns.options.read',
        'returns.settlement.proof.read',
        'returns.settlement.quote.read',
        'suppliers.read',
      ]);
    },
  );

  it('reads customers and attributes orders to them only with customer access', async () => {
    const without = fixture();
    const plain = await without.read('orders.read');
    expect(plain.ok && plain.value.items[0]!.data).not.toHaveProperty(
      'customer',
    );
    expect(without.connection.capabilities['customers.read']).toBeUndefined();

    const f = fixture({ customers: true });
    expect(await f.read('orders.read')).toMatchObject({
      ok: true,
      value: { items: [{ data: { customer: ref('501') } }] },
    });
    f.data.orders[0]!.customerId = 0;
    expect(await f.read('orders.read')).toMatchObject({
      ok: true,
      value: { items: [{ data: { customer: null } }] },
    });
    expect(
      f.connection.capabilities['customers.read']?.descriptor.filters,
    ).toEqual(['updatedSince']);
    expect(
      await f.read('customers.read', {
        limit: 10,
        updatedSince: '2026-09-01T00:00:00.000Z',
      }),
    ).toMatchObject({
      ok: true,
      value: {
        total: 2,
        items: [
          {
            source: { resource: 'customer', externalId: '501' },
            sourceUpdatedAt: '2026-09-10T08:00:00+02:00',
            data: {
              displayName: 'Mia Keller (Keller GmbH)',
              email: 'mia@keller.example',
              // A blank landline falls back to the mobile number.
              phone: '+49 151 1234567',
              address: {
                line1: 'Hauptstraße 12',
                line2: null,
                city: 'Berlin',
                region: null,
                postalCode: '10115',
                country: 'DE',
              },
              state: 'enabled',
              createdAt: '2025-02-01T10:00:00+01:00',
              orderCount: null,
              amountSpent: null,
              tags: ['B2B', 'VIP'],
              shared: { contact: true, address: true },
            },
          },
          {
            source: { externalId: '502' },
            // JTL's empty date is not a time.
            sourceUpdatedAt: null,
            data: {
              displayName: null,
              address: null,
              state: 'disabled',
              createdAt: null,
              tags: [],
            },
          },
        ],
      },
    });
    const url = new URL(String(f.fetch.mock.calls.at(-1)![0]));
    expect(url.pathname).toMatch(/\/customers$/);
    expect(url.searchParams.get('lastChangedAfter')).toBe(
      '2026-09-01T00:00:00.000Z',
    );
  });

  it('paginates and binds cursors to query, tenant, connection and mode', async () => {
    const f = fixture();
    f.data.items.push({ ...f.data.items[0]!, id: 21 });
    const first = await f.read('inventory.read', { limit: 1 });
    if (!first.ok || !first.value.nextCursor) throw new Error('Missing cursor');
    const cursor = first.value.nextCursor;
    expect(await f.read('inventory.read', { limit: 1, cursor })).toMatchObject({
      ok: true,
      value: { nextCursor: null, items: [{ source: { externalId: '21' } }] },
    });
    for (const input of [
      { limit: 2, cursor },
      { limit: 1, cursor, sku: ref('20') },
      { limit: 1, cursor: 'bad' },
    ]) {
      expect(await f.read('inventory.read', input)).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' },
      });
    }
    expect(
      await fixture({ connectionId: 'connection-b' }).read('inventory.read', {
        limit: 1,
        cursor,
      }),
    ).toMatchObject({ ok: false });
    expect(
      await fixture({ tenantId: 'tenant-b' }).read('inventory.read', {
        limit: 1,
        cursor,
      }),
    ).toMatchObject({ ok: false });
    expect(
      await fixture({
        connection: {
          kind: 'cloud',
          jtlTenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          accessToken: async () => 'token',
        },
      }).read('inventory.read', { limit: 1, cursor }),
    ).toMatchObject({ ok: false });
  });

  it('filters item and warehouse without inventing warehouse reservations or availability', async () => {
    const f = fixture();
    expect(
      await f.read('inventory.read', {
        limit: 10,
        sku: ref('20'),
        location: ref('7'),
      }),
    ).toMatchObject({
      ok: true,
      value: {
        items: [
          {
            data: {
              location: ref('7'),
              onHand: '2.5',
              reserved: null,
              available: null,
              availabilityBasis: 'unknown',
            },
          },
        ],
      },
    });
    expect(
      await f.read('inventory.read', { limit: 10, sku: ref('99') }),
    ).toMatchObject({ ok: true, value: { items: [] } });
    await f.read('fulfillment.read', { limit: 10, order: ref('10') });
    expect(
      f.fetch.mock.calls.some(([url]) =>
        String(url).includes('salesOrderNumberId=10'),
      ),
    ).toBe(true);
    expect(
      await f.read('inventory.read', { limit: 10, sku: ref('SKU-text') }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  });

  it.each([undefined, '', '   '])(
    'preserves item observations with unit %j as unknown',
    async (value) => {
      const f = fixture({ units: { unknown: 'each' } });
      if (value === undefined) Reflect.deleteProperty(f.data.items[0]!, 'unit');
      else f.data.items[0]!.unit = value;
      expect(await f.read('products.read')).toMatchObject({
        ok: true,
        value: {
          items: [{ data: { skus: [{ id: ref('20'), unit: 'unknown' }] } }],
        },
      });
      expect(await f.read('inventory.read')).toMatchObject({
        ok: true,
        value: {
          items: [
            { data: { unit: 'unknown', onHand: '3.5', available: '-1.5' } },
          ],
        },
      });
      expect(
        await f.read('inventory.read', { limit: 10, location: ref('7') }),
      ).toMatchObject({
        ok: true,
        value: { items: [{ data: { unit: 'unknown', onHand: '2.5' } }] },
      });
      expect(f.recordObservations).toHaveBeenCalledTimes(3);
    },
  );

  it('preserves unknown statuses, untracked stock and missing values', async () => {
    const f = fixture();
    f.data.orders[0]!.paymentStatus = 99;
    f.data.orders[0]!.deliveryStatus = 99;
    f.data.items[0]!.isInventoryManagementActive = false;
    expect(await f.read('orders.read')).toMatchObject({
      ok: true,
      value: {
        items: [{ data: { status: 'unknown', paymentStatus: 'unknown' } }],
      },
    });
    expect(await f.read('inventory.read')).toMatchObject({
      ok: true,
      value: {
        items: [{ data: { onHand: null, reserved: null, available: null } }],
      },
    });
  });

  it('treats malformed descriptive order facts as unknown without rejecting the order', async () => {
    const f = fixture();
    Object.assign(f.data.orders[0]!, {
      salesOrderDate: '0001-01-01T00:00:00',
      totalGrossAmount: 0.30000000000000004,
    });
    Object.assign(f.data.orderLines[0]!, { sKU: '   ', name: 42 });
    expect(await f.read('orders.read')).toMatchObject({
      ok: true,
      value: {
        items: [
          {
            data: {
              status: 'open',
              placedAt: null,
              total: null,
              lines: [{ skuCode: null, title: null }, {}],
            },
          },
        ],
      },
    });
  });

  it('captures only allowlisted fields with expiry and waits for durable evidence', async () => {
    const f = fixture({ rawRetentionMs: 60000 });
    await f.read('orders.read');
    const evidence: unknown = f.recordObservations.mock.calls[0]?.[0];
    expect(evidence).toMatchObject({
      raw: { expiresAt: '2026-09-17T00:01:00.000Z' },
    });
    expect(JSON.stringify(evidence)).not.toMatch(
      /excluded@example|private-key|billingAddress/,
    );
    f.recordObservations.mockRejectedValueOnce(new Error('storage failure'));
    expect(await f.read('products.read')).toMatchObject({ ok: false });
    const noRaw = fixture();
    await noRaw.read('inventory.read');
    expect(noRaw.recordObservations.mock.calls[0]?.[0]).not.toHaveProperty(
      'raw',
    );
  });

  it.each([
    [401, 'authentication'],
    [402, 'permission_denied'],
    [403, 'permission_denied'],
    [404, 'not_found'],
    [409, 'conflict'],
    [429, 'rate_limited'],
    [500, 'transient'],
    [503, 'transient'],
    [400, 'invalid_response'],
  ])(
    'normalizes HTTP %s, repeating only retryable reads, without leaking errors',
    async (status, code) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response('sensitive provider failure', {
          status: Number(status),
          headers: { 'Retry-After': '2' },
        }),
      );
      const f = fixture({ fetch });
      const result = await f.read('products.read');
      expect(result).toMatchObject({
        ok: false,
        error: { code, effect: 'none' },
      });
      if (status === 429 || status === 503)
        expect(result).toMatchObject({
          error: { retry: 'after_delay', retryAfterMs: 2000 },
        });
      expect(fetch).toHaveBeenCalledTimes(
        [429, 500, 503].includes(Number(status)) ? 3 : 1,
      );
      expect(f.recordObservations).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain('sensitive');
    },
  );

  it.each(['TimeoutError', 'Error'])(
    'normalizes %s transport failures',
    async (name) => {
      const error = new Error('private details');
      error.name = name;
      const f = fixture({ fetch: vi.fn().mockRejectedValue(error) });
      expect(await f.read('orders.read')).toMatchObject({
        ok: false,
        error: {
          code: name === 'TimeoutError' ? 'timeout' : 'transient',
          effect: 'none',
        },
      });
    },
  );

  it('rejects malformed pages, JSON, nested failures and foreign identities', async () => {
    for (const response of [
      new Response('{'),
      Response.json({ items: [], totalItems: 2, pageNumber: 1, pageSize: 10 }),
      Response.json({ items: [], totalItems: 0, pageNumber: 2, pageSize: 10 }),
    ]) {
      const f = fixture({ fetch: vi.fn().mockResolvedValue(response) });
      expect(await f.read('products.read')).toMatchObject({
        ok: false,
        error: { code: 'invalid_response' },
      });
      expect(f.recordObservations).not.toHaveBeenCalled();
    }
    const f = fixture();
    f.data.noteLines[0]![0]!.salesOrderLineItemId = 999;
    expect(await f.read('fulfillment.read')).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' },
    });
    expect(f.recordObservations).not.toHaveBeenCalled();
    f.data.orderLines[0]!.salesOrderId = 99;
    expect(await f.read('orders.read')).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' },
    });
  });

  it('preserves decimal tokens without rounding and rejects excess precision', async () => {
    const payload = JSON.stringify({
      items: commerce.items,
      totalItems: 1,
      pageNumber: 1,
      pageSize: 10,
    });
    const f = fixture({
      fetch: vi
        .fn()
        .mockResolvedValue(
          new Response(
            payload.replace(
              '"stockTotal":3.5',
              '"stockTotal":99999999999999.123456',
            ),
          ),
        ),
    });
    expect(await f.read('inventory.read')).toMatchObject({
      ok: true,
      value: { items: [{ data: { onHand: '99999999999999.123456' } }] },
    });
    const invalid = fixture({
      fetch: vi
        .fn()
        .mockResolvedValue(
          new Response(
            payload.replace('"stockTotal":3.5', '"stockTotal":1.1234567'),
          ),
        ),
    });
    expect(await invalid.read('inventory.read')).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' },
    });
  });

  it('fully paginates delivery-note lines before persisting a parent page', async () => {
    const f = fixture();
    f.data.notes = [{ id: 30 }];
    f.data.orderLines = Array.from({ length: 101 }, (_, index) => ({
      id: 1000 + index,
      salesOrderId: 10,
      itemId: 20,
      quantity: 1,
      salesUnit: 'stk',
    }));
    f.data.noteLines[0] = f.data.orderLines.map((line, index) => ({
      id: 2000 + index,
      deliveryNoteId: 30,
      salesOrderLineItemId: line.id,
      quantity: 1,
    }));
    const result = await f.read('fulfillment.read');
    expect(result.ok && result.value.items[0]?.data.lines).toHaveLength(101);
    expect(
      f.fetch.mock.calls.some(([url]) =>
        String(url).includes('delivery-notes/30/line-items?pageNumber=2'),
      ),
    ).toBe(true);
    expect(f.recordObservations).toHaveBeenCalledTimes(1);
    f.data.noteLines[0]![100]!.id = 2000;
    f.recordObservations.mockClear();
    expect(await f.read('fulfillment.read')).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' },
    });
    expect(f.recordObservations).not.toHaveBeenCalled();
  });

  it('reads order lines concurrently within a bound and keeps page order', async () => {
    const base = fixture();
    base.data.orders = Array.from({ length: 10 }, (_, index) => ({
      ...base.data.orders[0]!,
      id: 100 + index,
      salesOrderNumber: `SO-${100 + index}`,
    }));
    let active = 0;
    let peak = 0;
    const f = fixture({
      fetch: async (input, init) => {
        const order = /sales-orders\/(\d+)\/line-items/.exec(String(input));
        if (!order) return base.fetch(input, init);
        active += 1;
        peak = Math.max(peak, active);
        // Holds each read open so overlapping requests are observable.
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;

        return Response.json(
          base.data.orderLines.map((line, index) => ({
            ...line,
            id: Number(order[1]) * 100 + index,
            salesOrderId: Number(order[1]),
          })),
        );
      },
    });

    const result = await f.read('orders.read', { limit: 10 });
    expect(
      result.ok && result.value.items.map((item) => item.source.externalId),
    ).toEqual(base.data.orders.map((order) => String(order.id)));
    expect(peak).toBe(4);
  });

  it('reads the lines of an order once for all of its delivery notes in a page', async () => {
    const f = fixture();
    const result = await f.read('fulfillment.read');
    expect(result.ok && result.value.items).toHaveLength(2);
    expect(
      f.fetch.mock.calls.filter(([url]) =>
        String(url).includes('sales-orders/10/line-items'),
      ),
    ).toHaveLength(1);
  });

  it('rejects ambiguous duplicate fulfillment lines and zero-date shipment evidence', async () => {
    const f = fixture();
    f.data.noteLines[0]!.push({ ...f.data.noteLines[0]![0]!, id: 399 });
    expect(await f.read('fulfillment.read')).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' },
    });
    f.data.noteLines[0]!.pop();
    f.data.details[0]!.packages[0]!.shippingDate = '0001-01-01T00:00:00Z';
    expect(await f.read('fulfillment.read')).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' },
    });
    expect(f.recordObservations).not.toHaveBeenCalled();
  });

  it('reads one SKU directly instead of paging items and preserves missing versus zero stock', async () => {
    const f = fixture();
    f.data.items.push({
      ...f.data.items[0]!,
      id: 21,
      stockTotal: 0,
      stockAvailable: 0,
    });
    expect(
      await f.read('inventory.read', { limit: 1, sku: ref('21') }),
    ).toMatchObject({
      ok: true,
      value: {
        nextCursor: null,
        items: [{ data: { onHand: '0', available: '0' } }],
      },
    });
    expect(
      f.fetch.mock.calls.map(([url]) => new URL(String(url)).pathname),
    ).toEqual(['/api/eazybusiness/items/21']);
  });

  it('reads one order directly, observed exactly as an order page observes it', async () => {
    const f = fixture();
    expect(
      (await f.runtime.discover(context, 'connection-a')).find(
        (item) => item.capability === 'orders.read',
      )?.filters,
    ).toEqual(['order']);
    const scanned = await f.read('orders.read');
    f.fetch.mockClear();
    const single = await f.read('orders.read', {
      limit: 1,
      order: ref('10'),
    });
    expect(
      f.fetch.mock.calls.map(([url]) => new URL(String(url)).pathname),
    ).toEqual([
      '/api/eazybusiness/sales-orders/10',
      '/api/eazybusiness/sales-orders/10/line-items',
    ]);
    if (!scanned.ok || !single.ok) throw new Error('Expected order reads');
    const expected = scanned.value.items.find(
      (item) => item.source.externalId === '10',
    );
    if (!expected) throw new Error('Expected order 10 in the page');
    // Only the observation's own ID differs.
    expect(single.value).toEqual({
      items: [{ ...expected, id: expect.any(String) }],
      nextCursor: null,
      completeness: 'complete',
    });
    expect(f.recordObservations).toHaveBeenLastCalledWith(
      expect.objectContaining({ observations: single.value.items }),
    );
  });

  it('reads an unknown order as an empty page and rejects foreign or paged point reads', async () => {
    const f = fixture();
    expect(await f.read('orders.read', { limit: 1, order: ref('99') })).toEqual(
      {
        ok: true,
        value: { items: [], nextCursor: null, completeness: 'complete' },
      },
    );
    f.fetch.mockImplementationOnce(async () =>
      Response.json(detail({ ...f.data.orders[0]!, id: 12 })),
    );
    expect(
      await f.read('orders.read', { limit: 1, order: ref('10') }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_response' } });
    // Only the empty page was recorded.
    expect(f.recordObservations).toHaveBeenCalledOnce();
    f.fetch.mockClear();
    expect(
      await f.read('orders.read', {
        limit: 1,
        order: ref('10'),
        cursor: 'next',
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('rejects unsafe configuration and resolves credential failures', async () => {
    const f = fixture();
    const onprem = {
      kind: 'onprem' as const,
      baseUrl: 'http://remote.example/api/',
      appId: 'Luma',
      appVersion: '0',
      challengeCode: 'challenge',
      apiKey: async () => 'key',
    };
    expect(() => fixture({ connection: onprem })).toThrow('invalid_input');
    expect(() => fixture({ timeoutMs: 0 })).toThrow('invalid_input');
    expect(() => fixture({ rawRetentionMs: -1 })).toThrow('invalid_input');
    f.apiKey.mockResolvedValueOnce('');
    expect(await f.read('orders.read')).toMatchObject({
      ok: false,
      error: { code: 'authentication' },
    });
    f.apiKey.mockRejectedValue(new Error('secret store failure'));
    expect(await f.read('orders.read')).toMatchObject({
      ok: false,
      error: { code: 'transient' },
    });
    expect(f.apiKey).toHaveBeenCalledTimes(4);
    expect(f.fetch).not.toHaveBeenCalled();
  });
});

it('reads a marked replacement and only its native item reservation, with native array line items', async () => {
  const operationId = '11111111-1111-4111-8111-111111111111';
  const f = fixture({ units: { piece: 'each' } });
  f.fetch.mockImplementation(async (input) => {
    const url = new URL(String(input)),
      path = url.pathname.replace('/api/eazybusiness/', '');
    const rows =
      path === 'sales-orders'
        ? [
            {
              id: 10,
              salesOrderNumber: 'AU-10',
              externalSalesOrderNumber: `luma-ex:${operationId}`,
              isCancelled: false,
              deliveryStatus: 1,
              paymentStatus: 2,
              totalGrossAmount: '46',
              currencyIso: 'EUR',
            },
          ]
        : path === 'stocks/reservations'
          ? [
              {
                itemId: 20,
                salesOrderId: 10,
                amount: 2,
                createdAt: '2026-09-17T00:00:00Z',
              },
              {
                itemId: 20,
                salesOrderId: 11,
                amount: 100,
                createdAt: '2026-09-17T00:00:00Z',
              },
            ]
          : [
              {
                id: 1,
                salesOrderId: 10,
                itemId: 20,
                quantity: 2,
                salesUnit: 'piece',
              },
            ];

    return Response.json(
      path.endsWith('line-items')
        ? rows
        : {
            items: rows,
            totalItems: rows.length,
            pageNumber: 1,
            pageSize: 100,
            hasNextPage: false,
          },
    );
  });
  const result = await f.read('returns.exchange.reservation.read', {
    operationId,
    item: ref('20'),
  });
  expect(result).toMatchObject({
    ok: true,
    value: {
      complete: true,
      orders: [
        {
          id: ref('10'),
          total: { amount: '46', currency: 'EUR' },
          paid: true,
          exactLines: true,
          quantity: '2',
          reserved: '2',
        },
      ],
    },
  });
  expect(f.recordObservations).toHaveBeenCalledTimes(1);
});

it('does not certify uniqueness when the native order scan exceeds its complete-read bound', async () => {
  const f = fixture();
  f.fetch.mockImplementation(async (input) => {
    const url = new URL(String(input)),
      number = Number(url.searchParams.get('pageNumber'));
    const items = url.pathname.endsWith('sales-orders')
      ? Array.from({ length: 100 }, (_, i) => ({
          id: (number - 1) * 100 + i + 1,
          salesOrderNumber: 'AU',
          isCancelled: false,
          deliveryStatus: 1,
          paymentStatus: 2,
        }))
      : [];

    return Response.json({
      items,
      totalItems: items.length ? 501 : 0,
      pageNumber: number,
      pageSize: 100,
      hasNextPage: items.length > 0,
    });
  });
  expect(
    await f.read('returns.exchange.reservation.read', {
      operationId: '11111111-1111-4111-8111-111111111111',
      item: ref('20'),
    }),
  ).toMatchObject({ ok: true, value: { complete: false, orders: [] } });
  expect(f.fetch).toHaveBeenCalledTimes(6);
});

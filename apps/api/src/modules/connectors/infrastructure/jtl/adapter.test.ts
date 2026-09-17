import { describe, expect, it, vi } from 'vitest';
import type { TenantContext } from '../../../identity/index.js';
import { createCapabilityRuntime } from '../../application/capabilities.js';
import type {
  CapabilityInput,
  ReadCapability,
} from '../../domain/capabilities.js';
import { createJtlConnector } from './adapter.js';
import type { JtlConnectorOptions } from './adapter.js';
import commerce from './fixtures/commerce.json' with { type: 'json' };
import { cloudId, cloudPayload } from './fixtures/cloud.js';

vi.mock('../../../identity/index.js', () => ({
  requireTenant(context: TenantContext, tenantId: string) {
    if (context.tenantId !== tenantId) throw new Error('Tenant mismatch');
  },
}));
const context = {
  tenantId: 'tenant-a',
  requestId: 'request-a',
} as TenantContext;
const ref = (externalId: string) => ({ externalId, scopeKey: '' });
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
    if (path === 'sales-orders') return page(data.orders);
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
              data: {
                status: 'open',
                paymentStatus: 'paid',
                lines: [
                  {
                    id: { externalId: key(101), scopeKey: key(10) },
                    quantity: { amount: '3.5', unit: 'each' },
                  },
                  { sku: null },
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
            { data: { skus: [{ id: ref(key(20)), code: 'Mixed-Case-SKU' }] } },
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
              data: {
                status: 'shipped',
                lines: [{ quantity: { amount: '1.5', unit: 'each' } }],
              },
            },
            {
              data: {
                status: 'processing',
                lines: [{ quantity: { amount: '2' } }],
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
      expect(Object.keys(f.connection.capabilities)).toHaveLength(4);
    },
  );

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
    'normalizes HTTP %s without retrying or leaking errors',
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
      expect(fetch).toHaveBeenCalledTimes(1);
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

  it('continues an empty filtered item page and preserves missing versus zero stock', async () => {
    const f = fixture();
    f.data.items.push({
      ...f.data.items[0]!,
      id: 21,
      stockTotal: 0,
      stockAvailable: 0,
    });
    const first = await f.read('inventory.read', { limit: 1, sku: ref('21') });
    if (!first.ok || !first.value.nextCursor)
      throw new Error('Missing filtered cursor');
    expect(first.value.items).toEqual([]);
    const next = await f.read('inventory.read', {
      limit: 1,
      sku: ref('21'),
      cursor: first.value.nextCursor,
    });
    expect(next).toMatchObject({
      ok: true,
      value: {
        nextCursor: null,
        items: [{ data: { onHand: '0', available: '0' } }],
      },
    });
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
    f.apiKey.mockRejectedValueOnce(new Error('secret store failure'));
    expect(await f.read('orders.read')).toMatchObject({
      ok: false,
      error: { code: 'transient' },
    });
    expect(f.fetch).not.toHaveBeenCalled();
  });
});

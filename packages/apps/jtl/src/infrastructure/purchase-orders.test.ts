import type {
  CapabilityInput,
  ReadCapability,
  WriteCapability,
} from '@luma/connections';
import { createCapabilityRuntime } from '@luma/connections/adapters';
import type { TenantContext } from '@luma/identity';
import { describe, expect, it, vi } from 'vitest';

import type { JtlConnectorOptions } from './adapter.js';
import { createJtlConnector } from './adapter.js';
import { cloudId } from './fixtures/cloud.js';
import { adapterVersion } from './outputs.js';
import { acceptanceId } from './purchase-orders.js';

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

const now = new Date('2026-10-01T12:00:00Z');

interface Order {
  purchaseOrderId: string;
  supplierId: string;
  orderNumber: string;
  status: number;
  isConfirmed: boolean;
  createdAt: string;
  requestedDeliveryDate: string;
  internalComment?: string;
  externalOrderNumber?: string;
  deliveryAddress?: unknown;
  lineItems: Record<string, unknown>[];
}

function line(id: string, itemId: string | null, type = 1) {
  return {
    lineItemId: id,
    lineItemType: type,
    itemId,
    itemNumber: itemId ? `SKU-${itemId}` : null,
    name: 'Private line name',
    quantity: 10,
    deliveredQuantity: 4,
    openQuantity: 6,
    netPurchasePriceAmount: 2.5,
    vatRatePercentage: 19,
    sortOrder: 1,
    confirmedQuantity: 10,
    confirmedDeliveryDate: '2026-10-08T00:00:00',
    isLineItemConfirmed: true,
    deliveryDate: '2026-10-07T00:00:00+02:00',
    note: 'secret note',
  };
}

function fixture(overrides: Partial<JtlConnectorOptions> = {}) {
  const suppliers = [
    {
      id: '1',
      name: 'Legacy name',
      companyName: 'Nordwind Textil GmbH',
      supplierNumber: 'L-1',
      canDropship: false,
      currencyIso: 'EUR',
      city: 'Hamburg',
    },
    {
      id: '2',
      name: 'Baltic Packaging AB',
      supplierNumber: 'L-2',
      canDropship: false,
      currencyIso: 'EUR',
    },
    {
      id: '3',
      companyName: 'Third supplier',
      canDropship: false,
      currencyIso: 'EUR',
      name: 'Third',
    },
  ];
  const assignments: Record<string, Record<string, unknown>[]> = {
    '20': [
      { id: '200', itemId: '20', supplierId: '2', netPurchasePrice: 9 },
      {
        id: '201',
        itemId: '20',
        supplierId: '1',
        netPurchasePrice: 3.75,
        vatRate: 19,
      },
    ],
    '21': [{ id: '210', itemId: '21', supplierId: '2', vatRate: 7 }],
  };
  const orders: Order[] = [
    {
      purchaseOrderId: '50',
      supplierId: '1',
      orderNumber: 'PO-50',
      status: 30,
      isConfirmed: true,
      createdAt: '2026-10-01T08:00:00+02:00',
      requestedDeliveryDate: '2026-10-07T00:00:00+02:00',
      internalComment: 'Created by Luma · luma-po:abc · do not share',
      deliveryAddress: { street: 'Private street 1' },
      lineItems: [line('500', '20'), line('501', null, 0)],
    },
    {
      purchaseOrderId: '51',
      supplierId: '2',
      orderNumber: 'PO-51',
      status: 999,
      isConfirmed: false,
      createdAt: '2026-10-01T09:00:00Z',
      requestedDeliveryDate: '2026-10-09T00:00:00Z',
      internalComment: 'luma-po:abcd',
      lineItems: [],
    },
  ];
  const ledger = new Map<string, { status: number; body: unknown }>();
  const posts: { key: string | null; body: Record<string, unknown> }[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(
      /^\/erp\/v2\/|^\/api\/eazybusiness\//,
      '',
    );
    const page = (items: unknown[]) => {
      const pageNumber = Number(url.searchParams.get('pageNumber'));
      const pageSize = Number(url.searchParams.get('pageSize'));

      return Response.json({
        items: items.slice((pageNumber - 1) * pageSize, pageNumber * pageSize),
        totalItems: items.length,
        pageNumber,
        pageSize,
      });
    };
    if (init?.method === 'POST' && path === 'purchase-orders') {
      const key = new Headers(init.headers).get('Idempotency-Key');
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push({ key, body });
      const replay = key ? ledger.get(key) : undefined;
      if (replay) return Response.json(replay.body, { status: replay.status });
      const id = String(60 + orders.length);
      orders.push({
        purchaseOrderId: id,
        supplierId: String(body.supplierId),
        orderNumber: `PO-${id}`,
        status: 0,
        isConfirmed: false,
        createdAt: now.toISOString(),
        requestedDeliveryDate: String(body.requestedDeliveryDate),
        internalComment: String(body.internalComment),
        lineItems: [],
      });
      const result = { status: 201, body: { purchaseOrderId: id } };
      if (key) ledger.set(key, result);

      return Response.json(result.body, { status: 201 });
    }
    if (path === 'suppliers') return page(suppliers);
    const supplier = /^suppliers\/([\w-]+)$/.exec(path);
    if (supplier) {
      const found = suppliers.find((value) => value.id === supplier[1]);
      if (!found) return new Response('missing', { status: 404 });

      return Response.json({
        ...found,
        isActive: found.id !== '3',
        isVatExempt: false,
        address: { street: 'Supplier street 5' },
        contact: {
          emailAddress: ' orders@nordwind.example ',
          phoneNumber: '1',
        },
      });
    }
    const item = /^items\/([\w-]+)\/suppliers$/.exec(path);
    if (item) return page(assignments[item[1]!] ?? []);
    if (path === 'purchase-orders') {
      const after = url.searchParams.get('createdAtAfter');

      return page(
        orders
          .filter((order) => !after || order.createdAt > after)
          .map(({ purchaseOrderId, supplierId, status, createdAt }) => ({
            purchaseOrderId,
            supplierId,
            status,
            createdAt,
          })),
      );
    }
    const revision =
      /^purchase-orders\/([\w-]+)\/line-items(?:\/([\w-]+))?$/.exec(path);
    if (revision) {
      const found = orders.find(
        (value) => value.purchaseOrderId === revision[1],
      );
      if (!found) return new Response('missing', { status: 404 });
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<
        string,
        unknown
      >;
      if (init?.method === 'PATCH') {
        const position = found.lineItems.find(
          (value) => value.lineItemId === revision[2],
        );
        if (!position) return new Response('missing', { status: 404 });
        Object.assign(position, body);
      } else if (init?.method === 'DELETE')
        found.lineItems = found.lineItems.filter(
          (value) => value.lineItemId !== revision[2],
        );
      else if (init?.method === 'POST')
        found.lineItems.push({
          ...line('502', String(body.itemId)),
          ...body,
          deliveredQuantity: 0,
        });

      return Response.json(found);
    }
    const order = /^purchase-orders\/([\w-]+)$/.exec(path);
    if (order) {
      const found = orders.find((value) => value.purchaseOrderId === order[1]);
      if (!found) return new Response('missing', { status: 404 });

      return Response.json(found);
    }
    throw new Error(`Unexpected request ${init?.method ?? 'GET'} ${path}`);
  });
  const recordObservations = vi.fn().mockResolvedValue(undefined);
  const options: JtlConnectorOptions = {
    tenantId: 'tenant-a',
    connectionId: 'connection-a',
    connection: {
      kind: 'onprem',
      baseUrl: 'http://127.0.0.1:5883/api/eazybusiness/',
      appId: 'Luma',
      appVersion: '0',
      challengeCode: 'challenge',
      apiKey: async () => 'secret',
    },
    fetch,
    readRetry,
    recordObservations,
    purchaseOrderActions: true,
    now: () => now,
    ...overrides,
  };
  const runtime = () =>
    createCapabilityRuntime({
      resolve: async () => createJtlConnector(options),
      record: vi.fn().mockResolvedValue(undefined),
    });
  const read = <K extends ReadCapability>(
    capability: K,
    input: CapabilityInput<K>,
  ) =>
    runtime().read(context, {
      capability,
      connectionId: 'connection-a',
      version: '0',
      input,
    });
  const submission: CapabilityInput<'purchase-orders.submit'> = {
    lumaOrderId: 'po-7',
    reference: `PO-2026-0007 ${'x'.repeat(300)}`,
    supplier: ref('1'),
    requestedDeliveryDate: '2026-10-12',
    lines: [{ sku: ref('20'), quantity: { amount: '12', unit: 'each' } }],
  };
  const write = <K extends WriteCapability>(
    capability: K,
    input: CapabilityInput<K>,
    key = 'logical-action',
  ) =>
    runtime().write(context, {
      capability,
      connectionId: 'connection-a',
      version: '0',
      idempotencyKey: key,
      input,
    });
  const submit = (
    input: CapabilityInput<'purchase-orders.submit'> = submission,
    key?: string,
  ) => write('purchase-orders.submit', input, key);
  const methods = () => fetch.mock.calls.map((call) => call[1]?.method);

  return {
    suppliers,
    assignments,
    orders,
    posts,
    fetch,
    recordObservations,
    options,
    read,
    submit,
    submission,
    methods,
    write,
  };
}

describe('JTL suppliers', () => {
  it('pages the supplier overview with a bound cursor', async () => {
    const f = fixture();
    const first = await f.read('suppliers.read', { limit: 2 });
    expect(first).toMatchObject({
      ok: true,
      value: {
        completeness: 'complete',
        total: 3,
        items: [
          {
            source: {
              resource: 'supplier',
              externalId: '1',
              scopeKey: '',
              provider: 'jtl',
            },
            data: {
              name: 'Nordwind Textil GmbH',
              number: 'L-1',
              active: true,
              email: null,
            },
          },
          { data: { name: 'Baltic Packaging AB', number: 'L-2' } },
        ],
      },
    });
    if (!first.ok) throw new Error('read failed');
    const second = await f.read('suppliers.read', {
      limit: 2,
      cursor: first.value.nextCursor!,
    });
    expect(second).toMatchObject({
      ok: true,
      value: { nextCursor: null, items: [{ source: { externalId: '3' } }] },
    });
    expect(
      await f.read('suppliers.read', {
        limit: 1,
        cursor: first.value.nextCursor!,
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(JSON.stringify(f.recordObservations.mock.calls)).not.toContain(
      'Hamburg',
    );
  });

  it('reads one supplier detail with its activity and contact email', async () => {
    const f = fixture();
    expect(
      await f.read('suppliers.read', { limit: 1, supplier: ref('3') }),
    ).toMatchObject({
      ok: true,
      value: {
        nextCursor: null,
        items: [
          {
            source: { externalId: '3' },
            data: {
              name: 'Third supplier',
              active: false,
              email: 'orders@nordwind.example',
            },
          },
        ],
      },
    });
    expect(JSON.stringify(f.recordObservations.mock.calls)).not.toMatch(
      /Supplier street|phoneNumber/,
    );
    expect(
      await f.read('suppliers.read', { limit: 1, supplier: ref('9') }),
    ).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });
});

describe('JTL purchase-order reads', () => {
  it('normalizes item lines and keeps only allowlisted fields', async () => {
    const f = fixture({ rawRetentionMs: 60000 });
    const result = await f.read('purchase-orders.read', { limit: 1 });
    expect(result).toEqual({
      ok: true,
      value: {
        items: [
          {
            id: expect.any(String),
            source: {
              tenantId: 'tenant-a',
              connectionId: 'connection-a',
              provider: 'jtl',
              resource: 'purchase_order',
              externalId: '50',
              scopeKey: '',
            },
            kind: 'snapshot',
            observedAt: now.toISOString(),
            sourceUpdatedAt: null,
            sourceRevision: null,
            adapterVersion,
            schemaVersion: 1,
            data: {
              supplier: ref('1'),
              orderNumber: 'PO-50',
              lumaOrderId: 'abc',
              status: 'partially_delivered',
              requestedDeliveryDate: '2026-10-07',
              confirmed: true,
              createdAt: '2026-10-01T08:00:00+02:00',
              lines: [
                {
                  id: { externalId: '500', scopeKey: '50' },
                  sku: ref('20'),
                  itemNumber: 'SKU-20',
                  quantity: { amount: '10', unit: 'each' },
                  deliveredQuantity: '4',
                  confirmedQuantity: '10',
                  confirmedDeliveryDate: '2026-10-08',
                  confirmed: true,
                  requestedDeliveryDate: '2026-10-07',
                },
              ],
            },
          },
        ],
        nextCursor: expect.any(String),
        completeness: 'complete',
        total: 2,
      },
    });
    const recorded = JSON.stringify(f.recordObservations.mock.calls);
    expect(recorded).not.toMatch(
      /do not share|Created by Luma|Private street|secret note|Private line name/,
    );
    expect(recorded).toContain('lumaOrderIds');
  });

  it('reports unknown status and units for orders Luma did not create', async () => {
    const f = fixture();
    f.orders[1]!.internalComment = 'Manual order';
    f.orders[1]!.lineItems = [line('510', '21')];
    expect(
      await f.read('purchase-orders.read', { limit: 1, order: ref('51') }),
    ).toMatchObject({
      ok: true,
      value: {
        items: [
          {
            data: {
              status: 'unknown',
              lumaOrderId: null,
              confirmed: false,
              lines: [{ quantity: { amount: '10', unit: 'unknown' } }],
            },
          },
        ],
      },
    });
  });

  it('finds orders created for one Luma order by exact marker', async () => {
    const f = fixture();
    const result = await f.read('purchase-orders.read', {
      limit: 5,
      created: { lumaOrderId: 'abc', createdSince: '2026-10-01T05:00:00Z' },
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        completeness: 'complete',
        nextCursor: null,
        items: [{ source: { externalId: '50' }, data: { lumaOrderId: 'abc' } }],
      },
    });
    if (!result.ok) throw new Error('read failed');
    expect(result.value.items).toHaveLength(1);
    const list = new URL(String(f.fetch.mock.calls[0]![0]));
    expect(list.pathname).toMatch(/purchase-orders$/);
    expect(list.searchParams.get('createdAtAfter')).toBe(
      '2026-10-01T04:59:59.000Z',
    );
    expect(
      await f.read('purchase-orders.read', {
        limit: 5,
        order: ref('50'),
        created: { lumaOrderId: 'abc', createdSince: now.toISOString() },
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  });
});

describe('JTL purchase-order submission', () => {
  it('prices lines from the supplier assignment and sends a provider idempotency key', async () => {
    const f = fixture();
    const result = await f.submit();
    expect(result).toEqual({
      ok: true,
      value: {
        status: 'accepted',
        evidenceRefs: [acceptanceId('tenant-a', 'connection-a', '62')],
        providerRequestId: null,
      },
    });
    expect(f.posts).toHaveLength(1);
    expect(f.posts[0]!.body).toEqual({
      supplierId: '1',
      requestedDeliveryDate: '2026-10-12T12:00:00Z',
      items: [
        {
          itemId: '20',
          quantity: 12,
          netPurchasePriceAmount: 3.75,
          vatRatePercentage: 19,
        },
      ],
      externalOrderNumber: f.submission.reference.slice(0, 255),
      internalComment: 'Created by Luma · luma-po:po-7',
    });
    expect(f.posts[0]!.key).toMatch(/^[a-f0-9]{64}$/);
    const post = f.fetch.mock.calls.find((call) => call[1]?.method === 'POST')!;
    expect(post[1]).toMatchObject({ redirect: 'error' });

    // The created order is now found by its marker, so a repeat is refused before dispatch.
    expect(await f.submit()).toMatchObject({
      ok: false,
      error: { code: 'conflict', effect: 'none', dispatch: 'not_dispatched' },
    });
    expect(f.posts).toHaveLength(1);

    const other = fixture();
    await other.submit();
    expect(other.posts[0]!.key).toBe(f.posts[0]!.key);
    const changed = fixture();
    await changed.submit(changed.submission, 'another-action');
    expect(changed.posts[0]!.key).not.toBe(f.posts[0]!.key);
  });

  it.each([
    [
      'an unassigned item',
      (f: ReturnType<typeof fixture>) => f.assignments['20']!.splice(1, 1),
    ],
    [
      'an assignment without a price',
      (f: ReturnType<typeof fixture>) =>
        Reflect.deleteProperty(f.assignments['20']![1]!, 'netPurchasePrice'),
    ],
    [
      'an existing order for the Luma order',
      (f: ReturnType<typeof fixture>) =>
        (f.orders[0]!.internalComment = 'luma-po:po-7'),
    ],
  ])('refuses %s before dispatch', async (_name, change) => {
    const f = fixture();
    change(f);
    expect(await f.submit()).toEqual({
      ok: false,
      error: {
        code: 'conflict',
        effect: 'none',
        retry: 'never',
        dispatch: 'not_dispatched',
      },
    });
    expect(f.methods()).not.toContain('POST');
  });

  it('rejects non-countable units, missing keys and disabled actions', async () => {
    const f = fixture();
    expect(
      await f.submit({
        ...f.submission,
        lines: [{ sku: ref('20'), quantity: { amount: '1.5', unit: 'kg' } }],
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(await f.submit(f.submission, ' ')).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(
      createJtlConnector({ ...f.options, purchaseOrderActions: false })
        .capabilities['purchase-orders.submit'],
    ).toBeUndefined();
  });

  it('marks pre-dispatch read failures as not dispatched', async () => {
    const f = fixture();
    f.fetch.mockImplementation(
      async () => new Response('busy', { status: 503 }),
    );
    expect(await f.submit()).toMatchObject({
      ok: false,
      error: {
        code: 'transient',
        effect: 'none',
        retry: 'after_delay',
        dispatch: 'not_dispatched',
      },
    });
  });

  it.each([
    ['a server error', () => new Response('fail', { status: 500 })],
    ['a malformed body', () => Response.json({ id: 'x' }, { status: 201 })],
    [
      'a lost connection',
      () => {
        throw new TypeError('socket hang up');
      },
    ],
  ])('requires reconciliation after %s', async (_name, respond) => {
    const f = fixture();
    const original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (input, init) =>
      init?.method === 'POST' ? respond() : original(input, init),
    );
    expect(await f.submit()).toMatchObject({
      ok: false,
      error: { effect: 'unknown', retry: 'reconcile' },
    });
  });

  it('keeps a provider rejection free of effect', async () => {
    const f = fixture();
    const original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (input, init) =>
      init?.method === 'POST'
        ? new Response('bad', { status: 400 })
        : original(input, init),
    );
    expect(await f.submit()).toEqual({
      ok: false,
      error: { code: 'invalid_input', effect: 'none', retry: 'never' },
    });
  });

  it('uses cloud identities unchanged', async () => {
    const f = fixture({
      connection: {
        kind: 'cloud',
        jtlTenantId: cloudId(1),
        accessToken: async () => 'token',
      },
    });
    f.suppliers[0]!.id = cloudId(1);
    f.assignments[cloudId(20)] = [
      {
        id: cloudId(201),
        itemId: cloudId(20),
        supplierId: cloudId(1),
        netPurchasePrice: '3.75',
        vatRate: 19,
      },
    ];
    expect(
      await f.submit({
        ...f.submission,
        supplier: ref(cloudId(1)),
        lines: [
          { sku: ref(cloudId(20)), quantity: { amount: '2', unit: 'each' } },
        ],
      }),
    ).toMatchObject({ ok: true });
    expect(f.posts[0]!.body).toMatchObject({
      supplierId: cloudId(1),
      items: [{ itemId: cloudId(20), netPurchasePriceAmount: 3.75 }],
    });
  });
});

describe('JTL approved position revisions', () => {
  async function prepared() {
    const f = fixture({ purchaseOrderRevisions: true });
    f.orders[0]!.status = 5;
    f.orders[0]!.lineItems[0]!.deliveredQuantity = 0;
    const read = await f.read('purchase-orders.read', {
      order: ref('50'),
      limit: 1,
    });
    if (!read.ok) throw Error('Read failed');

    return { f, expected: read.value.items[0]!.data };
  }

  it('dispatches one documented PATCH after exact source comparison and checks changes with an independent read', async () => {
    const { f, expected } = await prepared();
    const result = await f.write('purchase-orders.revise', {
      order: ref('50'),
      expected,
      operation: {
        kind: 'update_line',
        line: { externalId: '500', scopeKey: '50' },
        quantity: 6,
        requestedDeliveryDate: '2026-10-20',
      },
    });
    expect(result).toMatchObject({ ok: true, value: { status: 'accepted' } });
    expect(f.methods().filter((method) => method === 'PATCH')).toHaveLength(1);
    const call = f.fetch.mock.calls.find(
      (call) => call[1]?.method === 'PATCH',
    )!;
    expect(String(call[0])).toContain('/purchase-orders/50/line-items/500');
    expect(JSON.parse(String(call[1]!.body))).toEqual({
      quantity: 6,
      deliveryDate: '2026-10-20T12:00:00Z',
    });
    expect(
      await f.read('purchase-orders.read', { order: ref('50'), limit: 1 }),
    ).toMatchObject({
      ok: true,
      value: {
        items: [
          {
            data: {
              lines: [
                {
                  quantity: { amount: '6' },
                  requestedDeliveryDate: '2026-10-20',
                },
              ],
            },
          },
        ],
      },
    });
  });
  it('refuses stale source and received positions before sending any mutation', async () => {
    const { f, expected } = await prepared();
    f.orders[0]!.lineItems[0]!.quantity = 9;
    const input = {
      order: ref('50'),
      expected,
      operation: {
        kind: 'update_line' as const,
        line: { externalId: '500', scopeKey: '50' },
        quantity: 6,
      },
    };
    expect(await f.write('purchase-orders.revise', input)).toMatchObject({
      ok: false,
      error: { code: 'conflict', effect: 'none' },
    });
    f.orders[0]!.lineItems[0]!.quantity = 10;
    f.orders[0]!.lineItems[0]!.deliveredQuantity = 1;
    const read = await f.read('purchase-orders.read', {
      order: ref('50'),
      limit: 1,
    });
    if (!read.ok) throw Error('Read failed');
    expect(
      await f.write('purchase-orders.revise', {
        ...input,
        expected: read.value.items[0]!.data,
      }),
    ).toMatchObject({ ok: false, error: { code: 'conflict', effect: 'none' } });
    expect(
      f
        .methods()
        .filter((method) => ['POST', 'PATCH', 'DELETE'].includes(method ?? '')),
    ).toEqual([]);
  });
  it('does not replay a lost response after dispatch', async () => {
    const { f, expected } = await prepared();
    f.fetch
      .mockImplementationOnce(async () => Response.json(f.orders[0]!))
      .mockImplementationOnce(async () => {
        throw Error('Lost write response');
      });
    expect(
      await f.write('purchase-orders.revise', {
        order: ref('50'),
        expected,
        operation: {
          kind: 'update_line',
          line: { externalId: '500', scopeKey: '50' },
          quantity: 6,
        },
      }),
    ).toMatchObject({
      ok: false,
      error: { effect: 'unknown', retry: 'reconcile' },
    });
    expect(f.methods().filter((method) => method === 'PATCH')).toHaveLength(1);
  });
});

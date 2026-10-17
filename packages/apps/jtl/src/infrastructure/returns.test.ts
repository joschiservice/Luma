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
import { lumaReturnMarker, returnAcceptanceId } from './returns.js';

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

const ref = (externalId: string, scopeKey = '') => ({ externalId, scopeKey });

const now = new Date('2026-10-01T12:00:00Z');

const caseId = '7f9c2c8e-3b1a-4c55-9e0a-2f7d8b6a1c00';

interface Return {
  id: string;
  number: string;
  returnDate: string;
  externalNumber: string;
  salesOrderId: string;
  warehouseId: string;
  lines: Record<string, unknown>[];
}

function fixture(overrides: Partial<JtlConnectorOptions> = {}) {
  const order = {
    id: '40',
    companyId: '1',
    isCancelled: false,
    salesOrderNumber: 'AU-40',
    customerId: '9',
    billingAddress: { street: 'Private street 1' },
  };
  const orderLines = [
    {
      id: '400',
      salesOrderId: '40',
      itemId: '20',
      quantity: 3,
      salesUnit: 'Stück',
      name: 'Canvas tote',
      sKU: 'LUMA-001',
    },
    {
      id: '401',
      salesOrderId: '40',
      itemId: '21',
      quantity: 2.5,
      salesUnit: 'kg',
      name: 'Coffee',
      sKU: 'LUMA-002',
    },
  ];
  const warehouses: Record<string, unknown>[] = [
    { id: '1', name: ' Hamburg ', active: true },
    { id: '2', name: 'Closed', active: false },
    { id: '3', name: '' },
  ];
  const reasons: Record<string, unknown>[] = [
    {
      id: '1',
      translations: [
        { languageIso: 'DE', name: 'Defekt' },
        { languageIso: 'EN', name: ' Defective ' },
      ],
    },
    {
      id: '2',
      translations: [{ languageIso: 'ger', name: 'Falscher Artikel' }],
    },
    { id: '3', translations: [{ languageIso: 'fr', name: 'Plus voulu' }] },
    { id: '4', translations: [] },
  ];
  const returns: Return[] = [
    {
      id: '70',
      number: 'RE-70',
      returnDate: '2026-09-30T10:00:00+02:00',
      // A prefix of the marker belongs to another case.
      externalNumber: `${lumaReturnMarker(caseId)}x`,
      salesOrderId: '40',
      warehouseId: '1',
      lines: [],
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
    if (init?.method === 'POST' && path === 'returns') {
      const key = new Headers(init.headers).get('Idempotency-Key');
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push({ key, body });
      const replay = key ? ledger.get(key) : undefined;
      if (replay) return Response.json(replay.body, { status: replay.status });
      const id = String(80 + returns.length);
      const items = body.items as Record<string, unknown>[];
      returns.push({
        id,
        number: `RE-${id}`,
        returnDate: now.toISOString(),
        externalNumber: String(body.externalNumber),
        salesOrderId: String(body.salesOrderId),
        warehouseId: String(body.warehouseId),
        lines: items.map((item, index) => ({
          id: `${id}${index}`,
          returnId: id,
          quantity: item.quantity,
          returnReasonId: item.returnReasonId,
          salesOrderLineItemId: item.salesOrderLineItemId,
        })),
      });
      const result = {
        status: 201,
        body: { id, number: `RE-${id}`, contact: 'Private contact' },
      };
      if (key) ledger.set(key, result);

      return Response.json(result.body, { status: 201 });
    }
    if (path === `sales-orders/${order.id}`) return Response.json(order);
    if (path === `sales-orders/${order.id}/line-items`)
      return Response.json(orderLines);
    if (path === 'warehouses') return page(warehouses);
    if (path === 'return-reasons') return Response.json(reasons);
    if (path === 'returns')
      return page(
        returns
          .filter(
            (value) =>
              value.salesOrderId === url.searchParams.get('salesOrderId'),
          )
          .map((row) => ({
            id: row.id,
            number: row.number,
            returnDate: row.returnDate,
            externalNumber: row.externalNumber,
            salesOrderId: row.salesOrderId,
            warehouseId: row.warehouseId,
            customerId: '9',
            contact: 'Private contact',
            internalComment: 'Private comment',
            externalComment: 'Customer note',
          })),
      );
    const lines = /^returns\/([\w-]+)\/line-items$/.exec(path);
    if (lines) {
      const found = returns.find((value) => value.id === lines[1]);
      if (!found) return new Response('missing', { status: 404 });

      return Response.json(
        found.lines.map((line) => ({
          ...line,
          name: 'Private line name',
          returnReasonComment: 'Private reason comment',
        })),
      );
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
    returnActions: true,
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
  const creation: CapabilityInput<'returns.create'> = {
    lumaCaseId: caseId,
    order: ref('40'),
    warehouse: ref('1'),
    reason: ref('1'),
    lines: [
      {
        orderLine: ref('400', '40'),
        quantity: { amount: '2', unit: 'each' },
      },
    ],
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
  const create = (
    input: CapabilityInput<'returns.create'> = creation,
    key?: string,
  ) => write('returns.create', input, key);
  const methods = () => fetch.mock.calls.map((call) => call[1]?.method);

  return {
    order,
    orderLines,
    warehouses,
    reasons,
    returns,
    posts,
    fetch,
    recordObservations,
    options,
    read,
    create,
    creation,
    methods,
  };
}

describe('JTL return options', () => {
  it('lists active warehouses and every reason with a preferred name', async () => {
    const f = fixture();
    expect(await f.read('returns.options.read', { limit: 1 })).toMatchObject({
      ok: true,
      value: {
        nextCursor: null,
        completeness: 'complete',
        items: [
          {
            source: {
              resource: 'location',
              externalId: '1',
              scopeKey: '',
              provider: 'jtl',
            },
            adapterVersion,
            data: { kind: 'warehouse', name: 'Hamburg' },
          },
          {
            source: { resource: 'location', externalId: '3' },
            data: { kind: 'warehouse', name: null },
          },
          {
            source: { resource: 'return_reason', externalId: '1' },
            data: { kind: 'reason', name: 'Defective' },
          },
          {
            source: { resource: 'return_reason', externalId: '2' },
            data: { name: 'Falscher Artikel' },
          },
          {
            source: { resource: 'return_reason', externalId: '3' },
            data: { name: 'Plus voulu' },
          },
          {
            source: { resource: 'return_reason', externalId: '4' },
            data: { name: null },
          },
        ],
      },
    });
    expect(f.recordObservations).toHaveBeenCalledWith(
      expect.objectContaining({ capability: 'returns.options.read' }),
    );
    expect(
      await f.read('returns.options.read', { limit: 1, cursor: 'next' }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  });

  it('reports a warehouse list beyond ten pages as partial', async () => {
    const f = fixture();
    f.warehouses.splice(
      0,
      f.warehouses.length,
      ...Array.from({ length: 1001 }, (_, index) => ({
        id: String(index + 1),
        name: `Warehouse ${index + 1}`,
      })),
    );
    const result = await f.read('returns.options.read', { limit: 100 });
    expect(result).toMatchObject({
      ok: true,
      value: { completeness: 'partial' },
    });
    if (!result.ok) throw new Error('read failed');
    expect(
      result.value.items.filter((item) => item.source.resource === 'location'),
    ).toHaveLength(1000);
  });
});

describe('JTL created returns', () => {
  it('finds returns of the order by the exact case marker', async () => {
    const f = fixture({ rawRetentionMs: 60000 });
    f.returns.push(
      {
        id: '71',
        number: 'RE-71',
        returnDate: '0001-01-01T00:00:00Z',
        externalNumber: lumaReturnMarker(caseId),
        salesOrderId: '40',
        warehouseId: '2',
        lines: [
          {
            id: '710',
            returnId: '71',
            quantity: 1.5,
            returnReasonId: '1',
            salesOrderLineItemId: '400',
          },
          {
            id: '711',
            returnId: '71',
            quantity: 1,
            returnReasonId: null,
            salesOrderLineItemId: 0,
          },
        ],
      },
      {
        id: '72',
        number: 'RE-72',
        returnDate: '2026-10-01T09:00:00Z',
        externalNumber: lumaReturnMarker(caseId),
        salesOrderId: '41',
        warehouseId: '1',
        lines: [],
      },
    );
    const result = await f.read('returns.created.read', {
      limit: 5,
      order: ref('40'),
      lumaCaseId: caseId,
    });
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
              resource: 'return',
              externalId: '71',
              scopeKey: '',
            },
            kind: 'snapshot',
            observedAt: now.toISOString(),
            sourceUpdatedAt: null,
            sourceRevision: null,
            adapterVersion,
            schemaVersion: 1,
            data: {
              order: ref('40'),
              number: 'RE-71',
              lumaCaseId: caseId,
              createdAt: null,
              warehouse: ref('2'),
              lines: [
                {
                  orderLine: ref('400', '40'),
                  quantity: { amount: '1.5', unit: 'each' },
                  reason: ref('1'),
                },
                {
                  orderLine: null,
                  quantity: { amount: '1', unit: 'each' },
                  reason: null,
                },
              ],
            },
          },
        ],
        nextCursor: null,
        completeness: 'complete',
      },
    });
    const list = new URL(String(f.fetch.mock.calls[0]![0]));
    expect(list.pathname).toMatch(/returns$/);
    expect(list.searchParams.get('salesOrderId')).toBe('40');
    expect(JSON.stringify(f.recordObservations.mock.calls)).not.toMatch(
      /Private|Customer note|customerId/,
    );
  });

  it('reports more matches than the limit as partial', async () => {
    const f = fixture();
    for (const id of ['73', '74'])
      f.returns.push({
        id,
        number: `RE-${id}`,
        returnDate: '2026-10-01T09:00:00Z',
        externalNumber: lumaReturnMarker(caseId),
        salesOrderId: '40',
        warehouseId: '1',
        lines: [],
      });
    expect(
      await f.read('returns.created.read', {
        limit: 1,
        order: ref('40'),
        lumaCaseId: caseId,
      }),
    ).toMatchObject({
      ok: true,
      value: {
        completeness: 'partial',
        items: [{ source: { externalId: '73' } }],
      },
    });
  });

  it('rejects returns of another order and lines of another return', async () => {
    const f = fixture();
    const original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementationOnce(async () =>
      Response.json({
        items: [{ id: '75', salesOrderId: '41', externalNumber: 'x' }],
        totalItems: 1,
        pageNumber: 1,
        pageSize: 100,
      }),
    );
    expect(
      await f.read('returns.created.read', {
        limit: 1,
        order: ref('40'),
        lumaCaseId: caseId,
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_response' } });
    f.fetch.mockImplementation(original);
    f.returns.push({
      id: '76',
      number: 'RE-76',
      returnDate: '2026-10-01T09:00:00Z',
      externalNumber: lumaReturnMarker(caseId),
      salesOrderId: '40',
      warehouseId: '1',
      lines: [
        {
          id: '760',
          returnId: '99',
          quantity: 1,
          returnReasonId: '1',
          salesOrderLineItemId: '400',
        },
      ],
    });
    expect(
      await f.read('returns.created.read', {
        limit: 1,
        order: ref('40'),
        lumaCaseId: caseId,
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_response' } });
  });
});

describe('JTL return creation', () => {
  it('creates a marked return without customer text and with a provider key', async () => {
    const f = fixture();
    const result = await f.create();
    expect(result).toEqual({
      ok: true,
      value: {
        status: 'accepted',
        evidenceRefs: [returnAcceptanceId('tenant-a', 'connection-a', '81')],
        providerRequestId: null,
        records: [{ resource: 'return', externalId: '81' }],
      },
    });
    expect(f.posts).toHaveLength(1);
    expect(f.posts[0]!.body).toEqual({
      companyId: '1',
      salesOrderId: '40',
      warehouseId: '1',
      externalNumber: `luma-rc:${caseId}`,
      internalComment: 'Created by Luma',
      items: [
        {
          salesOrderLineItemId: '400',
          quantity: 2,
          returnReasonId: '1',
          credit: false,
        },
      ],
    });
    expect(f.posts[0]!.key).toMatch(/^[a-f0-9]{64}$/);
    const post = f.fetch.mock.calls.find((call) => call[1]?.method === 'POST')!;
    expect(post[1]).toMatchObject({ redirect: 'error' });

    // The created return is now found by its marker, so a repeat is refused before dispatch.
    expect(await f.create()).toMatchObject({
      ok: false,
      error: { code: 'conflict', effect: 'none', dispatch: 'not_dispatched' },
    });
    expect(f.posts).toHaveLength(1);
    expect(
      await f.read('returns.created.read', {
        limit: 5,
        order: ref('40'),
        lumaCaseId: caseId,
      }),
    ).toMatchObject({
      ok: true,
      value: {
        items: [
          {
            source: { externalId: '81' },
            data: {
              lines: [
                {
                  orderLine: ref('400', '40'),
                  quantity: { amount: '2', unit: 'each' },
                  reason: ref('1'),
                },
              ],
            },
          },
        ],
      },
    });

    const other = fixture();
    await other.create();
    expect(other.posts[0]!.key).toBe(f.posts[0]!.key);
    const changed = fixture();
    await changed.create(changed.creation, 'another-action');
    expect(changed.posts[0]!.key).not.toBe(f.posts[0]!.key);
  });

  it.each([
    [
      'a cancelled order',
      'conflict',
      (f: ReturnType<typeof fixture>) => (f.order.isCancelled = true),
    ],
    [
      'a line of another order',
      'invalid_input',
      (f: ReturnType<typeof fixture>) =>
        (f.creation.lines[0]!.orderLine = ref('499', '40')),
    ],
    [
      'more than was ordered',
      'conflict',
      (f: ReturnType<typeof fixture>) =>
        (f.creation.lines[0]!.quantity = { amount: '3.5', unit: 'each' }),
    ],
    [
      'a line not counted in each',
      'conflict',
      (f: ReturnType<typeof fixture>) =>
        (f.creation.lines[0]!.orderLine = ref('401', '40')),
    ],
    [
      'an existing return for the case',
      'conflict',
      (f: ReturnType<typeof fixture>) =>
        (f.returns[0]!.externalNumber = lumaReturnMarker(caseId)),
    ],
    [
      'a return scan that cannot rule one out',
      'conflict',
      (f: ReturnType<typeof fixture>) =>
        f.returns.push(
          ...Array.from({ length: 500 }, (_, index) => ({
            ...f.returns[0]!,
            id: String(1000 + index),
          })),
        ),
    ],
  ])('refuses %s before dispatch', async (_name, code, change) => {
    const f = fixture();
    change(f);
    expect(await f.create()).toEqual({
      ok: false,
      error: {
        code,
        effect: 'none',
        retry: 'never',
        dispatch: 'not_dispatched',
      },
    });
    expect(f.methods()).not.toContain('POST');
  });

  it('rejects lines outside the order, missing keys and disabled actions', async () => {
    const f = fixture();
    expect(
      await f.create({
        ...f.creation,
        lines: [
          {
            orderLine: ref('400', '41'),
            quantity: { amount: '1', unit: 'each' },
          },
        ],
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(
      await f.create({
        ...f.creation,
        lines: [
          {
            orderLine: ref('400', '40'),
            quantity: { amount: '1', unit: 'kg' },
          },
        ],
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(await f.create(f.creation, ' ')).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(
      createJtlConnector({ ...f.options, returnActions: false }).capabilities[
        'returns.create'
      ],
    ).toBeUndefined();
  });

  it('marks pre-dispatch read failures as not dispatched', async () => {
    const f = fixture();
    f.fetch.mockImplementation(
      async () => new Response('busy', { status: 503 }),
    );
    expect(await f.create()).toMatchObject({
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
    expect(await f.create()).toMatchObject({
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
    expect(await f.create()).toEqual({
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
    f.order.id = cloudId(40);
    f.order.companyId = cloudId(2);
    f.orderLines[0]!.id = cloudId(400);
    f.orderLines[0]!.salesOrderId = cloudId(40);
    f.orderLines[1]!.salesOrderId = cloudId(40);
    expect(
      await f.create({
        ...f.creation,
        order: ref(cloudId(40)),
        warehouse: ref(cloudId(3)),
        reason: ref(cloudId(4)),
        lines: [
          {
            orderLine: ref(cloudId(400), cloudId(40)),
            quantity: { amount: '1', unit: 'each' },
          },
        ],
      }),
    ).toMatchObject({ ok: true });
    expect(f.posts[0]!.body).toMatchObject({
      companyId: cloudId(2),
      salesOrderId: cloudId(40),
      warehouseId: cloudId(3),
      items: [
        { salesOrderLineItemId: cloudId(400), returnReasonId: cloudId(4) },
      ],
    });
  });
});

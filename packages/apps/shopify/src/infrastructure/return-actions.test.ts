import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { InvocationContext } from '@luma/connections';
import { buildSchema, parse as parseGraphql, validate } from 'graphql';
import { describe, expect, it, vi } from 'vitest';

import { createShopifyReturnCapabilities } from './return-actions.js';

const order = 'gid://shopify/Order/1';
const line = 'gid://shopify/LineItem/2';
const returned = 'gid://shopify/Return/3';
const shipped = 'gid://shopify/FulfillmentLineItem/4';
const caseId = randomUUID();
const ref = (externalId: string, scopeKey = '') => ({ externalId, scopeKey });
const input = {
  lumaCaseId: caseId,
  order: ref(order),
  warehouse: ref('shopify'),
  reason: ref('OTHER'),
  lines: [
    { orderLine: ref(line, order), quantity: { amount: '1', unit: 'each' } },
  ],
};
const context = {
  tenant: { tenantId: 'tenant-a' },
  connectionId: 'store',
  provider: 'shopify',
  idempotencyKey: 'one',
} as InvocationContext;
const page = <T>(nodes: T[], partial = false) => ({
  nodes,
  pageInfo: { hasNextPage: partial },
});
const schema = buildSchema(
  readFileSync(
    new URL('./fixtures/admin-2026-07.graphql', import.meta.url),
    'utf8',
  ),
);

function fixture() {
  let rows: {
    id: string;
    name: string;
    status: string;
    createdAt: string;
    returnLineItems: ReturnType<
      typeof page<{
        quantity: number;
        returnReasonNote: string | null;
        fulfillmentLineItem: { id: string; lineItem: { id: string } };
      }>
    >;
  }[] = [];
  let lost = false,
    partial = false,
    writes = 0;
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const { query, variables } = JSON.parse(String(init?.body));
    expect(validate(schema, parseGraphql(query))).toEqual([]);
    if (query.includes('LumaReturnActions'))
      return Response.json({
        data: { node: { id: order, returns: page(rows, partial) } },
      });
    if (query.includes('LumaReturnable'))
      return Response.json({
        data: {
          node: {
            id: order,
            fulfillments: [
              {
                status: 'SUCCESS',
                fulfillmentLineItems: page([
                  { id: shipped, quantity: 2, lineItem: { id: line } },
                ]),
              },
            ],
          },
        },
      });
    writes++;
    if (query.includes('LumaReturnCreate'))
      rows = [row('OPEN', `luma-rc:${caseId}`)];
    else {
      expect(variables.input.id).toBe(returned);
      rows[0]!.status = 'OPEN';
    }
    if (lost) throw new Error('Response lost after commit');

    return Response.json({
      data: { result: { return: { id: returned }, userErrors: [] } },
    });
  });
  const record = vi.fn(async () => undefined);
  const caps = createShopifyReturnCapabilities({
    tenantId: 'tenant-a',
    connectionId: 'store',
    shop: 'test.myshopify.com',
    readRetry: { attempts: 1, maxDelayMs: 0, sleep: async () => undefined },
    accessToken: async () => 'token',
    fetch,
    recordObservations: record,
  });
  const create = (value: unknown = input, invocation = context) =>
    caps['returns.create']!.run(
      invocation,
      caps['returns.create']!.parseInput(value),
    );
  const lookup = (requested = false) =>
    caps['returns.created.read']!.run(
      context,
      caps['returns.created.read']!.parseInput({
        limit: 25,
        order: ref(order),
        lumaCaseId: caseId,
        ...(requested ? { requestedReturn: ref(returned) } : {}),
      }),
    );

  return {
    create,
    lookup,
    record,
    fetch,
    setRows: (v: typeof rows) => {
      rows = v;
    },
    lose: () => {
      lost = true;
    },
    partial: () => {
      partial = true;
    },
    writes: () => writes,
  };
}

function row(status = 'OPEN', note: string | null = `luma-rc:${caseId}`) {
  return {
    id: returned,
    name: '#1-R1',
    status,
    createdAt: '2026-10-11T00:00:00Z',
    returnLineItems: page([
      {
        quantity: 1,
        returnReasonNote: note,
        fulfillmentLineItem: { id: shipped, lineItem: { id: line } },
      },
    ]),
  };
}

describe('Shopify return actions', () => {
  it('creates once and finds the exact case marker through an independent read', async () => {
    const f = fixture();
    expect(await f.create()).toMatchObject({ status: 'accepted' });
    expect(await f.lookup()).toMatchObject({
      completeness: 'complete',
      items: [
        {
          data: {
            lumaCaseId: caseId,
            lines: [{ orderLine: ref(line, order), quantity: { amount: '1' } }],
          },
        },
      ],
    });
    await expect(f.create()).rejects.toMatchObject({
      failure: { dispatch: 'not_dispatched' },
    });
    expect(f.writes()).toBe(1);
  });
  it('reconciles a lost response without another mutation', async () => {
    const f = fixture();
    f.lose();
    await expect(f.create()).rejects.toMatchObject({
      failure: { dispatch: 'uncertain', retry: 'reconcile' },
    });
    expect((await f.lookup()).items).toHaveLength(1);
    expect(f.writes()).toBe(1);
  });
  it('approves exactly the requested return and never treats REQUESTED as approved', async () => {
    const f = fixture();
    f.setRows([row('REQUESTED', null)]);
    expect((await f.lookup(true)).items).toHaveLength(0);
    await f.create({ ...input, requestedReturn: ref(returned) });
    expect((await f.lookup(true)).items).toHaveLength(1);
    expect(f.writes()).toBe(1);
  });
  it('refuses partial reads, changed quantities and cross-tenant dispatch', async () => {
    const f = fixture();
    f.partial();
    await expect(f.create()).rejects.toMatchObject({
      failure: { dispatch: 'not_dispatched' },
    });
    expect((await f.lookup()).completeness).toBe('partial');
    const changed = fixture();
    changed.setRows([row('REQUESTED', null)]);
    await expect(
      changed.create({
        ...input,
        requestedReturn: ref(returned),
        lines: [{ ...input.lines[0], quantity: { amount: '2', unit: 'each' } }],
      }),
    ).rejects.toMatchObject({ failure: { dispatch: 'not_dispatched' } });
    expect(changed.writes()).toBe(0);
    const foreign = fixture();
    await expect(
      foreign.create(input, {
        ...context,
        tenant: { ...context.tenant, tenantId: 'tenant-b' },
      }),
    ).rejects.toThrow();
    expect(foreign.fetch).not.toHaveBeenCalled();
  });
  it('does not persist unrelated customer notes or infer identity from matching quantities', async () => {
    const f = fixture();
    f.setRows([row('OPEN', 'Customer personal information')]);
    expect((await f.lookup()).items).toHaveLength(0);
    expect(JSON.stringify(f.record.mock.calls)).not.toContain(
      'Customer personal information',
    );
  });
});

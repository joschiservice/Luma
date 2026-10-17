import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { InvocationContext } from '@luma/connections';
import { buildSchema, parse as parseGraphql, validate } from 'graphql';
import { describe, expect, it, vi } from 'vitest';

import { createShopifySettlementCapabilities } from './return-settlement.js';

const ref = (externalId: string, scopeKey = '') => ({ externalId, scopeKey });
const order = 'gid://shopify/Order/1';
const line = 'gid://shopify/LineItem/2';
const parent = 'gid://shopify/OrderTransaction/3';
const amountSet = {
  presentmentMoney: { amount: '48.00', currencyCode: 'EUR' },
};
const input = {
  kind: 'refund',
  order: ref(order),
  lines: [{ orderLine: ref(line, order), quantity: 2 }],
};
const operationId = randomUUID();
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
const context = {
  tenant: { tenantId: 'tenant-a' },
  connectionId: 'store',
  provider: 'shopify',
  idempotencyKey: operationId,
} as InvocationContext;

function fixture() {
  let refunds: unknown[] = [],
    writes = 0;
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const { query, variables } = JSON.parse(String(init?.body));
    expect(validate(schema, parseGraphql(query))).toEqual([]);
    if (query.includes('LumaReturnRefundQuote'))
      return Response.json({
        data: {
          node: {
            id: order,
            suggestedRefund: {
              amountSet,
              maximumRefundableSet: amountSet,
              refundLineItems: [{ quantity: 2, lineItem: { id: line } }],
              suggestedTransactions: [
                {
                  amountSet,
                  gateway: 'shopify_payments',
                  kind: 'SUGGESTED_REFUND',
                  parentTransaction: { id: parent },
                },
              ],
            },
          },
        },
      });
    if (query.includes('LumaReturnRefundDetail'))
      return Response.json({ data: { node: refunds[0] } });
    if (query.includes('LumaReturnRefundProof'))
      return Response.json({ data: { node: { id: order, refunds } } });
    writes++;
    expect(variables.key).toBe(operationId);
    expect(variables.input).toMatchObject({
      orderId: order,
      notify: false,
      allowOverRefunding: false,
      note: `luma-rs:${operationId}`,
      refundLineItems: [
        { lineItemId: line, quantity: 2, restockType: 'NO_RESTOCK' },
      ],
    });

    return Response.json({
      data: {
        refundCreate: {
          refund: { id: 'gid://shopify/Refund/4' },
          userErrors: [],
        },
      },
    });
  });
  const caps = createShopifySettlementCapabilities({
    tenantId: 'tenant-a',
    connectionId: 'store',
    shop: 'test.myshopify.com',
    accessToken: async () => 'token',
    fetch,
    recordObservations: vi.fn(async () => undefined),
    readRetry: { attempts: 1, maxDelayMs: 0, sleep: async () => undefined },
  });
  const quote = () =>
    caps['returns.settlement.quote.read']!.run(
      context,
      caps['returns.settlement.quote.read']!.parseInput(input),
    );
  const proof = (plan: unknown) =>
    caps['returns.settlement.proof.read']!.run(
      context,
      caps['returns.settlement.proof.read']!.parseInput({ operationId, plan }),
    );
  const send = (plan: unknown, invocation = context) =>
    caps['returns.refund']!.run(
      invocation,
      caps['returns.refund']!.parseInput({ operationId, plan }),
    );

  return {
    quote,
    proof,
    send,
    fetch,
    writes: () => writes,
    setRefunds: (value: unknown[]) => {
      refunds = value;
    },
  };
}

function refund(status = 'SUCCESS', partial = false) {
  return {
    id: 'gid://shopify/Refund/4',
    note: `luma-rs:${operationId}`,
    refundLineItems: page(
      [
        {
          quantity: 2,
          lineItem: { id: line },
          restockType: 'NO_RESTOCK',
          restocked: false,
        },
      ],
      partial,
    ),
    transactions: page([
      {
        kind: 'REFUND',
        status,
        amountSet,
        processedAt: null,
        gateway: 'shopify_payments',
        parentTransaction: { id: parent },
      },
    ]),
  };
}

describe('Shopify settlement boundary', () => {
  it('uses the native idempotency key and never combines refund with stock changes', async () => {
    const f = fixture(),
      quoted = await f.quote();
    await f.send(quoted.plan);
    expect(f.writes()).toBe(1);
  });
  it('distinguishes an exactly bound partial refund from fully settled money', async () => {
    const f = fixture(),
      quoted = await f.quote();
    const other = 'gid://shopify/OrderTransaction/5';
    const plan = {
      ...quoted.plan,
      transactions: [
        { parentId: parent, gateway: 'shopify_payments', amount: '24' },
        { parentId: other, gateway: 'shopify_payments', amount: '24' },
      ],
    };
    const source = refund();
    source.transactions = page([
      {
        ...source.transactions.nodes[0]!,
        amountSet: { presentmentMoney: { amount: '24', currencyCode: 'EUR' } },
      },
      {
        ...source.transactions.nodes[0]!,
        status: 'PENDING',
        parentTransaction: { id: other },
        amountSet: { presentmentMoney: { amount: '24', currencyCode: 'EUR' } },
      },
    ]);
    f.setRefunds([source]);
    expect(await f.proof(plan)).toMatchObject({
      outcome: 'inconclusive',
      payment: 'partial',
    });
    source.transactions.nodes[1]!.status = 'SUCCESS';
    expect(await f.proof(plan)).toMatchObject({
      outcome: 'passed',
      payment: 'paid',
    });
  });
  it('requires one complete exact refund and successful captured-payment transactions', async () => {
    const f = fixture(),
      quoted = await f.quote();
    f.setRefunds([refund('PENDING')]);
    expect(await f.proof(quoted.plan)).toMatchObject({
      outcome: 'inconclusive',
      payment: 'pending',
    });
    f.setRefunds([refund('FAILURE')]);
    expect(await f.proof(quoted.plan)).toMatchObject({
      outcome: 'failed',
      payment: 'failed',
    });
    f.setRefunds([refund()]);
    expect(await f.proof(quoted.plan)).toMatchObject({
      outcome: 'passed',
      payment: 'paid',
    });
    f.setRefunds([refund('SUCCESS', true)]);
    expect(await f.proof(quoted.plan)).toMatchObject({
      outcome: 'inconclusive',
      payment: null,
    });
    f.setRefunds([refund(), refund()]);
    expect(await f.proof(quoted.plan)).toMatchObject({
      outcome: 'inconclusive',
      payment: null,
    });
    await expect(f.send(quoted.plan)).rejects.toMatchObject({
      failure: { code: 'conflict', dispatch: 'not_dispatched' },
    });
    expect(f.writes()).toBe(0);
  });
  it('returns the read each evidence reference names, partial when a page was cut short', async () => {
    const f = fixture(),
      quoted = await f.quote();
    expect(quoted.reads).toEqual([
      expect.objectContaining({
        id: quoted.evidenceRefs[0],
        completeness: 'complete',
        data: quoted.plan,
      }),
    ]);
    f.setRefunds([refund()]);
    const complete = await f.proof(quoted.plan);
    expect(complete.reads).toEqual([
      expect.objectContaining({
        id: complete.evidenceRefs[0],
        source: expect.objectContaining({
          provider: 'shopify',
          resource: 'refund',
          connectionId: 'store',
        }),
        completeness: 'complete',
      }),
    ]);
    f.setRefunds([refund('SUCCESS', true)]);
    expect((await f.proof(quoted.plan)).reads).toEqual([
      expect.objectContaining({ completeness: 'partial' }),
    ]);
  });
  it('rejects tenant or connection changes before making a provider request', async () => {
    const f = fixture(),
      quoted = await f.quote();
    f.fetch.mockClear();
    await expect(
      f.send(quoted.plan, {
        ...context,
        tenant: { ...context.tenant, tenantId: 'tenant-b' },
      }),
    ).rejects.toMatchObject({ failure: { dispatch: 'not_dispatched' } });
    await expect(
      f.send(quoted.plan, { ...context, connectionId: 'another' }),
    ).rejects.toMatchObject({ failure: { dispatch: 'not_dispatched' } });
    expect(f.fetch).not.toHaveBeenCalled();
  });
});

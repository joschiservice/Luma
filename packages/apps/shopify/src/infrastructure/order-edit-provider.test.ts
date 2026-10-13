import { readFileSync } from 'node:fs';

import { ConnectorError } from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import { buildSchema, parse as parseGraphql, validate } from 'graphql';
import { describe, expect, it, vi } from 'vitest';

import { type EditFence, editOutcome } from '../domain/order-edits.js';
import {
  calculationDigest,
  createOrderEditProvider,
  type OrderEditEvidence,
} from './order-edit-provider.js';

const schema = buildSchema(
  readFileSync(
    new URL('./fixtures/admin-2026-07.graphql', import.meta.url),
    'utf8',
  ),
);

const gid = (kind: string, value = 1) => `gid://shopify/${kind}/${value}`;
const tenantId = '11111111-1111-4111-8111-111111111111';
const connectionId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const money = (amount: string) => ({
  shopMoney: { amount, currencyCode: 'EUR' },
  presentmentMoney: { amount, currencyCode: 'EUR' },
});

function fixture() {
  const order = {
    id: gid('Order'),
    updatedAt: '2026-10-12T09:00:00Z',
    cancelledAt: null as string | null,
    closed: false,
    currencyCode: 'EUR',
    presentmentCurrencyCode: 'EUR',
    currentSubtotalPriceSet: money('60.00'),
    currentTotalPriceSet: money('60.00'),
    totalOutstandingSet: money('0.00'),
    lineItems: {
      nodes: [
        {
          id: gid('LineItem'),
          name: 'Tote',
          sku: 'TOTE',
          quantity: 3,
          currentQuantity: 3,
          unfulfilledQuantity: 3,
        },
      ],
      pageInfo: { hasNextPage: false },
    },
    fulfillmentOrders: {
      nodes: [
        {
          id: gid('FulfillmentOrder'),
          status: 'OPEN',
          requestStatus: 'UNSUBMITTED',
          lineItems: {
            nodes: [
              {
                lineItem: { id: gid('LineItem') },
                remainingQuantity: 3,
                totalQuantity: 3,
              },
            ],
            pageInfo: { hasNextPage: false },
          },
        },
      ],
      pageInfo: { hasNextPage: false },
    },
  };
  const calculated = {
    id: gid('CalculatedOrder', 7),
    subtotalPriceSet: money('20.00'),
    totalPriceSet: money('20.00'),
    totalOutstandingSet: money('0.00'),
    lineItems: {
      nodes: [{ id: gid('CalculatedLineItem'), quantity: 1 }],
      pageInfo: { hasNextPage: false },
    },
  };
  const agreements: unknown[] = [];
  const requests: { query: string; variables: Record<string, unknown> }[] = [];
  const faults = {
    lose: false,
    commitErrors: false,
    stageErrors: false,
  };
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    expect(validate(schema, parseGraphql(body.query))).toEqual([]);
    requests.push(body);
    const errors = (on: boolean) =>
      on ? [{ field: ['id'], message: 'Refused' }] : [];
    if (body.query.includes('orderEditBegin'))
      return Response.json({
        data: {
          result: { calculatedOrder: { id: calculated.id }, userErrors: [] },
        },
      });
    if (body.query.includes('orderEditSetQuantity'))
      return Response.json({
        data: {
          result: {
            calculatedOrder: faults.stageErrors ? null : calculated,
            userErrors: errors(faults.stageErrors),
          },
        },
      });
    if (body.query.includes('orderEditCommit')) {
      if (faults.lose) throw new Error('connection lost');

      return Response.json({
        data: {
          result: {
            order: faults.commitErrors
              ? null
              : { id: order.id, updatedAt: '2026-10-12T10:00:02Z' },
            userErrors: errors(faults.commitErrors),
          },
        },
      });
    }
    if (body.query.includes('LumaOrderEditProof'))
      return Response.json({
        data: {
          currentAppInstallation: { app: { id: gid('App') } },
          node: {
            id: order.id,
            updatedAt: order.updatedAt,
            cancelledAt: order.cancelledAt,
            lineItems: {
              nodes: order.lineItems.nodes.map((line) => ({
                id: line.id,
                currentQuantity: line.currentQuantity,
              })),
              pageInfo: { hasNextPage: false },
            },
            agreements: { nodes: agreements, pageInfo: { hasNextPage: false } },
          },
        },
      });

    return Response.json({ data: { node: order } });
  });
  const evidence: OrderEditEvidence[] = [];
  let fence: EditFence | null = null;
  const eligible = vi.fn(async () => true);
  const provider = createOrderEditProvider({
    tenantId,
    connectionId,
    shop: 'edits.myshopify.com',
    accessToken: async () => 'token',
    fetch: transport,
    record: async (value) => {
      evidence.push(value);
    },
    eligible,
    fence: {
      reserve: async () => {
        if (fence) return false;
        fence = { state: 'reserved', sentAt: null };

        return true;
      },
      send: async () => {
        if (fence?.state !== 'reserved') return false;
        fence = { state: 'sent', sentAt: '2026-10-12T10:00:00.000Z' };

        return true;
      },
      finish: async (_id, state) => {
        if (
          (state === 'withheld' && fence?.state === 'reserved') ||
          (state !== 'withheld' && fence?.state === 'sent')
        )
          fence = { state, sentAt: fence.sentAt };
      },
    },
    now: () => new Date('2026-10-12T10:00:00.000Z'),
  });
  const context = {
    tenant: { tenantId } as TenantContext,
    connectionId,
    provider: 'shopify',
    idempotencyKey: `v0:${operationId}`,
  };
  const input = async () => {
    const { revision } = await provider.read(order.id);
    const { calculation } = await provider.calculate(
      order.id,
      [{ lineItemId: gid('LineItem'), currentQuantity: 3, quantity: 1 }],
      true,
    );
    requests.length = 0;

    return {
      operationId,
      orderId: order.id,
      expectedRevision: revision,
      restock: true,
      lines: [{ lineItemId: gid('LineItem'), currentQuantity: 3, quantity: 1 }],
      calculationDigest: calculationDigest(calculation),
    };
  };

  return {
    order,
    calculated,
    agreements,
    requests,
    faults,
    evidence,
    eligible,
    provider,
    context,
    input,
    fence: () => fence,
  };
}

const sent = (requests: { query: string }[], field: string) =>
  requests.filter((request) => request.query.includes(field)).length;

describe('Shopify order edit provider', () => {
  it('reads lines, totals and fulfillment work and records the observation', async () => {
    const f = fixture();
    const snapshot = await f.provider.read(f.order.id);
    expect(snapshot).toMatchObject({
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
      updatedAt: '2026-10-12T09:00:00Z',
      cancelled: false,
      complete: true,
      totals: { total: { shop: { amount: '60.00', currencyCode: 'EUR' } } },
      lines: [
        { id: gid('LineItem'), currentQuantity: 3, unfulfilledQuantity: 3 },
      ],
      fulfillmentOrders: [
        {
          status: 'OPEN',
          lines: [{ lineItemId: gid('LineItem'), remaining: 3, total: 3 }],
        },
      ],
    });
    expect(f.evidence.map((item) => item.kind)).toEqual(['observation']);
    f.order.fulfillmentOrders.nodes[0]!.lineItems.pageInfo.hasNextPage = true;
    expect((await f.provider.read(f.order.id)).complete).toBe(false);
  });

  it('calculates without committing and restocks only reductions', async () => {
    const f = fixture();
    const { calculation } = await f.provider.calculate(
      f.order.id,
      [{ lineItemId: gid('LineItem'), currentQuantity: 3, quantity: 1 }],
      true,
    );
    expect(calculation).toMatchObject({
      total: { shop: { amount: '20.00' } },
      lines: [{ lineItemId: gid('LineItem'), quantity: 1 }],
    });
    expect(sent(f.requests, 'orderEditCommit')).toBe(0);
    expect(f.requests[1]!.variables).toMatchObject({
      id: gid('CalculatedOrder', 7),
      lineItemId: gid('CalculatedLineItem'),
      quantity: 1,
      restock: true,
    });
    f.calculated.lineItems.nodes[0]!.quantity = 4;
    await f.provider.calculate(
      f.order.id,
      [{ lineItemId: gid('LineItem'), currentQuantity: 3, quantity: 4 }],
      true,
    );
    expect(f.requests.at(-1)!.variables.restock).toBe(false);
    f.faults.stageErrors = true;
    await expect(
      f.provider.calculate(
        f.order.id,
        [{ lineItemId: gid('LineItem'), currentQuantity: 3, quantity: 1 }],
        true,
      ),
    ).rejects.toMatchObject({ failure: { code: 'conflict', effect: 'none' } });
  });

  it('commits once with notifications off and Luma’s marker', async () => {
    const f = fixture();
    const receipt = await f.provider.handler.run(f.context, await f.input());
    expect(receipt.status).toBe('accepted');
    expect(sent(f.requests, 'orderEditCommit')).toBe(1);
    const commit = f.requests.find((request) =>
      request.query.includes('orderEditCommit'),
    )!;
    expect(commit.query).toContain('notifyCustomer: false');
    expect(commit.variables).toEqual({
      id: gid('CalculatedOrder', 7),
      staffNote: `luma-oe:${operationId}`,
    });
    expect(f.fence()).toMatchObject({ state: 'accepted' });
    expect(f.evidence.at(-1)!.kind).toBe('acceptance');
    // A repeated call never reaches Shopify again.
    await expect(
      f.provider.handler.run(f.context, await f.input()),
    ).rejects.toMatchObject({ failure: { dispatch: 'uncertain' } });
    expect(f.requests).toEqual([]);
  });

  it('withholds a changed order or calculation before sending anything', async () => {
    const f = fixture();
    const input = await f.input();
    f.order.updatedAt = '2026-10-12T09:30:00Z';
    await expect(
      f.provider.handler.run(f.context, input),
    ).rejects.toMatchObject({
      failure: { dispatch: 'not_dispatched', effect: 'none' },
    });
    expect(sent(f.requests, 'orderEditBegin')).toBe(0);
    expect(f.fence()).toMatchObject({ state: 'withheld' });

    const g = fixture();
    const changed = await g.input();
    g.calculated.totalPriceSet = money('25.00');
    await expect(
      g.provider.handler.run(g.context, changed),
    ).rejects.toMatchObject({ failure: { dispatch: 'not_dispatched' } });
    expect(sent(g.requests, 'orderEditCommit')).toBe(0);
    expect(g.fence()).toMatchObject({ state: 'withheld', sentAt: null });

    const h = fixture();
    h.eligible.mockResolvedValue(false);
    await expect(
      h.provider.handler.run(h.context, await h.input()),
    ).rejects.toMatchObject({ failure: { dispatch: 'not_dispatched' } });
    expect(sent(h.requests, 'orderEditBegin')).toBe(0);
  });

  it('records a refused commit as rejected without effect', async () => {
    const f = fixture();
    f.faults.commitErrors = true;
    await expect(
      f.provider.handler.run(f.context, await f.input()),
    ).rejects.toMatchObject({ failure: { dispatch: 'not_dispatched' } });
    expect(f.fence()).toMatchObject({ state: 'rejected' });
  });

  it('keeps a lost commit uncertain and reconciles it from Shopify’s edit agreement', async () => {
    const f = fixture();
    f.faults.lose = true;
    const error = await f.provider.handler
      .run(f.context, await f.input())
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ConnectorError);
    expect((error as ConnectorError).failure).toMatchObject({
      dispatch: 'uncertain',
      effect: 'unknown',
      retry: 'reconcile',
    });
    expect(f.fence()).toMatchObject({ state: 'sent' });
    expect(sent(f.requests, 'orderEditCommit')).toBe(1);

    // Shopify committed: the agreement carries Luma's app and the removed units.
    f.order.lineItems.nodes[0]!.currentQuantity = 1;
    f.agreements.push({
      __typename: 'OrderEditAgreement',
      id: gid('OrderEditAgreement'),
      happenedAt: '2026-10-12T10:00:01Z',
      reason: 'ORDER_EDIT',
      app: { id: gid('App') },
      sales: {
        nodes: [
          {
            __typename: 'ProductSale',
            actionType: 'RETURN',
            lineType: 'PRODUCT',
            quantity: -2,
            lineItem: { id: gid('LineItem') },
          },
        ],
        pageInfo: { hasNextPage: false },
      },
    });
    const proof = await f.provider.proof(f.order.id, f.fence()!.sentAt!);
    expect(f.requests.at(-1)!.variables.query).toBe(
      "happened_at:>='2026-10-12T09:50:00.000Z'",
    );
    expect(proof.agreements[0]!.deltas).toEqual({ [gid('LineItem')]: -2 });
    expect(
      editOutcome(
        [{ lineItemId: gid('LineItem'), currentQuantity: 3, quantity: 1 }],
        f.fence(),
        proof,
        new Date('2026-10-12T10:01:00Z'),
      ),
    ).toBe('committed');
    expect(sent(f.requests, 'orderEditCommit')).toBe(1);
  });
});

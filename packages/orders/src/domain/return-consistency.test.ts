import { describe, expect, it } from 'vitest';

import type { ReturnAction } from './return-actions.js';
import type { ReturnCase } from './return-cases.js';
import {
  exchangeConsistency,
  type ExchangeConsistencyEvidence,
} from './return-consistency.js';
import type { ExchangeStep, ReturnExchange } from './return-exchanges.js';

const at = '2026-10-12T12:00:00.000Z',
  now = new Date(at),
  ref = (externalId: string) => ({ externalId, scopeKey: '' });
const decided = {
  by: 'owner',
  at,
  evidence: { note: 'Counted and inspected', link: null },
};
const value: ReturnCase = {
  id: 'case',
  tenantId: 'tenant',
  orderId: 'order',
  connectionId: 'shop',
  sourceReturnId: null,
  state: 'open',
  assigneeId: 'assignee',
  openedBy: 'owner',
  openedAt: at,
  updatedAt: at,
  revision: 4,
  cancellation: null,
  lines: [
    {
      orderLineId: 'line',
      quantity: 2,
      title: null,
      sku: null,
      reason: 'size_or_fit',
      note: null,
    },
  ],
  receipt: { ...decided, lines: [{ orderLineId: 'line', received: 2 }] },
  inspection: {
    ...decided,
    lines: [{ orderLineId: 'line', resellable: 2, damaged: 0 }],
  },
  proposal: {
    ...decided,
    kind: 'exchange',
    lines: [{ orderLineId: 'line', restock: 2 }],
  },
};
const replacement = {
  skuId: 'sku',
  mappingIds: ['shop-map', 'wawi-map'],
  inventoryItem: ref('shop-item'),
  variantId: 'variant',
  wawiConnectionId: 'wawi',
  item: ref('wawi-item'),
  quantity: 2,
};
const root: ReturnExchange = {
  id: 'operation',
  tenantId: 'tenant',
  caseId: 'case',
  connectionId: 'shop',
  startedBy: 'owner',
  startedAt: at,
  ownerId: 'assignee',
  revision: 1,
  choice: null,
  currentAttemptId: 'request',
  replacementName: 'Replacement',
  request: {
    kind: 'request',
    marker: 'marker',
    order: ref('shop-order'),
    lines: [
      {
        orderLineId: 'line',
        source: ref('source-line'),
        quantity: 2,
        reason: 'size_or_fit',
      },
    ],
    replacement,
  },
  availability: null,
  processingStarted: true,
  updatedAt: at,
};
const financial = {
  kind: 'refund' as const,
  amount: '2',
  currency: 'EUR',
  transactions: [],
  priorSuccessfulTransactionIds: [],
};
const process: ExchangeStep = {
  id: 'process',
  actionId: 'action',
  operationId: 'operation',
  tenantId: 'tenant',
  caseId: 'case',
  connectionId: 'shop',
  plan: {
    kind: 'process',
    marker: 'marker',
    order: ref('shop-order'),
    returnId: 'return',
    returnLines: [{ id: 'return-line', quantity: 2 }],
    exchangeLine: { id: 'exchange-line', quantity: 2 },
    replacement,
    financial,
  },
  caseDigest: 'digest',
  requestDigest: 'digest',
  quote: { observedAt: at, evidenceRefs: ['quote'] },
  requestedBy: 'owner',
  requestedAt: at,
  expiresAt: at,
  decisionId: 'decision',
  decidedBy: 'approver',
  decidedAt: at,
  state: 'verified',
  sent: true,
  proof: null,
  failure: null,
  updatedAt: at,
};
const action: ReturnAction = {
  id: 'stock',
  tenantId: 'tenant',
  caseId: 'case',
  connectionId: 'wawi',
  orderLineId: 'line',
  kind: 'restock',
  mappingIds: ['map'],
  plan: {
    kind: 'restock',
    item: ref('original-item'),
    warehouse: ref('warehouse'),
    quantity: 2,
    baselineOnHand: '98',
  },
  quote: { observedAt: at, evidenceRefs: ['quote'] },
  caseDigest: 'digest',
  requestDigest: 'digest',
  actionId: 'action',
  requestedBy: 'owner',
  requestedAt: at,
  expiresAt: at,
  decisionId: 'decision',
  decidedBy: 'approver',
  decidedAt: at,
  state: 'verified',
  sent: true,
  proof: null,
  failure: null,
  updatedAt: at,
};
const read = { observedAt: at, evidenceRefs: ['source-read'] };
const evidence: ExchangeConsistencyEvidence = {
  shopify: {
    ...read,
    outcome: 'passed',
    returnId: 'return',
    processLines: null,
    fulfillmentOrderId: 'work',
    paymentHoldId: null,
    fulfillmentReady: true,
    payment: 'paid',
    financial,
  },
  price: { ...read, total: { amount: '46.00', currency: 'EUR' } },
  returns: {
    ...read,
    complete: true,
    lines: [
      {
        source: ref('source-line'),
        quantity: '2',
        received: '2',
        restocked: '2',
      },
    ],
  },
  wawi: {
    ...read,
    complete: true,
    orders: [
      {
        id: ref('erp-order'),
        total: { amount: '46', currency: 'EUR' },
        paid: true,
        cancelled: false,
        exactLines: true,
        quantity: '2',
        reserved: '2',
      },
    ],
  },
  stock: [{ action, proof: { ...read, outcome: 'passed', payment: null } }],
};

describe('final exchange consistency', () => {
  it('requires each independent source step and retains current ownership', () => {
    expect(
      exchangeConsistency(value, root, process, evidence, now),
    ).toMatchObject({
      state: 'verified',
      ownerId: 'assignee',
      replacementOrder: ref('erp-order'),
    });
    const incomplete = exchangeConsistency(
      {
        ...value,
        receipt: {
          ...value.receipt!,
          lines: [{ orderLineId: 'line', received: 1 }],
        },
      },
      root,
      process,
      evidence,
      now,
    );
    expect(incomplete.state).toBe('unresolved');
    expect(incomplete.checks.find((c) => c.id === 'receipt')?.verified).toBe(
      false,
    );
  });
  it.each(['pending', 'failed', 'partial', 'unknown'] as const)(
    'never completes on %s money',
    (payment) => {
      expect(
        exchangeConsistency(
          value,
          root,
          process,
          { ...evidence, shopify: { ...evidence.shopify!, payment } },
          now,
        ).checks.find((c) => c.id === 'payment')?.verified,
      ).toBe(false);
    },
  );
  it('keeps duplicate, wrong-price, unreserved and truncated ERP reads unresolved', () => {
    for (const wawi of [
      null,
      { ...evidence.wawi!, complete: false },
      {
        ...evidence.wawi!,
        orders: [...evidence.wawi!.orders, ...evidence.wawi!.orders],
      },
      {
        ...evidence.wawi!,
        orders: [{ ...evidence.wawi!.orders[0]!, reserved: '1' }],
      },
      {
        ...evidence.wawi!,
        orders: [
          {
            ...evidence.wawi!.orders[0]!,
            total: { amount: '47', currency: 'EUR' },
          },
        ],
      },
    ])
      expect(
        exchangeConsistency(value, root, process, { ...evidence, wawi }, now)
          .state,
      ).toBe('unresolved');
  });
  it('rejects missing, stale and future proof and never calls an inspection note a disposal', () => {
    for (const at of [
      null,
      '2026-10-12T11:54:59.000Z',
      '2026-10-12T12:00:01.000Z',
    ])
      expect(
        exchangeConsistency(
          value,
          root,
          process,
          {
            ...evidence,
            shopify: at ? { ...evidence.shopify!, observedAt: at } : null,
          },
          now,
        ).state,
      ).toBe('unresolved');
    const damaged = {
      ...value,
      inspection: {
        ...value.inspection!,
        lines: [{ orderLineId: 'line', resellable: 1, damaged: 1 }],
      },
      proposal: {
        ...value.proposal!,
        lines: [{ orderLineId: 'line', restock: 1 }],
      },
    };
    expect(
      exchangeConsistency(damaged, root, process, evidence, now).checks.find(
        (c) => c.id === 'stock',
      ),
    ).toMatchObject({ verified: false, reason: 'writeoff_unverified' });
  });
});

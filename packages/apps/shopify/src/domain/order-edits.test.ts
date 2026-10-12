import { describe, expect, it } from 'vitest';

import {
  commitGraceMs,
  editOutcome,
  type EditProof,
  editTouchesHold,
  orderEditBlockerReason,
  type OrderEditSnapshot,
} from './order-edits.js';

const gid = (kind: string, value = 1) => `gid://shopify/${kind}/${value}`;
const connectionId = '11111111-1111-4111-8111-111111111111';
const amount = { amount: '20.00', currencyCode: 'EUR' };
const bag = { shop: amount, presentment: amount };

function snapshot(
  change: (value: OrderEditSnapshot) => void = () => {},
): OrderEditSnapshot {
  const value: OrderEditSnapshot = {
    id: '22222222-2222-4222-8222-222222222222',
    observedAt: '2026-10-12T10:00:00.000Z',
    revision: 'revision-1',
    updatedAt: '2026-10-12T09:00:00Z',
    orderId: gid('Order'),
    cancelled: false,
    closed: false,
    totals: { subtotal: bag, total: bag, outstanding: bag },
    lines: [
      {
        id: gid('LineItem', 1),
        name: 'Tote',
        sku: 'TOTE',
        quantity: 3,
        currentQuantity: 3,
        unfulfilledQuantity: 3,
      },
      {
        id: gid('LineItem', 2),
        name: 'Shirt',
        sku: null,
        quantity: 1,
        currentQuantity: 1,
        unfulfilledQuantity: 1,
      },
    ],
    fulfillmentOrders: [
      {
        id: gid('FulfillmentOrder', 1),
        status: 'OPEN',
        requestStatus: 'UNSUBMITTED',
        lines: [
          { lineItemId: gid('LineItem', 1), remaining: 3, total: 3 },
          { lineItemId: gid('LineItem', 2), remaining: 1, total: 1 },
        ],
      },
    ],
    complete: true,
  };
  change(value);

  return value;
}

const access = {
  connectionId,
  granted: ['orders.read', 'orders.quantity.edit'],
  authority: { revision: 4, state: 'resolved' as const, connectionId },
};

const reduce = {
  lines: [{ lineItemId: gid('LineItem', 1), quantity: 1 }],
  restock: true,
};

describe('order edit safety', () => {
  it('allows reductions and increases of unstarted, unsubmitted lines', () => {
    expect(orderEditBlockerReason(snapshot(), reduce, access)).toBeNull();
    expect(
      orderEditBlockerReason(
        snapshot(),
        {
          lines: [{ lineItemId: gid('LineItem', 2), quantity: 4 }],
          restock: false,
        },
        access,
      ),
    ).toBeNull();
  });

  it('allows held work but reports the hold', () => {
    const held = snapshot((value) => {
      value.fulfillmentOrders[0]!.status = 'ON_HOLD';
    });
    expect(orderEditBlockerReason(held, reduce, access)).toBeNull();
    expect(editTouchesHold(held, reduce)).toBe(true);
    expect(editTouchesHold(snapshot(), reduce)).toBe(false);
  });

  it.each([
    ['write_access', snapshot(), { ...access, granted: ['orders.read'] }],
    [
      'incomplete',
      snapshot((value) => {
        value.complete = false;
      }),
      access,
    ],
    [
      'cancelled',
      snapshot((value) => {
        value.cancelled = true;
      }),
      access,
    ],
    [
      'closed',
      snapshot((value) => {
        value.closed = true;
      }),
      access,
    ],
    ['authority', snapshot(), { ...access, authority: null }],
    [
      'authority',
      snapshot(),
      {
        ...access,
        authority: {
          revision: 4,
          state: 'resolved' as const,
          connectionId: '33333333-3333-4333-8333-333333333333',
        },
      },
    ],
    [
      'authority',
      snapshot(),
      {
        ...access,
        authority: {
          revision: 4,
          state: 'conflicting' as const,
          connectionId: null,
        },
      },
    ],
    [
      'partially_fulfilled',
      snapshot((value) => {
        value.lines[0]!.unfulfilledQuantity = 2;
        value.fulfillmentOrders[0]!.lines[0]!.remaining = 2;
      }),
      access,
    ],
    [
      'fulfillment_started',
      snapshot((value) => {
        value.fulfillmentOrders[0]!.status = 'IN_PROGRESS';
      }),
      access,
    ],
    [
      'fulfillment_started',
      snapshot((value) => {
        value.fulfillmentOrders[0]!.status = 'INCOMPLETE';
      }),
      access,
    ],
    [
      'fulfillment_requested',
      snapshot((value) => {
        value.fulfillmentOrders[0]!.requestStatus = 'SUBMITTED';
      }),
      access,
    ],
    [
      'fulfillment_requested',
      snapshot((value) => {
        value.fulfillmentOrders[0]!.requestStatus = 'ACCEPTED';
      }),
      access,
    ],
    [
      'fulfillment_unknown',
      snapshot((value) => {
        value.fulfillmentOrders[0]!.requestStatus = 'SOMETHING_NEW';
      }),
      access,
    ],
    [
      'fulfillment_unknown',
      snapshot((value) => {
        value.fulfillmentOrders[0]!.status = 'PAUSED';
      }),
      access,
    ],
    [
      'fulfillment_unknown',
      snapshot((value) => {
        // Shopify says three units are unfulfilled but only two are in open work.
        value.fulfillmentOrders[0]!.lines[0]!.remaining = 2;
      }),
      access,
    ],
    [
      'fulfillment_unknown',
      snapshot((value) => {
        value.fulfillmentOrders.push({
          id: gid('FulfillmentOrder', 2),
          status: 'CLOSED',
          requestStatus: 'UNSUBMITTED',
          lines: [{ lineItemId: gid('LineItem', 1), remaining: 1, total: 1 }],
        });
      }),
      access,
    ],
  ])('blocks %s', (reason, value, current) => {
    expect(orderEditBlockerReason(value, reduce, current)).toBe(reason);
  });

  it('ignores finished work without remaining units and other lines', () => {
    const moved = snapshot((value) => {
      value.fulfillmentOrders.push({
        id: gid('FulfillmentOrder', 2),
        status: 'CLOSED',
        requestStatus: 'UNSUBMITTED',
        lines: [{ lineItemId: gid('LineItem', 1), remaining: 0, total: 3 }],
      });
      value.lines[1]!.unfulfilledQuantity = 0;
      value.fulfillmentOrders[0]!.lines[1]!.remaining = 0;
    });
    expect(orderEditBlockerReason(moved, reduce, access)).toBeNull();
  });

  it('rejects unknown lines and unchanged quantities', () => {
    expect(
      orderEditBlockerReason(
        snapshot(),
        {
          lines: [{ lineItemId: gid('LineItem', 9), quantity: 1 }],
          restock: false,
        },
        access,
      ),
    ).toBe('unknown_line');
    expect(
      orderEditBlockerReason(
        snapshot(),
        {
          lines: [{ lineItemId: gid('LineItem', 1), quantity: 3 }],
          restock: false,
        },
        access,
      ),
    ).toBe('no_change');
  });
});

describe('order edit reconciliation', () => {
  const lines = [
    { lineItemId: gid('LineItem', 1), currentQuantity: 3, quantity: 1 },
  ];
  const sentAt = '2026-10-12T10:00:00.000Z';
  const appId = gid('App');
  const proof = (change: Partial<EditProof> = {}): EditProof => ({
    observedAt: '2026-10-12T10:20:00.000Z',
    appId,
    agreements: [
      {
        id: gid('OrderEditAgreement'),
        reason: 'ORDER_EDIT',
        happenedAt: '2026-10-12T10:00:01Z',
        appId,
        deltas: { [gid('LineItem', 1)]: -2 },
        complete: true,
      },
    ],
    complete: true,
    cancelled: false,
    lines: [{ id: gid('LineItem', 1), currentQuantity: 1 }],
    ...change,
  });
  const sent = { state: 'sent' as const, sentAt };
  const later = new Date(Date.parse(sentAt) + commitGraceMs + 1);

  it('recognizes Luma’s own matching edit with the approved quantities', () => {
    expect(editOutcome(lines, sent, proof(), later)).toBe('committed');
    expect(
      editOutcome(lines, { state: 'accepted', sentAt }, proof(), later),
    ).toBe('committed');
  });

  it('proves a withheld or rejected fence was never applied', () => {
    expect(
      editOutcome(lines, { state: 'withheld', sentAt: null }, proof(), later),
    ).toBe('not_committed');
    expect(
      editOutcome(lines, { state: 'rejected', sentAt }, proof(), later),
    ).toBe('not_committed');
  });

  it('proves a lost commit was not applied only after the grace window', () => {
    const untouched = proof({
      agreements: [],
      lines: [{ id: gid('LineItem', 1), currentQuantity: 3 }],
    });
    expect(editOutcome(lines, sent, untouched, later)).toBe('not_committed');
    expect(
      editOutcome(
        lines,
        sent,
        untouched,
        new Date(Date.parse(sentAt) + 60_000),
      ),
    ).toBe('unknown');
  });

  it('stays unknown for partial reads, other edits and changed lines', () => {
    expect(editOutcome(lines, sent, proof({ complete: false }), later)).toBe(
      'unknown',
    );
    expect(editOutcome(lines, null, proof(), later)).toBe('unknown');
    // A merchant edit is not Luma's.
    expect(
      editOutcome(
        lines,
        sent,
        proof({
          agreements: [{ ...proof().agreements[0]!, appId: null }],
        }),
        later,
      ),
    ).toBe('unknown');
    // Luma's agreement but someone changed the line again afterwards.
    expect(
      editOutcome(
        lines,
        sent,
        proof({ lines: [{ id: gid('LineItem', 1), currentQuantity: 2 }] }),
        later,
      ),
    ).toBe('unknown');
    // An agreement by this app with other deltas is not this edit, and blocks proof of absence.
    expect(
      editOutcome(
        lines,
        sent,
        proof({
          agreements: [
            {
              ...proof().agreements[0]!,
              deltas: { [gid('LineItem', 1)]: -1 },
            },
          ],
          lines: [{ id: gid('LineItem', 1), currentQuantity: 3 }],
        }),
        later,
      ),
    ).toBe('unknown');
    // Truncated sales cannot prove a match.
    expect(
      editOutcome(
        lines,
        sent,
        proof({
          agreements: [{ ...proof().agreements[0]!, complete: false }],
        }),
        later,
      ),
    ).toBe('unknown');
    // Agreements from well before the commit are older edits.
    expect(
      editOutcome(
        lines,
        sent,
        proof({
          agreements: [
            { ...proof().agreements[0]!, happenedAt: '2026-10-12T09:00:00Z' },
          ],
        }),
        later,
      ),
    ).toBe('unknown');
  });
});

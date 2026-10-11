import { describe, expect, it } from 'vitest';

import {
  fromUnits,
  type RefundData,
  refundProgress,
  type ReturnData,
  returnProgress,
  settlementRefundProgress,
  toUnits,
} from './returns.js';

const eur = (amount: string) => ({ amount, currency: 'EUR' });

function aReturn(
  patch: Partial<ReturnData> = {},
  line: Partial<ReturnData['lines'][number]> = {},
): ReturnData {
  return {
    type: 'return',
    orderId: '00000000-0000-4000-8000-000000000001',
    name: '#1001-R1',
    status: 'open',
    requestedAt: '2026-09-01T10:00:00Z',
    approvedAt: '2026-09-01T12:00:00Z',
    closedAt: null,
    declineReason: null,
    receivedAt: null,
    lines: [
      {
        orderLineId: '00000000-0000-4000-8000-000000000002',
        quantity: '2',
        unit: 'each',
        reason: 'Size too small',
        receivedQuantity: '0',
        restockedQuantity: '0',
        refundedQuantity: '0',
        value: eur('48.00'),
        ...line,
      },
    ],
    ...patch,
  };
}

function aRefund(
  transactions: RefundData['transactions'],
  patch: Partial<RefundData> = {},
): RefundData {
  return {
    type: 'refund',
    orderId: '00000000-0000-4000-8000-000000000001',
    returnId: '00000000-0000-4000-8000-000000000003',
    createdAt: '2026-09-03T10:00:00Z',
    total: eur('48.00'),
    lines: [],
    transactions,
    ...patch,
  };
}

const payment = (
  status: RefundData['transactions'][number]['status'],
  amount = '48.00',
) => ({
  status,
  amount: eur(amount),
  processedAt: '2026-09-03T10:00:00Z',
  gateway: 'shopify_payments',
});

describe('return progress', () => {
  it('keeps requested, declined and closed returns in their source state', () => {
    expect(returnProgress(aReturn({ status: 'requested' }), []).stage).toBe(
      'requested',
    );
    expect(returnProgress(aReturn({ status: 'declined' }), []).group).toBe(
      'done',
    );
    // A closed return stays closed even when the refund was only partial.
    const closed = returnProgress(aReturn({ status: 'closed' }), [
      aRefund([payment('success', '10.00')]),
    ]);
    expect(closed).toMatchObject({ stage: 'closed', refund: 'partial' });
  });

  it('waits for items until every unit is received', () => {
    const progress = returnProgress(aReturn({}, { receivedQuantity: '1' }), []);
    expect(progress).toMatchObject({
      stage: 'awaiting_items',
      group: 'waiting',
      quantity: '2',
      received: '1',
      refund: 'none',
      refunded: null,
    });
  });

  it('asks for a refund once items are back and nothing was refunded', () => {
    expect(
      returnProgress(aReturn({}, { receivedQuantity: '2' }), []),
    ).toMatchObject({ stage: 'awaiting_refund', group: 'action' });
  });

  it('never counts a pending or failed refund as money returned', () => {
    const received = aReturn({}, { receivedQuantity: '2' });
    const pending = returnProgress(received, [aRefund([payment('pending')])]);
    expect(pending).toMatchObject({
      stage: 'refund_pending',
      refund: 'pending',
      refunded: null,
      pending: '48',
    });
    const failed = returnProgress(received, [aRefund([payment('failed')])]);
    expect(failed).toMatchObject({
      stage: 'refund_failed',
      group: 'action',
      refunded: null,
      failedAttempts: 1,
    });
    // A refund without any payment is recorded, not refunded.
    const recorded = returnProgress(received, [
      aRefund([], { total: eur('0.00') }),
    ]);
    expect(recorded).toMatchObject({
      stage: 'awaiting_refund',
      refund: 'recorded',
      refunded: null,
    });
  });

  it('recognizes a completed refund from payments and refunded units', () => {
    const settled = aReturn(
      {},
      { receivedQuantity: '2', refundedQuantity: '2' },
    );
    const progress = returnProgress(settled, [
      aRefund([payment('failed'), payment('success')]),
    ]);
    expect(progress).toMatchObject({
      stage: 'ready_to_close',
      refund: 'refunded',
      refunded: '48',
      failedAttempts: 1,
      value: eur('48'),
    });
    const partial = returnProgress(
      aReturn({}, { receivedQuantity: '2', refundedQuantity: '1' }),
      [aRefund([payment('success', '24.00')])],
    );
    expect(partial).toMatchObject({
      stage: 'awaiting_refund',
      refund: 'partial',
      refunded: '24',
    });
  });

  it('does not claim a receipt stage the source does not report', () => {
    const progress = returnProgress(
      aReturn({}, { receivedQuantity: null, refundedQuantity: null }),
      [],
    );
    expect(progress).toMatchObject({
      stage: 'awaiting_refund',
      received: null,
      refundedUnits: null,
    });
  });

  it('does not add amounts in different currencies', () => {
    const progress = returnProgress(aReturn(), [
      aRefund([
        payment('success'),
        { ...payment('success'), amount: { amount: '5', currency: 'USD' } },
      ]),
    ]);
    expect(progress).toMatchObject({ currency: null, refunded: null });
  });
});

describe('refund progress', () => {
  it('classifies refunds without a return by payment outcome', () => {
    expect(refundProgress(aRefund([payment('success')])).stage).toBe(
      'refunded',
    );
    expect(refundProgress(aRefund([payment('pending')])).stage).toBe(
      'refund_pending',
    );
    expect(refundProgress(aRefund([payment('failed')])).stage).toBe(
      'refund_failed',
    );
    expect(refundProgress(aRefund([])).stage).toBe('refund_recorded');
  });
});

it('converts decimals without floating point error', () => {
  expect(fromUnits(toUnits('0.1') + toUnits('0.2'))).toBe('0.3');
  expect(fromUnits(toUnits('-1.50'))).toBe('-1.5');
  expect(fromUnits(toUnits('12'))).toBe('12');
});

describe('case refund settlement', () => {
  it('requires successful payments for exactly the approved amount and currency', () => {
    expect(
      settlementRefundProgress(aRefund([payment('success')]), eur('48')),
    ).toBe('paid');
    expect(
      settlementRefundProgress(aRefund([payment('success', '24')]), eur('48')),
    ).toBe('partial');
    expect(
      settlementRefundProgress(aRefund([payment('success')]), {
        amount: '48',
        currency: 'USD',
      }),
    ).toBe('unknown');
    expect(settlementRefundProgress(aRefund([]), eur('48'))).toBe('unknown');
    expect(
      settlementRefundProgress(
        aRefund([payment('success', '24'), payment('pending', '24')]),
        eur('48'),
      ),
    ).toBe('partial');
    expect(
      settlementRefundProgress(aRefund([payment('failed')]), eur('48')),
    ).toBe('failed');
  });
});

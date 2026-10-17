import { describe, expect, it } from 'vitest';

import type { Commitment } from './commitments.js';
import {
  followUpResponseError,
  lastConfirmed,
  manualReceiptError,
  shortfallQuantity,
} from './supplier-responses.js';

const now = Date.parse('2026-10-05T12:00:00.000Z');

describe('followUpResponseError', () => {
  const later = '2026-10-06T12:00:00.000Z';

  it('accepts changes and follow-ups with a check time in the horizon', () => {
    expect(
      followUpResponseError(
        { kind: 'commitment_changed' },
        { response: 'accepted', nextCheckAt: null },
        now,
      ),
    ).toBeNull();
    expect(
      followUpResponseError(
        { kind: 'confirmation_overdue' },
        { response: 'following_up', nextCheckAt: later },
        now,
      ),
    ).toBeNull();
    expect(
      followUpResponseError(
        { kind: 'receipt_difference' },
        { response: 'written_off', nextCheckAt: null },
        now,
      ),
    ).toBeNull();
  });

  it('explains why a response does not fit', () => {
    const check = (
      kind: Parameters<typeof followUpResponseError>[0],
      response: Parameters<typeof followUpResponseError>[1]['response'],
      nextCheckAt: string | null = null,
    ) => followUpResponseError(kind, { response, nextCheckAt }, now);

    expect(check(undefined, 'accepted')).toBe(
      'This no longer needs a response. Refresh the order.',
    );
    expect(check({ kind: 'submission_approval' }, 'accepted')).toBe(
      'Respond to this from its own review.',
    );
    expect(check({ kind: 'delivery_overdue' }, 'accepted')).toBe(
      'Record a follow-up and when to check again.',
    );
    expect(check({ kind: 'commitment_changed' }, 'credited')).toBe(
      'Only a received-goods difference can be credited or written off.',
    );
    const horizon = 'Choose when to check again, within the next 60 days.';
    expect(check({ kind: 'delivery_overdue' }, 'following_up')).toBe(horizon);
    expect(
      check(
        { kind: 'delivery_overdue' },
        'following_up',
        '2026-10-05T12:00:00.000Z',
      ),
    ).toBe(horizon);
    expect(
      check(
        { kind: 'delivery_overdue' },
        'following_up',
        '2026-12-05T12:00:00.000Z',
      ),
    ).toBe(horizon);
  });
});

let next = 0;
const fact = (patch: Partial<Commitment>): Commitment => ({
  id: `c${++next}`,
  tenantId: 'tenant',
  purchaseOrderId: 'order',
  lineId: 'a',
  kind: 'received',
  quantity: 10,
  date: null,
  text: null,
  source: {
    kind: 'manual_receipt',
    receivedAt: '2026-10-05T10:00:00.000Z',
    condition: 'good',
    reason: 'Counted',
    evidence: [],
  },
  status: 'confirmed',
  reviewReasons: [],
  supersedes: null,
  recordedAt: '2026-10-05T10:00:00.000Z',
  recordedBy: { kind: 'user', id: 'buyer' },
  review: null,
  ...patch,
});

describe('manualReceiptError', () => {
  const order = {
    authority: 'luma' as const,
    status: 'open' as const,
    lines: [
      { id: 'a', sku: 'TOTE', description: 'Tote', quantity: 20, unit: 'each' },
    ],
  };
  const received = fact({ quantity: 10 });
  const damaged = fact({ kind: 'damaged', quantity: 2 });
  const base = {
    order,
    now,
    purchasingSystemOwned: false,
    commitments: [received, damaged],
  };
  const request = {
    lineId: 'a',
    kind: 'received' as const,
    quantity: 12,
    expectedCommitmentId: received.id,
    receivedAt: '2026-10-05T11:00:00.000Z',
  };

  it('accepts a current receipt', () => {
    expect(manualReceiptError({ ...base, request })).toBeNull();
    expect(
      manualReceiptError({
        ...base,
        request: {
          ...request,
          damagedQuantity: 3,
          expectedDamagedCommitmentId: damaged.id,
        },
      }),
    ).toBeNull();
  });

  it('explains why a receipt cannot be recorded', () => {
    const error = (patch: Partial<Parameters<typeof manualReceiptError>[0]>) =>
      manualReceiptError({ ...base, request, ...patch });

    expect(error({ order: { ...order, status: 'draft' } })).toBe(
      'Only an open Luma purchase order can be reconciled.',
    );
    expect(error({ request: { ...request, lineId: 'z' } })).toBe(
      'That order line does not exist.',
    );
    expect(
      error({
        request: { ...request, receivedAt: '2026-10-05T12:00:01.000Z' },
      }),
    ).toBe('Receipt time cannot be in the future.');
    expect(error({ purchasingSystemOwned: true })).toBe(
      'Record receipt in the purchasing system that owns this order.',
    );
    expect(error({ request: { ...request, expectedCommitmentId: null } })).toBe(
      'This quantity changed. Refresh the order before recording it.',
    );
    expect(
      error({
        request: {
          ...request,
          damagedQuantity: 1,
          expectedDamagedCommitmentId: null,
        },
      }),
    ).toBe(
      'Damaged quantities changed. Refresh the order before recording receipt.',
    );
    expect(
      error({
        request: {
          ...request,
          kind: 'damaged',
          quantity: 11,
          expectedCommitmentId: damaged.id,
        },
      }),
    ).toBe('Damaged units cannot exceed the recorded receipt.');
    expect(
      error({
        request: {
          ...request,
          damagedQuantity: 13,
          expectedDamagedCommitmentId: damaged.id,
        },
      }),
    ).toBe('Damaged units cannot exceed the receipt.');
    expect(error({ request: { ...request, quantity: 1 } })).toBe(
      'Receipt cannot be less than the recorded damaged units.',
    );
  });

  it('lets a purchasing-system order record shortages by hand', () => {
    expect(
      manualReceiptError({
        ...base,
        purchasingSystemOwned: true,
        request: {
          ...request,
          kind: 'shortage',
          quantity: 2,
          expectedCommitmentId: null,
        },
      }),
    ).toBeNull();
  });
});

describe('lastConfirmed', () => {
  it('takes the last confirmed commitment of the kind on the line', () => {
    const first = fact({});
    const second = fact({});
    expect(
      lastConfirmed(
        [
          first,
          second,
          fact({ status: 'rejected' }),
          fact({ lineId: 'b' }),
          fact({ kind: 'damaged' }),
        ],
        'a',
        'received',
      ),
    ).toBe(second);
  });
});

describe('shortfallQuantity', () => {
  const line = { ordered: 20, outstanding: 7 };

  it('sources what a lower confirmation, a shortage or damage leaves out', () => {
    expect(
      shortfallQuantity({ kind: 'confirmed_quantity', quantity: 15 }, line),
    ).toBe(5);
    expect(
      shortfallQuantity({ kind: 'confirmed_quantity', quantity: 25 }, line),
    ).toBe(0);
    expect(shortfallQuantity({ kind: 'shortage', quantity: 3 }, line)).toBe(3);
    expect(shortfallQuantity({ kind: 'damaged', quantity: null }, line)).toBe(
      0,
    );
    expect(shortfallQuantity(undefined, line)).toBe(7);
  });
});

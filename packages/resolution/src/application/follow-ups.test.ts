import type { TenantContext } from '@luma/identity';
import type { ProcessWorkflowVersion } from '@luma/workflows';
import { describe, expect, it } from 'vitest';

import {
  createPaymentFollowUp,
  createRefundFollowUp,
  type PaymentCandidate,
  type RefundCandidate,
} from './follow-ups.js';

const context = { tenantId: 't' } as TenantContext;
const now = new Date('2026-10-07T12:00:00.000Z');
const hour = 3_600_000;
const ago = (hours: number) => new Date(+now - hours * hour).toISOString();
const version = {
  applicability: { subjectKind: 'return' },
} as ProcessWorkflowVersion;

const refund = (overrides: Partial<RefundCandidate> = {}): RefundCandidate => ({
  id: 'r1',
  connectionId: 'c1',
  name: '#R1',
  order: { id: 'o1', displayNumber: '#1001' },
  stage: 'awaiting_refund',
  receivedAt: ago(50),
  activityAt: ago(50),
  value: '40.00 EUR',
  ...overrides,
});

const payment = (
  overrides: Partial<PaymentCandidate> = {},
): PaymentCandidate => ({
  id: 'o1',
  connectionId: 'c1',
  displayNumber: '#1001',
  status: 'open',
  paymentStatus: 'pending',
  placedAt: ago(30),
  total: '80.00 EUR',
  ...overrides,
});

describe('refund follow-up', () => {
  const adapter = (items: RefundCandidate[]) =>
    createRefundFollowUp({
      version,
      candidates: async () => items,
      get: async (_context, id) => items.find((item) => item.id === id) ?? null,
      returnsShared: async () => false,
      waitMs: 48 * hour,
      now: () => now,
    });

  it('reports returns that waited past the window and stay open until refunded', async () => {
    const items = [
      refund(),
      refund({ id: 'r2', receivedAt: ago(2), activityAt: ago(2) }),
    ];
    const f = adapter(items);

    expect(await f.signals!.open(context)).toEqual([
      expect.objectContaining({
        id: 'return:r1',
        title: 'Refund for return #R1 on order #1001',
        record: { kind: 'order', id: 'o1' },
      }),
    ]);
    items[0] = refund({ stage: 'refunded' });
    expect((await f.signals!.get(context, 'return:r1'))?.open).toBe(false);
    expect(await f.signals!.get(context, 'order:r1')).toBeNull();
  });

  it('reads only its declared fields and names the missing access', async () => {
    const f = adapter([refund()]);
    const run = { signal: { id: 'return:r1' } } as never;

    expect((await f.read(context, run, {} as never)).values).toEqual({
      ready: true,
      waiting: true,
    });
    expect(
      (
        await f.read(
          context,
          { signal: { id: 'return:gone' } } as never,
          {} as never,
        )
      ).values,
    ).toEqual({ ready: false, waiting: false });
    expect(await f.requirements(context)).toEqual([
      expect.objectContaining({
        met: false,
        fix: { label: 'Open Connections', destination: 'connections' },
      }),
    ]);
  });
});

describe('payment follow-up', () => {
  it('reports pending payments past the window, but not cancelled orders', async () => {
    const items = [
      payment(),
      payment({ id: 'o2', placedAt: ago(1) }),
      payment({ id: 'o3', status: 'cancelled' }),
    ];
    const f = createPaymentFollowUp({
      version,
      candidates: async () => items,
      get: async (_context, id) => items.find((item) => item.id === id) ?? null,
      ordersShared: async () => true,
      waitMs: 24 * hour,
      now: () => now,
    });

    expect((await f.signals!.open(context)).map((signal) => signal.id)).toEqual(
      ['order:o1'],
    );
    items[0] = payment({ paymentStatus: 'paid' });
    expect((await f.signals!.get(context, 'order:o1'))?.open).toBe(false);
  });
});

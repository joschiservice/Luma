import { builtInMembership, makeTenantContext } from '@luma/identity';
import type { ReturnWorkspace } from '@luma/read-models';
import { afterEach, expect, it, vi } from 'vitest';

import { createFollowUpWorkflows } from './case-workflows.js';

const now = new Date('2026-10-12T12:00:00Z'),
  at = now.toISOString();
const context = makeTenantContext(
  { userId: 'owner', sessionId: 'session' },
  {
    id: 'tenant',
    name: 'Test',
    slug: 'test',
    dataRegion: 'AU',
    status: 'active',
  },
  builtInMembership(
    { id: 'member', organizationId: 'tenant', userId: 'owner' },
    'owner',
  ),
  'refund-test',
);

type Detail = NonNullable<Awaited<ReturnType<ReturnWorkspace['get']>>>;

const unavailable = async (): Promise<never> => {
  throw new Error('Not used');
};
const counts = {
  views: { all: 0, action: 0, waiting: 0, done: 0 },
  stages: {
    requested: 0,
    awaiting_items: 0,
    awaiting_refund: 0,
    refund_pending: 0,
    refund_failed: 0,
    ready_to_close: 0,
    closed: 0,
    declined: 0,
    cancelled: 0,
    unknown: 0,
    refunded: 0,
    refund_recorded: 0,
  },
};
const detail = (id: string, paid: boolean): Detail => ({
  item: {
    id,
    kind: 'return',
    connectionId: 'shop',
    externalId: id,
    name: id,
    order: { id: 'order', displayNumber: '#1' },
    status: 'open',
    stage: paid ? 'ready_to_close' : 'awaiting_refund',
    group: 'action',
    refund: {
      state: paid ? 'refunded' : 'none',
      currency: 'EUR',
      refunded: paid ? '10' : '0',
      pending: '0',
      failedAttempts: 0,
    },
    quantity: '1',
    received: '1',
    refundedUnits: paid ? '1' : '0',
    value: { amount: '10', currency: 'EUR' },
    reasons: [],
    requestedAt: '2026-10-09T12:00:00Z',
    activityAt: '2026-10-09T12:00:00Z',
    observedAt: at,
    sourceUpdatedAt: at,
    deleted: false,
  },
  source: {
    connectionId: 'shop',
    label: 'Shopify',
    system: 'shopify',
    appId: 'shopify',
    status: 'active',
    access: 'granted',
    records: 51,
    importing: false,
    fullReadAt: '2026-10-11T12:00:00Z',
    lastReadAt: at,
    failing: false,
  },
  order: null,
  lines: [],
  timeline: {
    requestedAt: '2026-10-09T12:00:00Z',
    approvedAt: null,
    receivedAt: '2026-10-09T12:00:00Z',
    closedAt: null,
    declineReason: null,
  },
  refunds: paid
    ? [
        {
          id: 'refund',
          externalId: 'refund',
          createdAt: at,
          total: { amount: '10', currency: 'EUR' },
          lines: [],
          transactions: [
            {
              status: 'success',
              amount: { amount: '10', currency: 'EUR' },
              processedAt: at,
              gateway: null,
            },
          ],
          observedAt: at,
          sourceUpdatedAt: at,
        },
      ]
    : [],
  related: [],
  history: { entries: [], truncated: false },
  hidden: [],
  asOf: at,
});
afterEach(() => vi.useRealTimers());

function fixture(returns: ReturnWorkspace) {
  const cursors = new Map<'action' | 'waiting', string | null>();
  const build = () =>
    createFollowUpWorkflows({
      commitments: {
        pending: unavailable,
        order: unavailable,
        respond: unavailable,
      },
      suppliers: async () => [],
      orders: () => ({ list: unavailable, get: unavailable }),
      returns: () => returns,
      refundCursor: {
        get: async (_context, view) => cursors.get(view) ?? null,
        save: async (_context, view, cursor) => {
          cursors.set(view, cursor);
        },
      },
    }).find((a) => a.version.definition.id === 'refund-follow-up')!;

  return { build, cursors };
}

it('uses fresh return and refund records after an incremental read while the daily scan is older', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const paid = detail('paid', true);
  const f = fixture({
    list: async () => ({
      items: [paid.item],
      sources: [],
      counts,
      nextCursor: null,
      asOf: at,
    }),
    get: async () => paid,
  });
  expect(await f.build().signals!.open(context)).toEqual([]);
});

it('advances past fifty settled returns and resumes the next page after rebuilding the runtime', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const settled = Array.from({ length: 50 }, (_, i) =>
      detail(`paid-${i}`, true),
    ),
    overdue = detail('overdue', false);
  const list = vi.fn<ReturnWorkspace['list']>(async (_context, query) => ({
    items:
      query.view === 'waiting'
        ? []
        : query.cursor
          ? [overdue.item]
          : settled.map((r) => r.item),
    sources: [],
    counts,
    nextCursor: query.view === 'action' && !query.cursor ? 'page-2' : null,
    asOf: at,
  }));
  const f = fixture({
    list,
    get: async (_context, id) =>
      id === 'overdue'
        ? overdue
        : (settled.find((r) => r.item.id === id) ?? null),
  });
  expect(await f.build().signals!.open(context)).toEqual([]);
  expect(f.cursors.get('action')).toBe('page-2');
  expect((await f.build().signals!.open(context))?.map((s) => s.id)).toEqual([
    'return:overdue',
  ]);
  expect(f.cursors.get('action')).toBeNull();
  expect(list).toHaveBeenCalledWith(
    context,
    expect.objectContaining({ view: 'action', cursor: 'page-2', limit: 50 }),
  );
});

it('does not advance the scan if a detail read fails', async () => {
  const f = fixture({
    list: async () => ({
      items: [detail('paid', true).item],
      sources: [],
      counts,
      nextCursor: 'next',
      asOf: at,
    }),
    get: unavailable,
  });
  await expect(f.build().signals!.open(context)).rejects.toThrow('Not used');
  expect(f.cursors.size).toBe(0);
});

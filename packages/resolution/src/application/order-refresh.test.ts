import type {
  CapabilityRequest,
  FulfillmentSnapshot,
  Observation,
  OrderSnapshot,
  ReadCapability,
} from '@luma/connections';
import { describe, expect, it, vi } from 'vitest';

import { createOrderRefresh, type OrderSource } from './order-refresh.js';
import { testContext } from './tenant-context.fixture.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const context = testContext({ tenantId });
const now = new Date('2026-10-05T12:00:00Z');
const ago = (minutes: number) =>
  new Date(+now - minutes * 60_000).toISOString();

const observation = <T>(
  connectionId: string,
  resource: 'order' | 'fulfillment',
  externalId: string,
  data: T,
): Observation<T> => ({
  id: `${resource}-${externalId}-read`,
  source: {
    tenantId,
    connectionId,
    provider: 'jtl',
    resource,
    externalId,
    scopeKey: '',
  },
  kind: 'snapshot',
  observedAt: now.toISOString(),
  sourceUpdatedAt: null,
  sourceRevision: null,
  adapterVersion: 'jtl/1',
  schemaVersion: 1,
  data,
});

const note = (id: string, status: FulfillmentSnapshot['status']) =>
  observation<FulfillmentSnapshot>('jtl', 'fulfillment', id, {
    order: { externalId: '1', scopeKey: '' },
    status,
    lines: [],
    lastProgressAt: null,
    progressBasis: 'note_created_or_package_shipped',
    failureCode: null,
  });

function fixture({
  sources,
  filters = { jtl: ['order'], shop: ['order'] } as Record<string, string[]>,
  notes = [] as Observation<FulfillmentSnapshot>[],
  failing = new Set<string>(),
}: {
  sources: OrderSource[];
  filters?: Record<string, string[]>;
  notes?: Observation<FulfillmentSnapshot>[];
  failing?: Set<string>;
}) {
  const read = vi.fn(
    async (_context: unknown, request: CapabilityRequest<ReadCapability>) => {
      if (failing.has(request.connectionId))
        return {
          ok: false as const,
          error: { code: 'unavailable', effect: 'none', retry: 'later' },
        };
      const items =
        request.capability === 'orders.read'
          ? [
              {
                ...observation<Partial<OrderSnapshot>>(
                  request.connectionId,
                  'order',
                  '1',
                  {
                    status: 'open',
                    lines: [],
                    customer: { externalId: 'person', scopeKey: '' },
                    addresses: { shared: false },
                  } as Partial<OrderSnapshot>,
                ),
              },
            ]
          : notes;

      return {
        ok: true as const,
        value: { items, nextCursor: null, completeness: 'complete' as const },
      };
    },
  );
  const project = vi.fn(async () => true);
  const refresh = createOrderRefresh({
    sources: { orderSources: async () => sources },
    capabilities: {
      read: read as never,
      discover: async (_context, connectionId) => [
        {
          capability: 'orders.read',
          version: '0',
          minimumRisk: 'low',
          idempotency: 'none',
          retry: { maxAttempts: 1, initialDelayMs: 0 },
          filters: (filters[connectionId] ?? []) as never,
        },
      ],
    },
    project,
    id: () => 'tombstone-read',
    now: () => now,
  });

  return { read, project, refresh };
}

const source = (
  connectionId: string,
  observedAt: string,
  stored: Observation<FulfillmentSnapshot>[] = [],
): OrderSource => ({
  connectionId,
  provider: 'jtl',
  order: { externalId: '1', scopeKey: '' },
  observedAt,
  fulfillments: true,
  stored,
});

describe('order source refresh', () => {
  it('rereads stale sources by point read and stores the order without personal data', async () => {
    const f = fixture({
      sources: [source('jtl', ago(5)), source('shop', ago(0))],
    });

    expect(await f.refresh.refresh(context, 'order', 60_000)).toEqual({
      refreshed: 1,
      failed: 0,
    });
    expect(f.read).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        connectionId: 'jtl',
        capability: 'orders.read',
        input: { limit: 1, order: { externalId: '1', scopeKey: '' } },
      }),
    );
    const [, stored] = f.project.mock.calls[0] as unknown as [
      unknown,
      { observation: Observation<Record<string, unknown>> },
    ];
    expect(stored.observation.data).not.toHaveProperty('customer');
    expect(stored.observation.data).not.toHaveProperty('addresses');
    // Fresh sources are not read again.
    expect(
      f.read.mock.calls.some(([, request]) => request.connectionId === 'shop'),
    ).toBe(false);
  });

  it('retires unshipped work a complete reread no longer returns, and keeps shipments', async () => {
    const packing = note('7', 'processing');
    const shipped = note('8', 'shipped');
    const f = fixture({
      sources: [source('jtl', ago(5), [packing, shipped])],
      notes: [],
    });
    await f.refresh.refresh(context, 'order', 0);

    const tombstones = f.project.mock.calls
      .map(
        (call) =>
          (
            call as unknown as [unknown, { observation: Observation<unknown> }]
          )[1].observation,
      )
      .filter((item) => item.kind === 'tombstone');
    expect(tombstones).toEqual([
      expect.objectContaining({
        id: 'tombstone-read',
        source: packing.source,
        observedAt: now.toISOString(),
      }),
    ]);
  });

  it('leaves sources without a point read or with a failed read as stored', async () => {
    const f = fixture({
      sources: [source('jtl', ago(5)), source('shop', ago(5))],
      filters: { jtl: [] },
      failing: new Set(['shop']),
    });

    expect(await f.refresh.refresh(context, 'order', 0)).toEqual({
      refreshed: 0,
      failed: 2,
    });
    expect(f.project).not.toHaveBeenCalled();
  });
});

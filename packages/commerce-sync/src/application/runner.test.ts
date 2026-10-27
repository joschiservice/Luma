import type { Observation } from '@luma/connections';
import { builtInMembership, makeTenantContext } from '@luma/identity';
import { describe, expect, it, vi } from 'vitest';

import {
  retryDelayMs,
  syncPolicy,
  type SyncStream,
} from '../domain/streams.js';
import type { SyncStore } from './ports.js';
import { createSyncRunner, type SyncRunnerDependencies } from './runner.js';

const tenantId = crypto.randomUUID();
const userId = crypto.randomUUID();
const connectionId = crypto.randomUUID();
const now = new Date('2026-10-27T12:00:00.000Z');

const tenant = makeTenantContext(
  { userId, sessionId: crypto.randomUUID() },
  {
    id: tenantId,
    name: 'Sync',
    slug: 'sync',
    dataRegion: 'AU',
    status: 'active',
  },
  builtInMembership(
    { id: crypto.randomUUID(), organizationId: tenantId, userId },
    'owner',
  ),
  crypto.randomUUID(),
);

function stream(scan: Partial<NonNullable<SyncStream['scan']>> | null) {
  return {
    id: crypto.randomUUID(),
    tenantId,
    connectionId,
    recordType: 'orders',
    principalId: userId,
    paused: false,
    phase: 'incremental',
    scan: scan && {
      id: crypto.randomUUID(),
      kind: 'reconcile',
      cursor: null,
      startedAt: now.toISOString(),
      since: null,
      pages: 0,
      records: 0,
      total: null,
      ...scan,
    },
    fullRequested: false,
    watermark: now.toISOString(),
    historyFrom: null,
    historyRequirement: null,
    currentHistoryLimited: false,
    dueAt: now.toISOString(),
    hintAt: null,
    attempts: 0,
    error: null,
    failingSince: null,
    blocked: null,
    lastSuccessAt: null,
    lastCompleteAt: null,
    lastFullScanAt: now.toISOString(),
    backfillStartedAt: null,
    backfillCompletedAt: null,
    version: 1,
  } satisfies SyncStream;
}

const order: Observation<unknown> = {
  id: crypto.randomUUID(),
  kind: 'snapshot',
  source: {
    connectionId,
    resource: 'order',
    scopeKey: 'shop',
    externalId: '1',
  },
  observedAt: now.toISOString(),
  sourceUpdatedAt: now.toISOString(),
  data: { placedAt: now.toISOString() },
} as Observation<unknown>;

/** A runner over one claimable stream; reads follow `read`, and store calls are recorded. */
function setup(
  claimed: SyncStream,
  options: {
    read?: SyncRunnerDependencies['reader']['read'];
    filters?: string[];
    renew?: boolean;
  } = {},
) {
  let available = true;
  const store = {
    connections: async () => [],
    streams: async () => [],
    applyHints: async () => 0,
    claimLink: async () => null,
    claim: vi.fn(async () => {
      if (!available) return null;
      available = false;

      return claimed;
    }),
    renewLease: vi.fn(async () => options.renew ?? true),
    startScan: vi.fn(async () =>
      stream({ id: crypto.randomUUID(), kind: 'incremental' }),
    ),
    ledger: async () => new Map(),
    confirmationCandidates: vi.fn(async () => [
      {
        resource: 'order' as const,
        scopeKey: 'shop',
        externalId: '9',
        createdAt: null,
      },
    ]),
    recordConfirmation: vi.fn(async () => undefined),
    commitPage: vi.fn(async () => true),
    failPage: vi.fn<SyncStore['failPage']>(async () => undefined),
  } satisfies Partial<SyncStore>;
  const importMany = vi.fn(async () => [
    { status: 'created', entityId: crypto.randomUUID() },
  ]);
  const runner = createSyncRunner({
    store: store as unknown as SyncStore,
    reader: {
      discover: async () => [
        {
          capability: 'orders.read',
          filters: options.filters ?? ['updatedSince'],
        },
      ],
      read:
        options.read ??
        (async () => ({
          ok: true,
          value: { items: [order], nextCursor: null, completeness: 'complete' },
        })),
    } as unknown as SyncRunnerDependencies['reader'],
    ingestion: {
      import: vi.fn(),
      importMany,
      link: vi.fn(),
      unlink: vi.fn(),
    } as unknown as SyncRunnerDependencies['ingestion'],
    customers: {
      upsert: vi.fn(),
      recordOrders: vi.fn(async () => undefined),
      recordOrderAddresses: vi.fn(async () => undefined),
      remove: vi.fn(),
    } as unknown as SyncRunnerDependencies['customers'],
    recordRead: async () => undefined,
    resolveContext: async () => tenant,
    digest: (value) => value,
    now: () => now,
    workspaceConcurrency: 1,
  });

  return { runner, store, importMany };
}

describe('createSyncRunner', () => {
  it('restarts a rejected cursor at once, then backs off, then reports the stream failing', async () => {
    const rejected = async () => ({
      ok: false,
      error: { code: 'invalid_input', message: 'Bad cursor' },
    });
    const dueAt = async (restarts: number) => {
      const claimed = stream({ cursor: 'page-4', pages: 4, restarts });
      const { runner, store } = setup(claimed, { read: rejected as never });
      await runner.tick(tenantId);

      return store.failPage.mock.calls[0]![3];
    };

    expect(await dueAt(0)).toMatchObject({
      restart: true,
      failing: false,
      dueAt: now.toISOString(),
    });
    const second = await dueAt(1);
    expect(second.restart).toBe(true);
    expect(Date.parse(second.dueAt) - +now).toBeGreaterThanOrEqual(
      retryDelayMs(2) / 2,
    );
    const exhausted = await dueAt(syncPolicy.maxScanRestarts);
    expect(exhausted).toMatchObject({ restart: false, failing: true });
    expect(exhausted.message).toContain('Re-import history');
  });

  it('checks missing records once per scan and reads the page when a check fails', async () => {
    const reads: unknown[] = [];
    const { runner, store } = setup(stream(null), {
      filters: ['updatedSince', 'confirmMissing'],
      read: (async (_context: unknown, request: { input: object }) => {
        reads.push(request.input);
        if ('confirmMissing' in request.input)
          return {
            ok: false,
            error: { code: 'timeout', message: 'Timed out' },
          };

        return {
          ok: true,
          value: { items: [order], nextCursor: null, completeness: 'complete' },
        };
      }) as never,
    });
    await runner.tick(tenantId);

    expect(store.confirmationCandidates).toHaveBeenCalledWith(
      tenantId,
      connectionId,
      'orders',
      new Date(+now - syncPolicy.confirmationRecheckMs).toISOString(),
      syncPolicy.confirmationLimit,
    );
    expect(reads).toHaveLength(2);
    expect(store.recordConfirmation).not.toHaveBeenCalled();
    expect(store.failPage).not.toHaveBeenCalled();
    expect(store.commitPage).toHaveBeenCalledOnce();

    const next = setup(stream({ cursor: 'page-2', pages: 2 }), {
      filters: ['updatedSince', 'confirmMissing'],
    });
    await next.runner.tick(tenantId);
    expect(next.store.confirmationCandidates).not.toHaveBeenCalled();
    expect(next.store.commitPage).toHaveBeenCalledOnce();
  });

  it('stops a page without writes once another runner holds its stream', async () => {
    const { runner, store, importMany } = setup(stream({ cursor: 'page-2' }), {
      renew: false,
    });
    await runner.tick(tenantId);

    expect(store.renewLease).toHaveBeenCalledWith(
      tenantId,
      expect.any(String),
      expect.any(String),
      syncPolicy.leaseMs,
    );
    expect(importMany).not.toHaveBeenCalled();
    expect(store.commitPage).not.toHaveBeenCalled();
    expect(store.failPage).not.toHaveBeenCalled();
  });
});

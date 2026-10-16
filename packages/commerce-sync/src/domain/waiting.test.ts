import { describe, expect, it } from 'vitest';

import type { SyncStream } from './streams.js';
import { syncWait } from './waiting.js';

const now = new Date('2026-10-14T13:00:00Z');
const before = '2026-10-14T12:59:00Z';
const after = '2026-10-14T13:01:00Z';

function stream(patch: Partial<SyncStream> = {}): SyncStream {
  return {
    id: 'orders',
    tenantId: 'workspace',
    connectionId: 'shop',
    recordType: 'orders',
    principalId: 'operator',
    paused: false,
    phase: 'backfill',
    scan: null,
    fullRequested: false,
    watermark: null,
    historyFrom: null,
    historyRequirement: null,
    currentHistoryLimited: false,
    dueAt: before,
    hintAt: null,
    attempts: 0,
    error: null,
    failingSince: null,
    blocked: null,
    lastSuccessAt: null,
    lastCompleteAt: null,
    lastFullScanAt: null,
    backfillStartedAt: null,
    backfillCompletedAt: null,
    version: 1,
    ...patch,
  };
}

describe('sync waiting evidence', () => {
  it('flags prolonged unclaimed work without claiming a worker outage', () => {
    const queued = stream({ dueAt: '2026-10-14T12:58:01Z' });
    expect(syncWait(queued, [], now)?.reason).toBe('queued');
    const delayed = { ...queued, dueAt: '2026-10-14T12:58:00Z' };
    expect(syncWait(delayed, [], now)).toMatchObject({
      reason: 'delayed',
      observedAt: now.toISOString(),
      connectionIds: [],
      until: null,
    });
    expect(syncWait({ ...delayed, leaseUntil: after }, [], now)).toBeNull();
    expect(syncWait({ ...delayed, paused: true }, [], now)).toBeNull();
    expect(syncWait({ ...delayed, dueAt: after }, [], now)).toBeNull();
    expect(
      syncWait({ ...delayed, providerDueAt: before }, [], now)?.reason,
    ).toBe('queued');
    expect(syncWait({ ...delayed, leaseUntil: before }, [], now)?.reason).toBe(
      'queued',
    );
  });

  it('preserves an evidenced wait while old work is blocked on orders or capacity', () => {
    const old = stream({ dueAt: '2026-10-14T12:00:00Z' });
    expect(
      syncWait({ ...old, recordType: 'fulfillments' }, [stream()], now)?.reason,
    ).toBe('orders');
    expect(
      syncWait(
        old,
        [
          stream({
            id: 'holder',
            connectionId: 'erp',
            leaseUntil: after,
            leaseWorkspaceConcurrency: 1,
          }),
        ],
        now,
      )?.reason,
    ).toBe('worker_capacity');
    expect(syncWait({ ...old, providerDueAt: after }, [], now)?.reason).toBe(
      'provider_cooldown',
    );
  });

  it('shows admission advice only until due, and clears it while a page is leased', () => {
    const deferred = stream({
      admissionWait: { reason: 'request_capacity', observedAt: before },
      dueAt: after,
    });
    expect(syncWait(deferred, [], now)).toEqual({
      reason: 'request_capacity',
      observedAt: before,
      until: after,
      connectionIds: [],
    });
    expect(syncWait({ ...deferred, dueAt: before }, [], now)?.reason).toBe(
      'queued',
    );
    expect(syncWait({ ...deferred, leaseUntil: after }, [], now)).toBeNull();
    expect(syncWait({ ...deferred, paused: true }, [], now)).toBeNull();
    expect(
      syncWait({ ...deferred, blocked: 'principal_unavailable' }, [], now),
    ).toBeNull();
    expect(
      syncWait(
        {
          ...deferred,
          error: { code: 'timeout', message: 'Retrying', at: before },
        },
        [],
        now,
      ),
    ).toBeNull();
  });

  it('names only current tenant leases that exhaust actual worker capacity', () => {
    const target = stream();
    const holder = stream({
      id: 'erp',
      connectionId: 'cin7',
      leaseUntil: after,
      leaseWorkspaceConcurrency: 1,
      leaseConnectionConcurrency: 2,
    });
    expect(syncWait(target, [holder], now)).toMatchObject({
      reason: 'worker_capacity',
      connectionIds: ['cin7'],
      until: after,
    });
    expect(
      syncWait(target, [{ ...holder, leaseWorkspaceConcurrency: 4 }], now)
        ?.reason,
    ).toBe('queued');
    expect(
      syncWait(target, [{ ...holder, leaseUntil: before }], now)?.reason,
    ).toBe('queued');
    expect(
      syncWait(target, [{ ...holder, tenantId: 'another-workspace' }], now)
        ?.reason,
    ).toBe('queued');
  });

  it('distinguishes capacity on this connection from shared worker capacity', () => {
    const holder = stream({
      id: 'inventory',
      recordType: 'inventory',
      leaseUntil: after,
      leaseWorkspaceConcurrency: 4,
      leaseConnectionConcurrency: 1,
    });
    expect(syncWait(stream(), [holder], now)).toMatchObject({
      reason: 'connection_capacity',
      connectionIds: ['shop'],
    });
  });

  it('identifies recent reads only when they hold all of this connection’s capacity', () => {
    const holder = stream({
      id: 'live',
      leaseUntil: after,
      leaseConnectionConcurrency: 1,
      scan: {
        id: 'live-scan',
        kind: 'incremental',
        cursor: null,
        startedAt: before,
        since: before,
        pages: 0,
        records: 0,
        total: null,
      },
    });
    expect(syncWait(stream(), [holder], now)?.reason).toBe('recent_changes');
  });

  it('keeps future scheduled checks current and explains connection cooldowns', () => {
    expect(
      syncWait(stream({ phase: 'incremental', dueAt: after }), [], now),
    ).toBeNull();
    expect(
      syncWait(
        stream({ phase: 'incremental', dueAt: after, providerDueAt: after }),
        [],
        now,
      ),
    ).toBeNull();
    expect(syncWait(stream({ providerDueAt: after }), [], now)?.reason).toBe(
      'provider_cooldown',
    );
  });

  it('waits for recent orders without allowing another tenant to supply the dependency', () => {
    const child = stream({ recordType: 'fulfillments' });
    expect(syncWait(child, [stream()], now)?.reason).toBe('orders');
    expect(
      syncWait(child, [stream({ recentHistoryCompletedAt: before })], now)
        ?.reason,
    ).toBe('queued');
    expect(
      syncWait(child, [stream({ tenantId: 'another-workspace' })], now)?.reason,
    ).toBe('queued');
  });
});

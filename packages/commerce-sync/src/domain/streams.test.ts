import { describe, expect, it } from 'vitest';

import {
  historyWindow,
  planScan,
  recordTypeFor,
  retryDelayMs,
  streamStatus,
  syncPolicy,
} from './streams.js';

const now = new Date('2026-09-29T12:00:00.000Z');

const base = {
  phase: 'incremental' as const,
  fullRequested: false,
  lastFullScanAt: '2026-09-29T06:00:00.000Z',
  watermark: '2026-09-29T11:50:00.000Z',
  hintAt: null,
  backfillStartedAt: '2026-09-28T12:00:00.000Z',
};

describe('planScan', () => {
  it('imports history before anything else', () => {
    expect(planScan({ ...base, phase: 'backfill' }, now, true)).toEqual({
      kind: 'backfill',
      since: null,
      trigger: 'connection',
    });
    expect(
      planScan({ ...base, phase: 'backfill', fullRequested: true }, now, true)
        .trigger,
    ).toBe('operator');
  });

  it('reads changes since shortly before the previous scan started', () => {
    expect(planScan(base, now, true)).toEqual({
      kind: 'incremental',
      since: '2026-09-29T11:40:00.000Z',
      trigger: 'schedule',
    });
  });

  it('rereads everything when the source cannot filter by update time', () => {
    expect(planScan(base, now, false).since).toBeNull();
  });

  it('attributes a change read to a due notification', () => {
    expect(
      planScan({ ...base, hintAt: '2026-09-29T11:59:00.000Z' }, now, true)
        .trigger,
    ).toBe('webhook');
  });

  it('does not let a deletion hint downgrade requested full reconciliation to an incremental scan', () => {
    expect(
      planScan(
        { ...base, fullRequested: true, hintAt: '2026-09-29T11:59:00.000Z' },
        now,
        true,
      ),
    ).toEqual({ kind: 'reconcile', since: null, trigger: 'webhook' });
  });

  it('runs a full check when requested or once a day', () => {
    expect(planScan({ ...base, fullRequested: true }, now, true)).toEqual({
      kind: 'reconcile',
      since: null,
      trigger: 'operator',
    });
    expect(
      planScan(
        { ...base, lastFullScanAt: '2026-09-28T11:59:59.000Z' },
        now,
        true,
      ).kind,
    ).toBe('reconcile');
    expect(planScan({ ...base, lastFullScanAt: null }, now, true).kind).toBe(
      'reconcile',
    );
  });
});

describe('retryDelayMs', () => {
  it('backs off exponentially within an hour and honors source advice', () => {
    expect(retryDelayMs(1)).toBe(30_000);
    expect(retryDelayMs(3)).toBe(120_000);
    expect(retryDelayMs(20)).toBe(syncPolicy.maxRetryDelayMs);
    expect(retryDelayMs(1, 90_000)).toBe(90_000);
  });

  it('spreads keyed delays over the upper half of the backoff, reproducibly', () => {
    const delays = Array.from({ length: 50 }, (_, index) =>
      retryDelayMs(3, undefined, `stream-${index}`),
    );

    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(60_000);
      expect(delay).toBeLessThan(120_000);
    }
    expect(new Set(delays).size).toBeGreaterThan(40);
    expect(retryDelayMs(3, undefined, 'stream-1')).toBe(
      retryDelayMs(3, undefined, 'stream-1'),
    );
  });

  it('keeps source advice and the hour cap when jittered', () => {
    expect(retryDelayMs(1, 90_000, 'stream-1')).toBe(90_000);
    expect(retryDelayMs(1, 5 * 60 * 60_000, 'stream-1')).toBe(
      syncPolicy.maxRetryDelayMs,
    );
    const capped = retryDelayMs(30, undefined, 'stream-1');
    expect(capped).toBeGreaterThanOrEqual(syncPolicy.maxRetryDelayMs / 2);
    expect(capped).toBeLessThanOrEqual(syncPolicy.maxRetryDelayMs);
  });
});

describe('streamStatus', () => {
  const stream = {
    paused: false,
    blocked: null,
    error: null,
    attempts: 0,
    phase: 'incremental' as const,
    scan: null,
  };
  const error = { code: 'timeout', message: 'x', at: now.toISOString() };

  it('separates recoverable retries from failures that need attention', () => {
    expect(streamStatus({ ...stream, error, attempts: 2 })).toBe('retrying');
    expect(
      streamStatus({
        ...stream,
        error,
        attempts: syncPolicy.failingAfterAttempts,
      }),
    ).toBe('failing');
  });

  it('puts pauses and blocks before errors', () => {
    expect(streamStatus({ ...stream, error, paused: true })).toBe('paused');
    expect(
      streamStatus({ ...stream, error, blocked: 'connection_inactive' }),
    ).toBe('blocked');
  });

  it('reports imports, waiting fulfillment history and current syncs', () => {
    expect(streamStatus({ ...stream, phase: 'backfill' })).toBe('importing');
    expect(streamStatus({ ...stream, phase: 'backfill' }, true)).toBe(
      'waiting',
    );
    expect(streamStatus(stream)).toBe('up_to_date');
  });
});

describe('historyWindow', () => {
  it('offers older history once the source stops limiting it', () => {
    const limited = {
      historyFrom: '2026-07-31T12:00:00.000Z',
      historyRequirement: 'read_all_orders',
      currentHistoryLimited: true,
      phase: 'incremental' as const,
    };

    expect(historyWindow(limited).olderHistoryAvailable).toBe(false);
    expect(
      historyWindow({ ...limited, currentHistoryLimited: false })
        .olderHistoryAvailable,
    ).toBe(true);
    expect(
      historyWindow({
        ...limited,
        historyFrom: null,
        currentHistoryLimited: false,
      }),
    ).toEqual({
      from: null,
      requirement: 'read_all_orders',
      olderHistoryAvailable: false,
    });
  });
});

describe('recordTypeFor', () => {
  it('maps read capabilities to record types', () => {
    expect(recordTypeFor('fulfillment.read')).toBe('fulfillments');
    expect(recordTypeFor('orders.shipping-method.read')).toBeNull();
  });
});

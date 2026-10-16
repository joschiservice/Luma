import { describe, expect, it } from 'vitest';

import {
  ago,
  attentionItems,
  capabilityRecordType,
  connectionCommands,
  coverageBrief,
  coverageStatement,
  focusStream,
  linkMethodLabel,
  overallState,
  recordNote,
  runDuration,
  scanProgress,
  soon,
  streamState,
  syncFigures,
  syncHealth,
  waitingStatement,
} from './presentation';
import {
  attention,
  current,
  delayed,
  disconnected,
  importing,
  jtl,
  opportunities,
  recentHistory,
  stream,
} from './sync-fixtures';

describe('coverageStatement', () => {
  it('never claims completeness before the history import finishes', () => {
    expect(
      coverageStatement(
        'orders',
        stream({
          phase: 'backfill',
          records: {
            total: 12,
            current: 12,
            pending: 0,
            failed: 0,
            missing: 0,
            retired: 0,
          },
        }),
      ),
    ).toEqual({
      text: '12 orders imported so far. The list is complete when the history import finishes.',
      limited: false,
    });
  });

  it('states the creation dates covered and any source history limit', () => {
    const shopifyOrders = current.connections[0]!.recordTypes[0]!.stream!;
    expect(coverageStatement('orders', shopifyOrders)).toEqual({
      text: '3,100 orders placed 31 Jul 2026 – 29 Sept 2026. The source didn’t share orders placed before 31 Jul 2026.',
      limited: true,
    });
    expect(
      coverageStatement(
        'products',
        stream({
          records: {
            total: 1,
            current: 1,
            pending: 0,
            failed: 0,
            retired: 0,
            missing: 0,
          },
        }),
      ).text,
    ).toBe('1 product, everything the source shares.');
    expect(coverageStatement('inventory', stream()).text).toBe(
      'The source has no stock levels to share.',
    );
  });
});

describe('sync states', () => {
  it('labels active reads and progress with or without a reported total', () => {
    const orders = importing.connections[0]!.recordTypes[0]!.stream!;
    expect(streamState(orders)).toEqual({
      state: 'running',
      label: 'Importing history',
    });
    expect(scanProgress('orders', orders)).toEqual({
      value: 40,
      text: '1,240 of 3,100 orders',
    });
    const stock = importing.connections[0]!.recordTypes[3]!.stream!;
    expect(streamState(stock).label).toBe('Checking all records');
    expect(scanProgress('inventory', stock)).toEqual({
      value: null,
      text: '75 stock levels read',
    });
  });

  it('summarizes the workspace by what needs people first', () => {
    expect(overallState(attention)).toMatchObject({
      state: 'error',
      title: '2 syncs need attention',
    });
    expect(overallState(importing)).toMatchObject({
      state: 'running',
      title: 'Importing history',
    });
    expect(overallState(current)).toMatchObject({
      state: 'verified',
      title: 'Up to date',
      detail: 'Last checked for changes 2 minutes ago.',
    });
  });

  it('formats relative times in both directions', () => {
    const now = Date.parse('2026-09-29T09:00:00.000Z');
    expect(ago('2026-09-29T08:59:55.000Z', now)).toBe('just now');
    expect(ago('2026-09-29T06:00:00.000Z', now)).toBe('3 hours ago');
    expect(soon('2026-09-29T09:04:00.000Z', now)).toBe('in 4 minutes');
    expect(soon('2026-09-29T08:59:00.000Z', now)).toBe('now');
  });
});

describe('recent history coverage', () => {
  const orders = recentHistory.connections[0]!.recordTypes[0]!.stream!;
  it('distinguishes export preparation from imported recent records and full history', () => {
    expect(streamState(orders).label).toBe('Preparing history');
    expect(scanProgress('orders', orders)).toEqual({
      value: null,
      text: 'The source is preparing an export',
    });
    expect(coverageStatement('orders', orders).text).toBe(
      'Orders since 30 Aug 2026 are imported. Older history continues to import in the background.',
    );
  });
  it('keeps coverage qualified when imports are paused, incomplete or source limited', () => {
    expect(
      coverageStatement('orders', { ...orders, paused: true }).text,
    ).toContain('Importing older history is paused.');
    expect(
      coverageStatement('orders', {
        ...orders,
        records: { ...orders.records, failed: 1 },
      }).text,
    ).toContain('are read, and some need attention');
    expect(
      coverageStatement('orders', {
        ...orders,
        coverage: { ...orders.coverage, historyFrom: '2026-09-01T00:00:00Z' },
      }).text,
    ).toContain('since 1 Sept 2026');
  });
});

it('reports paused history without claiming it is continuing in the background', () => {
  const overview = {
    ...recentHistory,
    connections: recentHistory.connections.map((connection) => ({
      ...connection,
      recordTypes: connection.recordTypes.map((item) =>
        item.stream?.phase === 'backfill'
          ? {
              ...item,
              stream: {
                ...item.stream,
                status: 'paused' as const,
                paused: true,
              },
            }
          : item,
      ),
    })),
  };
  expect(overallState(overview)).toMatchObject({
    state: 'idle',
    title: 'History import paused',
  });
});

describe('link methods', () => {
  it('names each stored method in the interface language', () => {
    expect(
      [
        'Imported source record with its own canonical identity',
        'Linked by a person as the same record in another source',
        'Re-keyed under an explicitly linked order',
        'Unlinked by a person from another source',
        'Automatically linked by rule 7, revision 2',
        'Explicit simulator stock-pool mapping',
      ].map(linkMethodLabel),
    ).toEqual([
      'Imported',
      'Linked by a person',
      'Linked by a person',
      'Unlinked',
      'Linked by a rule',
      'Matched on import',
    ]);
  });
});

describe('waiting explanations', () => {
  it.each([
    ['request_capacity', 'Waiting for rate limit'],
    ['provider_cooldown', 'Waiting for rate limit'],
    ['connection_capacity', 'Waiting for sync capacity'],
    ['orders', 'Waiting for orders'],
    ['admission_unavailable', 'Read scheduling unavailable'],
    ['recent_changes', 'Waiting for recent changes'],
    ['queued', 'Waiting'],
  ] as const)('labels %s accurately', (reason, label) => {
    const waiting = stream({
      status: 'waiting',
      waiting: {
        reason,
        connections: [],
        observedAt: '2026-10-14T13:00:00Z',
        until: null,
      },
    });
    expect(streamState(waiting)).toEqual({ state: 'waiting', label });
  });

  it('explains provider cooldowns and automatic retries', () => {
    expect(
      waitingStatement(
        stream({
          status: 'waiting',
          waiting: {
            reason: 'provider_cooldown',
            connections: [],
            observedAt: '2026-10-14T13:00:00Z',
            until: '2026-10-14T13:01:00Z',
          },
        }),
      ),
    ).toBe(
      'The source’s request limit has been reached. Luma will retry automatically.',
    );
  });

  it('names rate-limited retries without hiding failures or manual pauses', () => {
    const retrying = stream({
      status: 'retrying',
      error: {
        code: 'rate_limited',
        message: 'The source asked Luma to slow down.',
        at: '2026-10-14T13:00:00Z',
        attempts: 1,
      },
    });
    expect(streamState(retrying)).toEqual({
      state: 'attention',
      label: 'Retrying after rate limit',
    });
    expect(streamState({ ...retrying, status: 'failing' })).toEqual({
      state: 'error',
      label: 'Failing',
    });
    expect(streamState({ ...retrying, status: 'paused' }).label).toBe('Paused');
    expect(
      streamState({
        ...retrying,
        error: {
          code: 'timeout',
          message: 'The source did not respond in time.',
          at: '2026-10-14T13:00:00Z',
          attempts: 1,
        },
      }).label,
    ).toBe('Retrying');
  });

  it('keeps the waiting label separate from paused and names capacity holders', () => {
    const waiting = stream({
      status: 'waiting',
      waiting: {
        reason: 'worker_capacity',
        connections: [{ connectionId: 'cin7', label: 'Cin7 warehouse' }],
        observedAt: '2026-10-14T13:00:00Z',
        until: '2026-10-14T13:01:00Z',
      },
    });
    expect(streamState(waiting)).toEqual({
      state: 'waiting',
      label: 'Waiting for sync capacity',
    });
    expect(waitingStatement(waiting)).toBe(
      'Waiting for sync capacity. Currently syncing: Cin7 warehouse.',
    );
    expect(waitingStatement({ ...waiting, status: 'syncing' })).toBeNull();
    expect(streamState({ ...waiting, status: 'paused' }).label).toBe('Paused');
  });

  it('explains budget waits and never invents a connection for them', () => {
    const waiting = stream({
      status: 'waiting',
      waiting: {
        reason: 'request_capacity',
        connections: [],
        observedAt: '2026-10-14T13:00:00Z',
        until: '2026-10-14T13:01:00Z',
      },
    });
    expect(waitingStatement(waiting)).toBe(
      'Luma is waiting for request capacity to stay within the source’s rate limit. It will retry automatically.',
    );
  });

  it('surfaces delayed work separately, preserving progress without promising continuation', () => {
    const target = delayed.connections[0]!.recordTypes[0]!.stream!;
    expect(streamState(target)).toEqual({
      state: 'attention',
      label: 'Sync delayed',
    });
    expect(waitingStatement(target)).toBe(
      'This sync is overdue and has not been picked up yet. Imported records remain available.',
    );
    expect(scanProgress('orders', target)?.text).toBe('1,240 of 3,100 orders');
    expect(overallState(delayed)).toMatchObject({
      state: 'attention',
      title: '1 sync is delayed',
    });
    expect(
      syncHealth(delayed).find((group) => group.group === 'delayed'),
    ).toMatchObject({ count: 1, label: '1 delayed', state: 'attention' });
  });

  it('summarizes evidenced wait reasons while other imports progress', () => {
    expect(overallState(delayed).detail).toContain(
      '1 sync is waiting for provider limits.',
    );
    expect(overallState(delayed).detail).toContain(
      '1 sync is waiting for orders to import.',
    );
    expect(waitingStatement(stream({ status: 'waiting', waiting: null }))).toBe(
      'Waiting for the next sync pass.',
    );
    expect(
      streamState(stream({ status: 'waiting', waiting: null })).label,
    ).toBe('Waiting');
  });
});

describe('syncHealth', () => {
  it('counts syncs per state, most urgent first, and treats change reads as up to date', () => {
    expect(
      syncHealth(importing).map(({ group, count }) => [group, count]),
    ).toEqual([
      ['retrying', 1],
      ['importing', 1],
      ['waiting', 1],
      ['current', 5],
    ]);
    expect(syncHealth(attention).map((group) => group.label)).toEqual([
      '2 need attention',
      '2 up to date',
    ]);
  });
});

describe('syncFigures', () => {
  it('reports the stalest read and full check, and counts syncs that never read', () => {
    expect(syncFigures(importing)).toMatchObject({
      records: 42749,
      imported: 6,
      total: 8,
      oldestSync: null,
      neverSynced: 1,
      oldestCheck: '2026-09-29T02:10:00.000Z',
    });
    expect(syncFigures(current).oldestSync).toBe('2026-09-29T08:57:30.000Z');
  });
});

describe('attentionItems', () => {
  it('leads with blocked and failing syncs and leaves automatic retries out', () => {
    const items = attentionItems(attention, true);
    expect(items.map((item) => [item.tone, item.title, item.action])).toEqual([
      ['danger', 'This sync is waiting for someone to resume it', 'resume'],
      ['danger', 'Failed 6 times in a row', 'retry'],
    ]);
    expect(attentionItems(importing, true)).toEqual([]);
  });

  it('explains to read-only members who can resume a sync', () => {
    expect(attentionItems(attention, false)[0]!.detail).toBe(
      'It ran with the access of someone who no longer manages this workspace.',
    );
  });

  it('offers older history and lists records that couldn’t import', () => {
    expect(
      attentionItems(opportunities, true).map((item) => [
        item.tone,
        item.title,
        item.detail,
        item.action,
      ]),
    ).toEqual([
      [
        'warning',
        'Couldn’t import 2 products',
        'Reasons: The product has no SKU code. They’re missing from Luma’s lists until they import.',
        null,
      ],
      [
        'info',
        'Older orders are now available',
        'The source no longer limits history. Re-import to add orders from before 31 Jul 2026.',
        'reimport',
      ],
    ]);
  });

  it('names an inactive connection once instead of each of its syncs', () => {
    expect(
      attentionItems(disconnected, true).map((item) => [
        item.key,
        item.title,
        item.action,
      ]),
    ).toEqual([
      [`connection-${jtl.connectionId}`, 'JTL-Wawi isn’t active', 'connection'],
    ]);
  });
});

describe('coverageBrief', () => {
  it('summarizes what a sync holds in one short line', () => {
    const shopifyOrders = current.connections[0]!.recordTypes[0]!.stream!;
    expect(coverageBrief('orders', shopifyOrders)).toBe(
      '3,100 orders · shared from 31 Jul 2026',
    );
    expect(coverageBrief('orders', jtl.recordTypes[0]!.stream!)).toBe(
      '18,342 orders since 2 Mar 2019',
    );
    expect(
      coverageBrief(
        'orders',
        recentHistory.connections[0]!.recordTypes[0]!.stream!,
      ),
    ).toBe('3,100 orders so far · recent history complete');
    expect(coverageBrief('fulfillments', stream({ phase: 'backfill' }))).toBe(
      'Nothing imported yet',
    );
  });

  it('flags the most important record problem', () => {
    expect(recordNote('orders', jtl.recordTypes[0]!.stream!)).toBe(
      '2 orders not found in the last full check',
    );
    expect(recordNote('products', jtl.recordTypes[2]!.stream!)).toBeNull();
  });
});

describe('connectionCommands', () => {
  it('syncs running syncs, pauses unpaused ones and resumes paused or orphaned ones', () => {
    const commands = connectionCommands(attention.connections[0]!);
    expect(commands.retry).toHaveLength(3);
    expect(commands.pause).toHaveLength(4);
    expect(commands.resume.map((item) => item.blocked)).toEqual([
      'principal_unavailable',
    ]);
  });
});

describe('focusStream', () => {
  const syncOf = (type: string) =>
    jtl.recordTypes.find((item) => item.recordType === type)?.stream?.id;

  it('opens the named record type, or the connection’s most urgent sync', () => {
    expect(focusStream(attention, jtl.connectionId, 'products')).toBe(
      syncOf('products'),
    );
    // Orders and inventory both need a person; the first in list order wins.
    const urgent = attention.connections[0]!.recordTypes.find((item) =>
      ['failing', 'blocked'].includes(item.stream?.status ?? ''),
    );
    expect(focusStream(attention, jtl.connectionId)).toBe(urgent?.stream?.id);
    expect(focusStream(importing, jtl.connectionId)).toBeDefined();
  });

  it('opens nothing for unknown connections or record types without a sync', () => {
    expect(focusStream(attention, crypto.randomUUID())).toBeUndefined();
    expect(
      focusStream(attention, jtl.connectionId, 'inventory_shipments'),
    ).toBeUndefined();
  });
});

describe('capabilityRecordType', () => {
  it('names the record type a read capability imports', () => {
    expect(capabilityRecordType('fulfillment.read')).toBe('fulfillments');
    expect(capabilityRecordType('orders.read')).toBe('orders');
    expect(capabilityRecordType('mail.read')).toBeUndefined();
    expect(capabilityRecordType(undefined)).toBeUndefined();
  });
});

describe('runDuration', () => {
  it('formats short and long runs, and running runs up to now', () => {
    const now = Date.parse('2026-09-29T09:00:00.000Z');
    const run = (startedAt: string, finishedAt: string | null) => ({
      startedAt,
      finishedAt,
    });
    expect(
      runDuration(
        run('2026-09-29T08:59:48.000Z', '2026-09-29T08:59:52.000Z'),
        now,
      ),
    ).toBe('4 secs');
    expect(runDuration(run('2026-09-29T08:40:00.000Z', null), now)).toBe(
      '20 mins',
    );
    expect(
      runDuration(
        run('2026-09-29T06:40:00.000Z', '2026-09-29T08:00:00.000Z'),
        now,
      ),
    ).toBe('1 hr 20 mins');
  });
});

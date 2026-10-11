import { describe, expect, it } from 'vitest';

import {
  ago,
  coverageStatement,
  linkMethodLabel,
  overallState,
  scanProgress,
  soon,
  streamState,
} from './presentation';
import {
  attention,
  current,
  importing,
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

import { describe, expect, it } from 'vitest';

import {
  ago,
  coverageStatement,
  overallState,
  scanProgress,
  soon,
  streamState,
} from './presentation';
import { attention, current, importing, stream } from './sync-fixtures';

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
          },
        }),
      ),
    ).toEqual({
      text: '12 orders so far. Coverage is complete when the history import finishes.',
      limited: false,
    });
  });

  it('states the creation dates covered and any source history limit', () => {
    const shopifyOrders = current.connections[0]!.recordTypes[0]!.stream!;
    expect(coverageStatement('orders', shopifyOrders)).toEqual({
      text: '3,100 orders placed Jul 31, 2026 – Sep 29, 2026. The source didn’t share orders placed before Jul 31, 2026.',
      limited: true,
    });
    expect(
      coverageStatement(
        'products',
        stream({
          records: { total: 1, current: 1, pending: 0, failed: 0, missing: 0 },
        }),
      ).text,
    ).toBe('All 1 product the source shares.');
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
      detail: 'Changes last read 2m ago.',
    });
  });

  it('formats relative times in both directions', () => {
    const now = Date.parse('2026-09-29T09:00:00.000Z');
    expect(ago('2026-09-29T08:59:55.000Z', now)).toBe('just now');
    expect(ago('2026-09-29T06:00:00.000Z', now)).toBe('3h ago');
    expect(soon('2026-09-29T09:04:00.000Z', now)).toBe('in 4m');
    expect(soon('2026-09-29T08:59:00.000Z', now)).toBe('now');
  });
});

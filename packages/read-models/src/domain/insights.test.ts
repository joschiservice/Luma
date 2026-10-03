import { describe, expect, it } from 'vitest';

import type { InsightSource, SourceRead } from './insights.js';
import {
  countPoints,
  coverageState,
  dataThrough,
  pointCoverage,
  sourceState,
  stockPoint,
} from './insights.js';

const asOf = '2026-10-01T12:00:00.000Z';

const read = (stream: Partial<NonNullable<SourceRead['stream']>> | null) => ({
  connectionId: 'c1',
  label: 'Store',
  system: 'shopify',
  connectionStatus: 'active',
  stream: stream && {
    phase: 'incremental',
    paused: false,
    blocked: false,
    failing: false,
    watermark: '2026-10-01T11:00:00.000Z',
    historyFrom: null,
    lastSuccessAt: '2026-10-01T11:00:00.000Z',
    ...stream,
  },
});

const source = (overrides: Partial<InsightSource>): InsightSource => ({
  connectionId: 'c1',
  label: 'Store',
  system: null,
  state: 'complete',
  historyFrom: null,
  dataThrough: '2026-10-01T11:00:00.000Z',
  lastReadAt: null,
  ...overrides,
});

describe('source coverage', () => {
  it('prefers problems that leave counts incomplete over staleness and limits', () => {
    const windowFrom = '2026-09-01T00:00:00.000Z';
    expect(sourceState(read(null), asOf, windowFrom)).toBe('not_synced');
    expect(sourceState(read({ phase: 'backfill' }), asOf, windowFrom)).toBe(
      'importing',
    );
    expect(sourceState(read({ watermark: null }), asOf, windowFrom)).toBe(
      'importing',
    );
    expect(
      sourceState(read({ failing: true, paused: true }), asOf, windowFrom),
    ).toBe('paused');
    expect(
      sourceState(
        read({ watermark: '2026-09-29T00:00:00.000Z' }),
        asOf,
        windowFrom,
      ),
    ).toBe('stale');
    expect(
      sourceState(
        read({ historyFrom: '2026-09-10T00:00:00.000Z' }),
        asOf,
        windowFrom,
      ),
    ).toBe('limited');
    // Current-state charts have no window, so a history limit doesn't apply.
    expect(
      sourceState(
        read({ historyFrom: '2026-09-10T00:00:00.000Z' }),
        asOf,
        null,
      ),
    ).toBe('complete');
    expect(
      sourceState(
        { ...read({}), connectionStatus: 'revoked' },
        asOf,
        windowFrom,
      ),
    ).toBe('disconnected');
  });

  it('never reports zero coverage as complete', () => {
    expect(coverageState([])).toBe('unavailable');
    expect(coverageState([source({}), source({ state: 'stale' })])).toBe(
      'stale',
    );
    expect(
      coverageState([source({ state: 'stale' }), source({ state: 'limited' })]),
    ).toBe('partial');
    expect(coverageState([source({})])).toBe('complete');
  });

  it('takes the oldest complete read, unknown when any source has none', () => {
    expect(
      dataThrough([
        source({ dataThrough: '2026-10-01T11:00:00.000Z' }),
        source({ dataThrough: '2026-10-01T09:00:00.000Z' }),
      ]),
    ).toBe('2026-10-01T09:00:00.000Z');
    expect(dataThrough([source({}), source({ dataThrough: null })])).toBe(null);
    expect(dataThrough([])).toBe(null);
  });
});

describe('point coverage', () => {
  const bucket = {
    from: '2026-09-20T00:00:00.000Z',
    before: '2026-09-21T00:00:00.000Z',
  };
  const through = '2026-10-01T11:00:00.000Z';

  it('marks buckets before every imported history as not imported', () => {
    const later = source({ historyFrom: '2026-09-21T00:00:00.000Z' });
    expect(pointCoverage(bucket, [later, later], through)).toBe('not_imported');
    // One source with full history can still report the bucket.
    expect(pointCoverage(bucket, [later, source({})], through)).toBe('partial');
    // Observed-only sources might hold records, so the bucket isn't known to be empty.
    expect(
      pointCoverage(bucket, [later, source({ state: 'not_synced' })], through),
    ).toBe('partial');
  });

  it('marks buckets that start before history or end after the last complete read', () => {
    expect(
      pointCoverage(
        bucket,
        [source({ historyFrom: '2026-09-20T12:00:00.000Z' })],
        through,
      ),
    ).toBe('partial');
    expect(
      pointCoverage(bucket, [source({})], '2026-09-20T18:00:00.000Z'),
    ).toBe('partial');
    expect(pointCoverage(bucket, [source({})], through)).toBe('complete');
  });
});

describe('chart points', () => {
  it('lists every series with zeros and ignores unknown series', () => {
    expect(
      countPoints(
        [{ key: 'a' }, { key: 'b' }],
        ['open', 'closed'],
        [
          { point: 'a', series: 'open', count: 2 },
          { point: 'a', series: 'other', count: 5 },
        ],
      ).map((point) => [point.key, point.values, point.total]),
    ).toEqual([
      ['a', { open: 2, closed: 0 }, 2],
      ['b', { open: 0, closed: 0 }, 0],
    ]);
  });

  it('places unusable stock as unknown before comparing it with the minimum', () => {
    const position = {
      unknownReason: null,
      belowMinimum: true,
      purchaseOrderIds: [] as string[],
    };
    expect(stockPoint(position)).toBe('below_no_order');
    expect(stockPoint({ ...position, purchaseOrderIds: ['po'] })).toBe(
      'below_with_order',
    );
    expect(stockPoint({ ...position, belowMinimum: false })).toBe(
      'at_or_above',
    );
    expect(stockPoint({ ...position, unknownReason: 'expired' })).toBe(
      'unknown',
    );
  });
});

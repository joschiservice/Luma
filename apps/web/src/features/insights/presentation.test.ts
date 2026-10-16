import type { InsightChartResponse } from '@luma/api-contract';
import { describe, expect, it } from 'vitest';

import {
  insightChartOptions,
  insightScope,
  insightsSearch,
  insightsView,
  nextInsightsSearch,
} from './data';
import {
  amount,
  chartCategories,
  chartSeries,
  coverageBadge,
  dataThroughText,
  excludedText,
  periodComparison,
  selectionTitle,
  selectionValue,
  timelineStats,
} from './presentation';

const point = (
  start: string,
  values: Record<string, number>,
  coverage: 'complete' | 'partial' | 'not_imported' = 'complete',
) => ({
  key: start,
  start,
  end: start,
  from: `${start}T00:00:00.000Z`,
  before: `${start}T23:59:59.000Z`,
  values,
  total: Object.values(values).reduce((a, b) => a + b, 0),
  coverage,
});

const orders: InsightChartResponse = {
  chart: 'orders',
  kind: 'timeline',
  unit: 'order',
  series: ['open', 'completed', 'cancelled', 'unknown'],
  points: [
    point(
      '2026-09-29',
      { open: 0, completed: 0, cancelled: 0, unknown: 0 },
      'not_imported',
    ),
    point('2026-09-30', { open: 2, completed: 1, cancelled: 0, unknown: 0 }),
    point(
      '2026-10-01',
      { open: 1, completed: 0, cancelled: 1, unknown: 0 },
      'partial',
    ),
  ],
  total: 5,
  window: {
    range: '7d',
    bucket: 'day',
    start: '2026-09-29',
    end: '2026-10-01',
    from: '2026-09-29T00:00:00.000Z',
    before: '2026-10-02T00:00:00.000Z',
    timeZone: 'UTC',
  },
  sourceFilter: 'applied',
  coverage: {
    state: 'partial',
    sources: [
      {
        connectionId: '11111111-1111-4111-8111-111111111111',
        label: 'Store',
        system: 'shopify',
        state: 'limited',
        historyFrom: '2026-09-30T00:00:00.000Z',
        dataThrough: '2026-10-01T09:30:00.000Z',
        lastReadAt: '2026-10-01T09:31:00.000Z',
      },
    ],
    excluded: [{ reason: 'no_placed_time', count: 2 }],
  },
  dataThrough: '2026-10-01T09:30:00.000Z',
  previous: {
    from: '2026-09-22T00:00:00.000Z',
    before: '2026-09-24T10:00:00.000Z',
    total: 4,
    coverage: 'complete',
  },
  asOf: '2026-10-01T10:00:00.000Z',
};

describe('chart presentation', () => {
  it('keeps unknown periods distinct from zero and explains incomplete ones', () => {
    const categories = chartCategories(orders, 'UTC');
    expect(categories.map((c) => [c.label, c.unknown !== undefined])).toEqual([
      ['Tue 29 Sept', true],
      ['Wed 30 Sept', false],
      ['Thu 1 Oct', false],
    ]);
    expect(categories[2]!.note).toBe(
      'Incomplete: sources read through 1 Oct 09:30',
    );
    expect(categories[1]!.note).toBeUndefined();
  });

  it('marks the current period as running when nothing else is known', () => {
    const complete = {
      ...orders,
      points: orders.points.map((p) => ({
        ...p,
        coverage: 'complete' as const,
      })),
    };
    expect(chartCategories(complete, 'UTC').at(-1)!.note).toBe('Today so far');
  });

  it('names coverage, data-through time and records it can’t place', () => {
    expect(coverageBadge(orders)).toEqual({
      label: 'Partial coverage',
      tone: 'warning',
    });
    expect(
      coverageBadge({
        ...orders,
        coverage: { ...orders.coverage, state: 'unavailable', sources: [] },
      }).label,
    ).toBe('No source in this view');
    expect(dataThroughText(orders, 'Europe/Berlin')).toBe(
      'Data through 1 Oct 11:30',
    );
    expect(dataThroughText({ ...orders, dataThrough: null }, 'UTC')).toMatch(
      /unknown/,
    );
    expect(excludedText(orders)).toEqual([
      '2 orders without a placed time aren’t shown.',
    ]);
    expect(amount('orders', 1)).toBe('1 order');
    expect(chartSeries(orders).map((s) => s.label)).toEqual([
      'Open',
      'Completed',
      'Canceled',
      'Status unknown',
    ]);
  });

  it('averages only complete, finished periods and names the busiest known one', () => {
    const week = {
      ...orders,
      points: [
        point(
          '2026-09-26',
          { open: 9, completed: 0, cancelled: 0, unknown: 0 },
          'not_imported',
        ),
        point(
          '2026-09-27',
          { open: 0, completed: 4, cancelled: 0, unknown: 0 },
          'partial',
        ),
        point('2026-09-28', {
          open: 1,
          completed: 1,
          cancelled: 0,
          unknown: 0,
        }),
        point('2026-09-29', {
          open: 0,
          completed: 4,
          cancelled: 0,
          unknown: 0,
        }),
        point('2026-09-30', {
          open: 6,
          completed: 0,
          cancelled: 0,
          unknown: 0,
        }),
      ],
    };
    // Today (the last point), the partial day and the unimported day stay out of the average.
    expect(timelineStats(week)).toEqual({
      average: 3,
      averagedPeriods: 2,
      peak: { key: '2026-09-30', label: 'Wed 30 Sept', total: 6 },
    });
    expect(timelineStats(orders)).toMatchObject({
      average: 3,
      averagedPeriods: 1,
    });
    // Without a finished, complete period there is no average to state.
    expect(
      timelineStats({ ...orders, points: orders.points.slice(-1) })?.average,
    ).toBeNull();
    // A breakdown has no periods.
    expect(timelineStats({ ...orders, window: null })).toBeNull();
    // A timeline of zeros has no busiest period.
    expect(
      timelineStats({
        ...orders,
        points: orders.points.map((p) => ({ ...p, total: 0, values: {} })),
      })?.peak,
    ).toBeNull();
  });

  it('compares with the previous period only when both are fully known', () => {
    const known: InsightChartResponse = {
      ...orders,
      points: orders.points.slice(1),
      coverage: { ...orders.coverage, state: 'complete' },
    };
    // The running day may be partial; it is compared with the same part of its counterpart.
    expect(periodComparison(known)).toEqual({
      comparable: true,
      previous: 4,
      difference: 1,
      ratio: 0.25,
    });
    expect(
      periodComparison({
        ...known,
        previous: { ...known.previous!, total: 0 },
      }),
    ).toMatchObject({ difference: 5, ratio: null });
    // An unimported day, a limited source or an unimported previous stretch would count
    // missing records as change.
    expect(periodComparison({ ...known, points: orders.points })).toEqual({
      comparable: false,
    });
    expect(periodComparison(orders)).toEqual({ comparable: false });
    expect(
      periodComparison({
        ...known,
        previous: { ...known.previous!, coverage: 'partial' },
      }),
    ).toEqual({ comparable: false });
    expect(periodComparison({ ...known, previous: null })).toBeNull();
  });

  it('titles and totals a selection the way the chart showed it', () => {
    expect(
      selectionTitle(orders, { point: '2026-09-30', series: 'open' }, 'UTC'),
    ).toBe('Orders · Open · Wed 30 Sept');
    expect(selectionValue(orders, { point: '2026-09-30' })).toBe(3);
    expect(selectionValue(orders, { series: 'open' })).toBe(3);
    expect(selectionValue(orders, {})).toBe(5);
    // The previous stretch is named with its bounds and totals what the comparison showed.
    expect(selectionTitle(orders, { point: 'previous' }, 'UTC')).toBe(
      'Orders · Previous period, 22 Sept – 24 Sept 10:00',
    );
    expect(selectionValue(orders, { point: 'previous' })).toBe(4);
  });
});

describe('insights URL state', () => {
  it('drops unsupported values and keeps the drilldown', () => {
    expect(
      insightsSearch.parse({
        range: 'year',
        source: 'not-a-uuid',
        chart: 'orders',
        point: '2026-09-30',
        series: 'open',
      }),
    ).toEqual({ chart: 'orders', point: '2026-09-30', series: 'open' });
    expect(insightScope({}, 'Europe/Berlin')).toEqual({
      range: '30d',
      timeZone: 'Europe/Berlin',
    });
  });

  it('opens the view that holds a link’s chart, range or report', () => {
    expect(insightsView({})).toBe('now');
    expect(insightsView({ view: 'outcomes', chart: 'orders' })).toBe(
      'outcomes',
    );
    expect(insightsView({ chart: 'orders', point: '2026-09-30' })).toBe(
      'trends',
    );
    expect(insightsView({ chart: 'cases' })).toBe('trends');
    expect(insightsView({ chart: 'fulfillment', series: 'held' })).toBe('now');
    expect(insightsView({ metric: 'orders.open' })).toBe('now');
    expect(insightsView({ range: '7d' })).toBe('trends');
    expect(insightsView({ reportWindow: '7d' })).toBe('outcomes');
    expect(insightsView({ outcomeEnv: 'pilot' })).toBe('outcomes');
    expect(
      insightsView({ source: '11111111-1111-4111-8111-111111111111' }),
    ).toBe('now');
    expect(insightsSearch.parse({ view: 'later' })).toEqual({});
  });

  it('keeps the view on screen when a change would otherwise infer another one', () => {
    // Closing the records of an inferred Trends view stays on Trends.
    expect(
      nextInsightsSearch(
        { chart: 'cases', point: '2026-09-30' },
        { chart: undefined, point: undefined },
      ),
    ).toMatchObject({ view: 'trends', chart: undefined });
    // A view the address already implies isn't written.
    expect(
      nextInsightsSearch({ range: '7d' }, { chart: 'orders' }).view,
    ).toBeUndefined();
    expect(nextInsightsSearch({ range: '7d' }, { view: 'now' }).view).toBe(
      'now',
    );
    expect(nextInsightsSearch({ view: 'trends' }, { view: 'now' }).view).toBe(
      undefined,
    );
  });

  it('separates caches by workspace and scope, but not for Luma’s own records', () => {
    const scope = { range: '7d' as const, timeZone: 'UTC' };
    const source = {
      ...scope,
      connectionId: '11111111-1111-4111-8111-111111111111',
    };
    expect(insightChartOptions('a', 'orders', scope).queryKey).not.toEqual(
      insightChartOptions('b', 'orders', scope).queryKey,
    );
    expect(insightChartOptions('a', 'orders', scope).queryKey).not.toEqual(
      insightChartOptions('a', 'orders', source).queryKey,
    );
    expect(insightChartOptions('a', 'cases', scope).queryKey).toEqual(
      insightChartOptions('a', 'cases', source).queryKey,
    );
  });
});

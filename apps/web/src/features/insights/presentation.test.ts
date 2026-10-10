import type { InsightChartResponse } from '@luma/api-contract';
import { describe, expect, it } from 'vitest';

import { insightChartOptions, insightScope, insightsSearch } from './data';
import {
  amount,
  chartCategories,
  chartSeries,
  coverageBadge,
  dataThroughText,
  excludedText,
  selectionTitle,
  selectionValue,
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

  it('titles and totals a selection the way the chart showed it', () => {
    expect(
      selectionTitle(orders, { point: '2026-09-30', series: 'open' }, 'UTC'),
    ).toBe('Orders · Open · Wed 30 Sept');
    expect(selectionValue(orders, { point: '2026-09-30' })).toBe(3);
    expect(selectionValue(orders, { series: 'open' })).toBe(3);
    expect(selectionValue(orders, {})).toBe(5);
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

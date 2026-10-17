import { type InsightChart, type InsightRange } from '@luma/api-contract';
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { z } from 'zod';

import { ApiError } from '../../kit/identity/data';
import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';

const api = createWebApiClient();

const insightCharts = [
  'orders',
  'fulfillment',
  'stock',
  'cases',
  'procurement',
] as const satisfies readonly InsightChart[];

export const insightRanges = [
  '7d',
  '30d',
  '13w',
] as const satisfies readonly InsightRange[];

/**
 * The questions Insights answers, one per view: what is waiting now, how work develops over a
 * range of days, and what Luma's handling achieved.
 */
const insightViews = ['now', 'trends', 'outcomes'] as const;

export type InsightView = (typeof insightViews)[number];

/** Charts that describe the state at the evaluation time; the others are timelines. */
export const currentStateCharts = [
  'fulfillment',
  'stock',
  'procurement',
] as const satisfies readonly InsightChart[];

/** Charts that count records over the selected range. */
export const trendCharts = [
  'orders',
  'cases',
] as const satisfies readonly InsightChart[];

const outcomeEnvironments = [
  'live',
  'pilot',
  'synthetic',
  'shadow',
  'observe_only',
  'unknown',
] as const;

/**
 * URL state for Insights: the view, the time range and source that scope the charts, and the
 * chart point whose records are open. Keeping the drilldown in the URL lets a reader open a
 * record and come back to the same records. `metric` restores the order metric dialog.
 * `outcomeEnv` and `outcomeWindow` choose the verified-outcome cohort; `report*` scope the
 * resolution report where it is released.
 */
export const insightsSearch = z.object({
  view: z.enum(insightViews).optional().catch(undefined),
  outcomeEnv: z.enum(outcomeEnvironments).optional().catch(undefined),
  outcomeWindow: z.enum(['24h', '7d']).optional().catch(undefined),
  reportArtifact: z.string().max(200).optional().catch(undefined),
  reportVersion: z.string().max(200).optional().catch(undefined),
  reportWindow: z.enum(['7d', '30d', 'custom']).optional().catch(undefined),
  reportStart: z
    .string()
    .datetime({ offset: true })
    .optional()
    .catch(undefined),
  reportEnd: z.string().datetime({ offset: true }).optional().catch(undefined),
  reportClass: z.string().min(1).max(100).optional().catch(undefined),
  reportSource: z.uuid().optional().catch(undefined),
  reportEnv: z.enum(outcomeEnvironments).optional().catch(undefined),
  range: z.enum(insightRanges).optional().catch(undefined),
  source: z.uuid().optional().catch(undefined),
  chart: z.enum(insightCharts).optional().catch(undefined),
  point: z.string().max(40).optional().catch(undefined),
  series: z.string().max(40).optional().catch(undefined),
  metric: z.string().max(200).optional().catch(undefined),
});

export type InsightsSearch = z.infer<typeof insightsSearch>;

const isTrendChart = (chart: InsightChart) =>
  trendCharts.some((candidate) => candidate === chart);

/**
 * The view an address shows. Without `view`, an open chart, a time range or report filters
 * select the view that holds them, so links made before views existed still open their records.
 */
export function insightsView(search: InsightsSearch): InsightView {
  if (search.view) return search.view;
  if (search.chart) return isTrendChart(search.chart) ? 'trends' : 'now';
  if (search.metric?.startsWith('orders.')) return 'now';
  if (search.range) return 'trends';
  const outcomes = Object.entries(search).some(
    ([key, value]) =>
      value !== undefined &&
      (key.startsWith('report') || key.startsWith('outcome')),
  );

  return outcomes ? 'outcomes' : 'now';
}

/**
 * Applies a change to the address while keeping the view on screen, unless the change picks
 * another one. `view` is written only when the rest of the address wouldn't select it, so
 * closing an inferred view's records doesn't switch views, and addresses stay short.
 */
export function nextInsightsSearch(
  search: InsightsSearch,
  patch: Partial<InsightsSearch>,
): InsightsSearch {
  const view = patch.view ?? insightsView(search);
  const next = { ...search, ...patch, view: undefined };

  return insightsView(next) === view ? next : { ...next, view };
}

export type InsightScope = {
  range: InsightRange;
  timeZone: string;
  connectionId?: string | undefined;
};

/** The chart scope from the URL, in the workspace time zone. */
export function insightScope(
  search: InsightsSearch,
  timeZone: string,
): InsightScope {
  return {
    range: search.range ?? '30d',
    timeZone,
    ...(search.source ? { connectionId: search.source } : {}),
  };
}

/** The cache prefix of every Insights chart and record list in a workspace. */
export const insightsKey = (organizationId: string) =>
  ['private', 'organization', organizationId, 'insights'] as const;

/**
 * Reads one chart. Charts of Luma's own records ignore the source, so their cache doesn't
 * split by it either.
 */
export function insightChartOptions(
  organizationId: string,
  chart: InsightChart,
  scope: InsightScope,
) {
  const query =
    chart === 'cases' || chart === 'procurement'
      ? { range: scope.range, timeZone: scope.timeZone }
      : scope;

  return queryOptions({
    ...privateQueryDefaults,
    queryKey: [...insightsKey(organizationId), chart, query],
    refetchOnWindowFocus: true,
    refetchOnReconnect: 'always',
    queryFn: ({ signal }) =>
      api.insights.chart(
        { params: { organizationId, chart }, query },
        { signal },
      ),
  });
}

const recordPageSize = 25;

/**
 * Lists the records behind a chart point and series at the chart's evaluation time, so the
 * list totals what the chart showed. Pages continue from `nextOffset`.
 */
export function insightRecordsOptions(
  organizationId: string,
  chart: InsightChart,
  scope: InsightScope,
  selection: { point?: string | undefined; series?: string | undefined },
  asOf: string,
) {
  const query = {
    ...scope,
    ...(selection.point ? { point: selection.point } : {}),
    ...(selection.series ? { series: selection.series } : {}),
    asOf,
  };

  return infiniteQueryOptions({
    ...privateQueryDefaults,
    queryKey: [...insightsKey(organizationId), chart, 'records', query],
    initialPageParam: 0,
    getNextPageParam: (page: { nextOffset: number | null }) =>
      page.nextOffset ?? undefined,
    queryFn: async ({ signal, pageParam }) => {
      return api.insights.records(
        {
          params: { organizationId, chart },
          query: { ...query, offset: pageParam, limit: recordPageSize },
        },
        { signal },
      );
    },
  });
}

export type InsightsError = 'access' | 'outdated' | 'preparing' | 'unavailable';

/**
 * Classifies a chart or record failure: lost access (the API hides workspaces the reader left),
 * a chart too old to list its records, order history still being prepared, or anything else.
 */
export function insightsError(error: unknown): InsightsError | undefined {
  if (!error) return undefined;
  if (!(error instanceof ApiError)) return 'unavailable';
  if ([401, 403, 404].includes(error.status)) return 'access';
  if (error.status === 400 && error.code === 'VALIDATION_ERROR')
    return 'outdated';
  if (error.status === 503) return 'preparing';

  return 'unavailable';
}

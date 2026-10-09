import { type InsightChart, type InsightRange } from '@luma/api-contract';
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { z } from 'zod';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import { IdentityError } from '../identity/data';

const api = createWebApiClient();

export const insightCharts = [
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
 * URL state for Insights: the time range and source that scope every chart, and the chart
 * point whose records are open. Keeping the drilldown in the URL lets a reader open a record
 * and come back to the same records. `metric` restores the order metric dialog.
 */
export const insightsSearch = z.object({
  range: z.enum(insightRanges).optional().catch(undefined),
  source: z.uuid().optional().catch(undefined),
  chart: z.enum(insightCharts).optional().catch(undefined),
  point: z.string().max(40).optional().catch(undefined),
  series: z.string().max(40).optional().catch(undefined),
  metric: z.string().max(200).optional().catch(undefined),
});

export type InsightsSearch = z.infer<typeof insightsSearch>;

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

export const recordPageSize = 25;

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
  if (!(error instanceof IdentityError)) return 'unavailable';
  if ([401, 403, 404].includes(error.status)) return 'access';
  if (error.status === 400 && error.code === 'VALIDATION_ERROR')
    return 'outdated';
  if (error.status === 503) return 'preparing';

  return 'unavailable';
}

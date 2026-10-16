import './insights.css';

import type { InsightChart } from '@luma/api-contract';
import { WorkspaceTimezone } from '@luma/ui/components/primitives/workspace-date';
import {
  keepPreviousData,
  useQueries,
  useQueryClient,
} from '@tanstack/react-query';
import { useContext, useEffect } from 'react';

import { ChartCard, type Selection } from './chart-card';
import {
  insightChartOptions,
  insightScope,
  insightsError,
  type InsightsSearch,
} from './data';
import { subscribeToInsightChanges } from './live';
import { RecordsSheet } from './records';

/**
 * Charts the given operational areas for the range and source in the URL. Selecting a bar,
 * legend entry, table cell or headline value opens the exact records behind it; the selection
 * stays in the URL so a reader can open a record and come back. Charts refresh when operational
 * data changes, on focus and on reconnect. `layout` sets how many charts share a row on wide
 * screens: timelines read best across the full width, current-state breakdowns side by side.
 */
export function InsightCharts({
  organizationId,
  charts,
  layout,
  search,
  returnPath,
  onSearch,
}: {
  organizationId: string;
  charts: readonly InsightChart[];
  layout: 'stacked' | 'columns';
  search: InsightsSearch;
  /** This page with its current filters, used by record pages to link back. */
  returnPath: string;
  onSearch: (patch: Partial<InsightsSearch>) => void;
}) {
  const timeZone = useContext(WorkspaceTimezone);
  const scope = insightScope(search, timeZone);
  const client = useQueryClient();
  const queries = useQueries({
    queries: charts.map((chart) => ({
      ...insightChartOptions(organizationId, chart, scope),
      placeholderData: keepPreviousData,
    })),
  });
  const queryFor = (chart: InsightChart) => queries[charts.indexOf(chart)];

  useEffect(
    () => subscribeToInsightChanges(organizationId, client),
    [client, organizationId],
  );

  const open = search.chart ? queryFor(search.chart) : undefined;
  const drill = open && !open.isError ? open.data : undefined;
  const select = (chart: InsightChart, selection: Selection) =>
    onSearch({
      chart,
      point: selection.point,
      series: selection.series,
    });

  return (
    <>
      <div className="insights-grid" data-layout={layout}>
        {charts.map((chart, index) => {
          const query = queries[index]!;

          return (
            <ChartCard
              key={chart}
              chart={chart}
              organizationId={organizationId}
              timeZone={timeZone}
              data={query.isError ? undefined : query.data}
              loading={query.isPending}
              refreshing={query.isFetching && !query.isPending}
              previous={query.isPlaceholderData}
              error={insightsError(query.error)}
              selected={
                search.chart === chart
                  ? { point: search.point, series: search.series }
                  : null
              }
              onSelect={(selection) => select(chart, selection)}
              onRetry={() => void query.refetch()}
            />
          );
        })}
      </div>
      {open && drill && (
        <RecordsSheet
          organizationId={organizationId}
          data={drill}
          scope={scope}
          selection={{ point: search.point, series: search.series }}
          timeZone={timeZone}
          returnPath={returnPath}
          onSelect={(selection) => select(drill.chart, selection)}
          onClose={() =>
            onSearch({ chart: undefined, point: undefined, series: undefined })
          }
          onRefreshChart={() => void open.refetch()}
        />
      )}
    </>
  );
}

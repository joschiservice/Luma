import './insights.css';

import type { InsightChart } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { RefreshButton } from '@luma/ui/components/primitives/refresh-button';
import { Select } from '@luma/ui/components/primitives/select';
import { WorkspaceTimezone } from '@luma/ui/components/primitives/workspace-date';
import {
  keepPreviousData,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useContext, useEffect, useId } from 'react';

import { connectionsOptions } from '../../kit/connections/data';
import { ChartCard, type Selection } from './chart-card';
import {
  insightChartOptions,
  insightCharts,
  insightRanges,
  insightScope,
  insightsError,
  insightsKey,
  type InsightsSearch,
} from './data';
import { subscribeToInsightChanges } from './live';
import { rangeLabels } from './presentation';
import { RecordsSheet } from './records';

const layout: Record<InsightChart, string | undefined> = {
  orders: 'insights-card-wide',
  cases: undefined,
  fulfillment: undefined,
  stock: undefined,
  procurement: undefined,
};

const order: InsightChart[] = [
  'orders',
  'fulfillment',
  'cases',
  'stock',
  'procurement',
];

/**
 * Charts orders, fulfillment backlog, stock risk, issues and procurement for the range and
 * source in the URL. Selecting a bar, legend entry or table cell opens the exact records
 * behind it; the selection stays in the URL so a reader can open a record and come back.
 * Charts refresh when operational data changes, on focus and on reconnect.
 */
export function OperationalCharts({
  organizationId,
  search,
  returnPath,
  onSearch,
}: {
  organizationId: string;
  search: InsightsSearch;
  /** This page with its current filters, used by record pages to link back. */
  returnPath: string;
  onSearch: (patch: Partial<InsightsSearch>, replace?: boolean) => void;
}) {
  const headingId = useId();
  const timeZone = useContext(WorkspaceTimezone);
  const scope = insightScope(search, timeZone);
  const client = useQueryClient();
  const connections = useQuery(connectionsOptions(organizationId));
  const charts = useQueries({
    queries: insightCharts.map((chart) => ({
      ...insightChartOptions(organizationId, chart, scope),
      placeholderData: keepPreviousData,
    })),
  });
  const queryFor = (chart: InsightChart) =>
    charts[insightCharts.indexOf(chart)]!;

  useEffect(
    () => subscribeToInsightChanges(organizationId, client),
    [client, organizationId],
  );

  const sources = (connections.data ?? []).filter(
    (connection) => !['disconnected', 'revoked'].includes(connection.status),
  );
  const drill = search.chart ? queryFor(search.chart).data : undefined;
  const select = (chart: InsightChart, selection: Selection) =>
    onSearch({
      chart,
      point: selection.point,
      series: selection.series,
    });

  return (
    <section className="insights-trends" aria-labelledby={headingId}>
      <header className="insights-trends-header">
        <div>
          <p className="order-metrics-eyebrow">{m.insights_trends_eyebrow()}</p>
          <h2 id={headingId}>{m.insights_trends_title()}</h2>
          <p>{m.insights_trends_description()}</p>
        </div>
        <div className="insights-filters">
          <Select
            className="insights-filter"
            aria-label={m.insights_filter_range()}
            value={scope.range}
            options={insightRanges.map((range) => ({
              value: range,
              label: rangeLabels[range](),
            }))}
            onValueChange={(range) =>
              onSearch({
                range: range === '30d' ? undefined : (range ?? undefined),
                chart: undefined,
                point: undefined,
                series: undefined,
              })
            }
          />
          <Select
            className="insights-filter"
            aria-label={m.common_source()}
            value={search.source ?? 'all'}
            options={[
              { value: 'all', label: m.insights_filter_source_all() },
              ...sources.map((connection) => ({
                value: connection.id,
                label: connection.label,
              })),
            ]}
            onValueChange={(source) =>
              onSearch({
                source: source && source !== 'all' ? source : undefined,
                chart: undefined,
                point: undefined,
                series: undefined,
              })
            }
          />
          <RefreshButton
            size="icon-sm"
            label={m.insights_refresh_charts()}
            onClick={() =>
              void client.invalidateQueries({
                queryKey: insightsKey(organizationId),
              })
            }
          />
        </div>
      </header>
      <div className="insights-grid">
        {order.map((chart) => {
          const query = queryFor(chart);

          return (
            <ChartCard
              key={chart}
              chart={chart}
              className={layout[chart]}
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
      {search.chart && drill && !queryFor(search.chart).isError && (
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
          onRefreshChart={() => void queryFor(drill.chart).refetch()}
        />
      )}
    </section>
  );
}

import type {
  AdaptiveViewPreview,
  AdaptiveViewQuery,
} from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { BarChart } from '@luma/ui/components/primitives/bar-chart';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@luma/ui/components/primitives/card';
import { DataTable } from '@luma/ui/components/primitives/data-table';

import { LinePlot } from './line-plot';
import { cellValue, columnLabel } from './presentation';

/**
 * A view's metrics and charts over its complete filtered query, each chart paired with a table
 * of the same values. Incomplete or cut-off results say so instead of reading as totals.
 */
export function ViewMetricsAndCharts({
  configuration,
  preview,
  header,
}: {
  configuration: Pick<AdaptiveViewQuery, 'metrics' | 'charts'>;
  preview: Pick<AdaptiveViewPreview, 'aggregates' | 'chartSeries'>;
  /** Names a column or custom field heading. */
  header: (key: string) => string;
}) {
  return (
    <>
      {configuration.metrics.length ? (
        <div className="adaptive-metrics">
          {configuration.metrics.map((metric) => {
            const aggregate = preview.aggregates.find(
              (item) => item.metricId === metric.id,
            );

            return (
              <div className="adaptive-metric" key={metric.id}>
                <span>{columnLabel(metric.id)}</span>
                <strong>
                  {aggregate?.value === null || !aggregate
                    ? m.adaptive_unknown()
                    : formatNumber(aggregate.value)}
                </strong>
                {!aggregate?.complete ? (
                  <span>{m.overview_coverage_partial()}</span>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {configuration.charts.map((chart) => {
        const series = preview.chartSeries.find((item) => item.id === chart.id);
        const categories = (series?.points ?? []).map((point, index) => ({
          key: String(index),
          label: cellValue(point.key),
          values: { count: point.value ?? 0 },
          ...(point.value === null ? { unknown: m.adaptive_unknown() } : {}),
          ...(!series?.complete ? { note: m.overview_coverage_partial() } : {}),
        }));

        return (
          <Card key={chart.id}>
            <CardHeader>
              <CardTitle as="h3">{columnLabel(chart.id)}</CardTitle>
              <p>
                {series?.truncated
                  ? m.adaptive_chart_truncated()
                  : !series?.complete
                    ? m.overview_coverage_partial()
                    : m.adaptive_chart_complete()}
              </p>
            </CardHeader>
            <CardContent>
              {chart.type === 'line' ? (
                <LinePlot points={categories} label={columnLabel(chart.id)} />
              ) : (
                <BarChart
                  label={columnLabel(chart.id)}
                  orientation="horizontal"
                  series={[
                    {
                      id: 'count',
                      label: columnLabel(chart.metricId),
                      color: 'chart-1',
                    },
                  ]}
                  categories={categories}
                />
              )}
              <DataTable
                caption={columnLabel(chart.id)}
                density="compact"
                variant="plain"
                rows={categories}
                rowKey={(row) => row.key}
                columns={[
                  {
                    key: 'label',
                    header: header(chart.groupBy),
                    cell: (row) => row.label,
                  },
                  {
                    key: 'count',
                    header: columnLabel(chart.metricId),
                    numeric: true,
                    cell: (row) =>
                      row.unknown
                        ? m.adaptive_unknown()
                        : formatNumber(row.values.count),
                  },
                ]}
              />
            </CardContent>
          </Card>
        );
      })}
    </>
  );
}

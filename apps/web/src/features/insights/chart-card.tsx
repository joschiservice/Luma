import type { InsightChart, InsightChartResponse } from '@luma/api-contract';
import { formatNumber, formatTime } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
import { Badge } from '@luma/ui/components/primitives/badge';
import {
  BarChart,
  type ChartCategory,
  ChartLegend,
} from '@luma/ui/components/primitives/bar-chart';
import { Button } from '@luma/ui/components/primitives/button';
import { Card } from '@luma/ui/components/primitives/card';
import {
  DataTable,
  type DataTableColumn,
} from '@luma/ui/components/primitives/data-table';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import { DomainIcon } from '@luma/ui/components/primitives/domain-icon';
import { StateDot } from '@luma/ui/components/primitives/state';
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from '@luma/ui/components/primitives/tabs';
import { Link } from '@tanstack/react-router';
import { RefreshCw } from 'lucide-react';
import { useId, useState } from 'react';

import type { InsightsError } from './data';
import {
  amount,
  chartCategories,
  chartLabel,
  chartSeries,
  coverageBadge,
  dataThroughText,
  definitions,
  excludedText,
  rangeLabels,
  seriesTotals,
  sourceDetail,
  sourceStates,
  windowLabel,
} from './presentation';

/** The chart point and series whose records are open; either may be absent. */
export type Selection = {
  point?: string | undefined;
  series?: string | undefined;
};

const errorText = {
  access: {
    title: m.insights_error_access_title,
    body: m.insights_error_access_body,
  },
  outdated: {
    title: m.insights_error_unavailable_title,
    body: m.insights_error_outdated_body,
  },
  preparing: {
    title: m.insights_error_preparing_title,
    body: m.insights_error_preparing_body,
  },
  unavailable: {
    title: m.insights_error_unavailable_title,
    body: m.insights_error_unavailable_body,
  },
} satisfies Record<InsightsError, { title: () => string; body: () => string }>;

/**
 * One operational chart with its definition, a table twin, coverage and data-through time.
 * Counts are never shown when the read failed or nothing in scope can report the records.
 */
export function ChartCard({
  chart,
  organizationId,
  timeZone,
  data,
  loading,
  refreshing,
  error,
  selected,
  onSelect,
  onRetry,
  className,
}: {
  chart: InsightChart;
  organizationId: string;
  timeZone: string;
  data: InsightChartResponse | undefined;
  loading: boolean;
  refreshing: boolean;
  error: InsightsError | undefined;
  selected: Selection | null;
  onSelect: (selection: Selection) => void;
  onRetry: () => void;
  className?: string | undefined;
}) {
  const definition = definitions[chart];
  const titleId = useId();
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const badge = data && !error ? coverageBadge(data) : null;
  const title = definition.title();

  return (
    <Card
      as="section"
      aria-labelledby={titleId}
      className={['insights-card', className].filter(Boolean).join(' ')}
      data-chart={chart}
    >
      <header className="insights-card-header">
        <DomainIcon domain={definition.domain} size="sm" />
        <h3 id={titleId}>{title}</h3>
        <p className="insights-card-description">{definition.description()}</p>
        <div className="insights-card-actions">
          {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
          <Tabs
            value={view}
            onValueChange={(next) =>
              setView(next === 'table' ? 'table' : 'chart')
            }
          >
            <TabsList
              aria-label={m.insights_card_view_label({ chart: title })}
              activateOnFocus={false}
            >
              <TabsTrigger value="chart">
                {m.insights_card_view_chart()}
              </TabsTrigger>
              <TabsTrigger value="table">
                {m.insights_card_view_table()}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </header>
      <div className="insights-card-body">
        {error ? (
          <div className="insights-card-state" role="alert">
            <strong>{errorText[error].title()}</strong>
            <p>{errorText[error].body()}</p>
            <Button variant="outline" size="sm" onClick={onRetry}>
              <RefreshCw size={14} />
              {m.common_try_again()}
            </Button>
          </div>
        ) : loading || !data ? (
          <div
            className="insights-card-skeleton lu-skeleton"
            role="status"
            aria-label={m.insights_card_loading({ chart: title })}
          />
        ) : data.coverage.state === 'unavailable' ? (
          <Unavailable chart={chart} organizationId={organizationId} />
        ) : (
          <Content
            data={data}
            timeZone={timeZone}
            view={view}
            refreshing={refreshing}
            selected={selected}
            onSelect={onSelect}
          />
        )}
      </div>
      {data && !error && <Coverage data={data} timeZone={timeZone} />}
    </Card>
  );
}

function Unavailable({
  chart,
  organizationId,
}: {
  chart: InsightChart;
  organizationId: string;
}) {
  const definition = definitions[chart];

  return (
    <div className="insights-card-state">
      <strong>{definition.unavailable()}</strong>
      <p>
        {chart === 'stock'
          ? m.insights_stock_unavailable_body()
          : m.insights_unavailable_body()}
      </p>
      {chart === 'stock' ? (
        <Link
          to="/app/$organizationId/workflows/$definitionId"
          params={{ organizationId, definitionId: 'inventory-replenishment' }}
          hash="rules"
        >
          {m.insights_unavailable_setup_rules()}
        </Link>
      ) : (
        <Link to="/app/$organizationId/apps" params={{ organizationId }}>
          {m.insights_unavailable_connect_source()}
        </Link>
      )}
    </div>
  );
}

function Content({
  data,
  timeZone,
  view,
  refreshing,
  selected,
  onSelect,
}: {
  data: InsightChartResponse;
  timeZone: string;
  view: 'chart' | 'table';
  refreshing: boolean;
  selected: Selection | null;
  onSelect: (selection: Selection) => void;
}) {
  const definition = definitions[data.chart];
  const series = chartSeries(data);
  const categories = chartCategories(data, timeZone);
  const multiple = series.length > 1;
  const label = chartLabel(data);
  const total = rich(definition.amount, {
    count: data.total,
    value: <strong>{formatNumber(data.total)}</strong>,
  });

  return (
    <>
      <p className="insights-total" aria-live="polite">
        {data.window
          ? rich(m.insights_total_window, {
              amount: <>{total}</>,
              window: windowLabel(data.window),
            })
          : rich(m.insights_total_now, {
              amount: <>{total}</>,
              time: formatTime(data.asOf, {
                hour: '2-digit',
                minute: '2-digit',
                hourCycle: 'h23',
                timeZone,
              }),
            })}
      </p>
      {view === 'chart' ? (
        <>
          {multiple && (
            <ChartLegend
              series={series}
              totals={seriesTotals(data)}
              selected={selected?.point ? undefined : selected?.series}
              onSelect={(id) => onSelect({ series: id })}
            />
          )}
          <BarChart
            label={label}
            orientation={definition.orientation}
            series={series}
            categories={categories}
            unit={(value) => amount(data.chart, value)}
            selected={
              selected?.point
                ? { category: selected.point, series: selected.series }
                : null
            }
            busy={refreshing}
            onSelect={({ category, series: id }) =>
              onSelect({ point: category, ...(id ? { series: id } : {}) })
            }
          />
          {data.total === 0 && (
            <p className="insights-empty-note">{definition.empty()}</p>
          )}
        </>
      ) : (
        <ChartTable
          data={data}
          categories={categories}
          caption={label}
          onSelect={onSelect}
        />
      )}
    </>
  );
}

type Row = ChartCategory & { total: number };

function ChartTable({
  data,
  categories,
  caption,
  onSelect,
}: {
  data: InsightChartResponse;
  categories: ChartCategory[];
  caption: string;
  onSelect: (selection: Selection) => void;
}) {
  const series = chartSeries(data);
  const cellLabel = (row: Row, value: number, id?: string) => {
    const name = id ? series.find((s) => s.id === id)?.label : undefined;

    return name
      ? m.insights_table_cell_series({
          amount: amount(data.chart, value),
          category: row.label,
          series: name,
        })
      : m.insights_table_cell({
          amount: amount(data.chart, value),
          category: row.label,
        });
  };
  const cell = (row: Row, value: number, id?: string) =>
    row.unknown ? (
      <span className="insights-unknown">{m.common_unknown()}</span>
    ) : value ? (
      <button
        type="button"
        className="insights-cell-link"
        aria-label={cellLabel(row, value, id)}
        onClick={() =>
          onSelect({ point: row.key, ...(id ? { series: id } : {}) })
        }
      >
        {formatNumber(value)}
      </button>
    ) : (
      <span className="insights-zero">{formatNumber(0)}</span>
    );
  const columns: DataTableColumn<Row>[] = [
    {
      key: 'label',
      header: data.window
        ? data.window.bucket === 'day'
          ? m.insights_table_day()
          : m.insights_table_week()
        : m.insights_table_group(),
      cell: (row) => (
        <span className="insights-row-label">
          {row.label}
          {(row.unknown ?? row.note) && (
            <small>
              {row.unknown ? m.insights_table_not_imported() : row.note}
            </small>
          )}
        </span>
      ),
    },
    ...(series.length > 1
      ? series.map((s): DataTableColumn<Row> => ({
          key: s.id,
          header: s.label,
          numeric: true,
          hideOnNarrow: true,
          cell: (row) => cell(row, row.values[s.id] ?? 0, s.id),
        }))
      : []),
    {
      key: 'total',
      header:
        series.length > 1
          ? m.insights_table_total()
          : (series[0]?.label ?? m.insights_table_total()),
      numeric: true,
      cell: (row) => cell(row, row.total),
    },
  ];

  return (
    <DataTable
      caption={caption}
      columns={columns}
      rows={categories.map((category) => ({
        ...category,
        total: Object.values(category.values).reduce((a, b) => a + b, 0),
      }))}
      rowKey={(row) => row.key}
      density="compact"
      variant="plain"
    />
  );
}

function Coverage({
  data,
  timeZone,
}: {
  data: InsightChartResponse;
  timeZone: string;
}) {
  const definition = definitions[data.chart];
  const excluded = excludedText(data);

  return (
    <footer className="insights-coverage">
      <dl>
        <div>
          <dt>{m.insights_coverage_period()}</dt>
          <dd>
            {data.window
              ? `${rangeLabels[data.window.range]()} · ${windowLabel(data.window)} · ${data.window.timeZone}`
              : m.insights_coverage_current()}
          </dd>
        </div>
        <div>
          <dt>{m.insights_coverage_data_through()}</dt>
          <dd>{dataThroughText(data, timeZone)}</dd>
        </div>
        <div>
          <dt>{m.common_sources()}</dt>
          <dd>
            {data.sourceFilter === 'not_applicable' ? (
              m.insights_coverage_own_records()
            ) : data.coverage.sources.length ? (
              <ul className="insights-sources">
                {data.coverage.sources.map((source) => (
                  <li key={source.connectionId}>
                    <StateDot state={sourceStates[source.state].state} />
                    <span>
                      <strong>{source.label}</strong>{' '}
                      {sourceDetail(source, timeZone)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              m.insights_coverage_no_sources()
            )}
          </dd>
        </div>
      </dl>
      {excluded.map((text) => (
        <p key={text} className="insights-excluded">
          {text}
        </p>
      ))}
      {definition.limit && (
        <Disclosure variant="plain" className="insights-limit">
          <summary>{m.insights_coverage_limit_summary()}</summary>
          <p>{definition.limit()}</p>
        </Disclosure>
      )}
    </footer>
  );
}

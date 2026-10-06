import type { InsightChart, InsightChartResponse } from '@luma/api-contract';
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

import { count } from '../sync/presentation';
import type { InsightsError } from './data';
import {
  amount,
  chartCategories,
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

const errorText: Record<InsightsError, { title: string; body: string }> = {
  access: {
    title: 'Workspace access changed',
    body: 'Sign in again or ask an owner for access to see this chart.',
  },
  outdated: {
    title: 'Chart unavailable',
    body: 'The chart request was rejected. Refresh to try again.',
  },
  preparing: {
    title: 'Order history is being prepared',
    body: 'Luma is rebuilding the order list after an update. Try again in a few minutes.',
  },
  unavailable: {
    title: 'Chart unavailable',
    body: 'Luma couldn’t read this chart. Earlier values are hidden so they aren’t mistaken for current ones.',
  },
};

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

  return (
    <Card
      as="section"
      aria-labelledby={titleId}
      className={['insights-card', className].filter(Boolean).join(' ')}
      data-chart={chart}
    >
      <header className="insights-card-header">
        <DomainIcon domain={definition.domain} size="sm" />
        <h3 id={titleId}>{definition.title}</h3>
        <p className="insights-card-description">{definition.description}</p>
        <div className="insights-card-actions">
          {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
          <Tabs
            value={view}
            onValueChange={(next) =>
              setView(next === 'table' ? 'table' : 'chart')
            }
          >
            <TabsList
              aria-label={`${definition.title} view`}
              activateOnFocus={false}
            >
              <TabsTrigger value="chart">Chart</TabsTrigger>
              <TabsTrigger value="table">Table</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </header>
      <div className="insights-card-body">
        {error ? (
          <div className="insights-card-state" role="alert">
            <strong>{errorText[error].title}</strong>
            <p>{errorText[error].body}</p>
            <Button variant="outline" size="sm" onClick={onRetry}>
              <RefreshCw size={14} />
              Try again
            </Button>
          </div>
        ) : loading || !data ? (
          <div
            className="insights-card-skeleton lu-skeleton"
            role="status"
            aria-label={`Loading ${definition.title.toLowerCase()}`}
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
      <strong>Nothing can report {definition.many} yet</strong>
      <p>
        {chart === 'stock'
          ? 'No position has an active replenishment rule, so stock risk is unknown, not zero.'
          : `No connected source in this scope reads ${definition.many}, so the count is unknown, not zero.`}
      </p>
      {chart === 'stock' ? (
        <Link
          to="/app/$organizationId/workflows/$definitionId"
          params={{ organizationId, definitionId: 'inventory-replenishment' }}
          hash="rules"
        >
          Set up replenishment rules
        </Link>
      ) : (
        <Link to="/app/$organizationId/apps" params={{ organizationId }}>
          Connect a source
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
  const label = `${definition.title}${
    data.window ? `, ${rangeLabels[data.window.range].toLowerCase()}` : ''
  }`;

  return (
    <>
      <p className="insights-total" aria-live="polite">
        <strong>{count(data.total)}</strong>{' '}
        {data.total === 1 ? definition.one : definition.many}
        {data.window
          ? ` · ${windowLabel(data.window)}`
          : ` · now, ${new Intl.DateTimeFormat('en-US', {
              hour: '2-digit',
              minute: '2-digit',
              hourCycle: 'h23',
              timeZone,
            }).format(new Date(data.asOf))}`}
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
            <p className="insights-empty-note">
              {data.window
                ? `No ${definition.many} in this period from the sources in scope.`
                : `No ${definition.many} right now.`}
            </p>
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
  const definition = definitions[data.chart];
  const series = chartSeries(data);
  const cell = (row: Row, value: number, id?: string) =>
    row.unknown ? (
      <span className="insights-unknown">Unknown</span>
    ) : value ? (
      <button
        type="button"
        className="insights-cell-link"
        aria-label={`${amount(data.chart, value)}, ${row.label}${
          id ? `, ${series.find((s) => s.id === id)?.label}` : ''
        }. Show the records.`}
        onClick={() =>
          onSelect({ point: row.key, ...(id ? { series: id } : {}) })
        }
      >
        {count(value)}
      </button>
    ) : (
      <span className="insights-zero">0</span>
    );
  const columns: DataTableColumn<Row>[] = [
    {
      key: 'label',
      header: data.window
        ? data.window.bucket === 'day'
          ? 'Day'
          : 'Week'
        : 'Group',
      cell: (row) => (
        <span className="insights-row-label">
          {row.label}
          {(row.unknown ?? row.note) && (
            <small>{row.unknown ? 'Not imported' : row.note}</small>
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
      header: series.length > 1 ? 'Total' : definition.series[0]!.label,
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
          <dt>Window</dt>
          <dd>
            {data.window
              ? `${rangeLabels[data.window.range]} · ${windowLabel(data.window)} · ${data.window.timeZone}`
              : 'Current state; past states aren’t reconstructed'}
          </dd>
        </div>
        <div>
          <dt>Data through</dt>
          <dd>{dataThroughText(data, timeZone)}</dd>
        </div>
        <div>
          <dt>Sources</dt>
          <dd>
            {data.sourceFilter === 'not_applicable' ? (
              'Luma’s own records; the source filter doesn’t apply'
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
              'None in scope'
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
          <summary>What this chart doesn’t show</summary>
          <p>{definition.limit}</p>
        </Disclosure>
      )}
    </footer>
  );
}

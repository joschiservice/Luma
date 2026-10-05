import {
  BarChart,
  type ChartCategory,
  ChartLegend,
  type ChartSeries,
} from '@luma/ui/components/primitives/bar-chart';
import { Button } from '@luma/ui/components/primitives/button';
import { Card } from '@luma/ui/components/primitives/card';
import {
  DataTable,
  type DataTableColumn,
} from '@luma/ui/components/primitives/data-table';
import { type ReactNode, useId, useState } from 'react';

import { formatCount } from '../lib/format';

/**
 * A titled chart with a table of the same values, so nothing depends on hovering or color.
 * Two or more series get a legend. `controls` sit beside the view toggle, such as a filter.
 */
export function ChartCard({
  title,
  description,
  series,
  categories,
  unit = (value) => formatCount(value),
  orientation = 'vertical',
  busy = false,
  controls,
  categoryHeader = 'Period',
  className,
}: {
  title: string;
  description: string;
  series: ChartSeries[];
  categories: ChartCategory[];
  unit?: (value: number) => string;
  orientation?: 'vertical' | 'horizontal';
  busy?: boolean;
  controls?: ReactNode;
  categoryHeader?: string;
  className?: string;
}) {
  const titleId = useId();
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const columns: DataTableColumn<ChartCategory>[] = [
    { key: 'category', header: categoryHeader, cell: (row) => row.label },
    ...series.map((s) => ({
      key: s.id,
      header: s.label,
      numeric: true,
      cell: (row: ChartCategory) =>
        row.unknown ? row.unknown : unit(row.values[s.id] ?? 0),
    })),
  ];

  return (
    <Card
      as="section"
      aria-labelledby={titleId}
      className={['sim-chart-card', className].filter(Boolean).join(' ')}
    >
      <header className="sim-chart-header">
        <div>
          <h3 id={titleId}>{title}</h3>
          <p className="sim-muted">{description}</p>
        </div>
        <div className="sim-chart-controls">
          {controls}
          <div role="group" aria-label={`${title} view`} className="sim-toggle">
            {(['chart', 'table'] as const).map((option) => (
              <Button
                key={option}
                variant="ghost"
                size="sm"
                aria-pressed={view === option}
                onClick={() => setView(option)}
              >
                {option === 'chart' ? 'Chart' : 'Table'}
              </Button>
            ))}
          </div>
        </div>
      </header>
      {categories.length === 0 ? (
        <p className="sim-muted">Nothing reported in this window.</p>
      ) : view === 'chart' ? (
        <>
          <BarChart
            label={title}
            orientation={orientation}
            series={series}
            categories={categories}
            unit={unit}
            busy={busy}
          />
          {series.length > 1 ? <ChartLegend series={series} /> : null}
        </>
      ) : (
        <DataTable
          caption={title}
          columns={columns}
          rows={[...categories].reverse()}
          rowKey={(row) => row.key}
          density="compact"
          variant="plain"
          className="sim-chart-table"
        />
      )}
    </Card>
  );
}

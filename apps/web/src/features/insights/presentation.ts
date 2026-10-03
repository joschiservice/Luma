import type {
  InsightChart,
  InsightChartResponse,
  InsightPoint,
  InsightRange,
  InsightSource,
} from '@luma/api-contract';
import { issueKind } from '@luma/ui/components/issues/case-presentation';
import type {
  ChartCategory,
  ChartColor,
  ChartSeries,
} from '@luma/ui/components/primitives/bar-chart';
import type { Domain } from '@luma/ui/components/primitives/domain-icon';
import type { OperationalState } from '@luma/ui/components/primitives/state';

import { stages } from '../procurement/presentation';
import { count } from '../sync/presentation';

export const rangeLabels: Record<InsightRange, string> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '13w': 'Last 13 weeks',
};

type Definition = {
  title: string;
  /** What is counted, in one or two sentences people can check against the records. */
  description: string;
  domain: Domain;
  orientation: 'vertical' | 'horizontal';
  one: string;
  many: string;
  /** Series in stacking order; labels and colors follow the series, never its rank. */
  series: ChartSeries[];
  /** Labels and colors of breakdown categories. */
  points?: Record<string, { label: string; color?: ChartColor }>;
  /** What the chart can't claim, shown with its coverage. */
  limit?: string;
};

/**
 * What each chart counts and how it is drawn. Statements here must match the server rules in
 * `@luma/read-models` insights, which the record lists share.
 */
export const definitions: Record<InsightChart, Definition> = {
  orders: {
    title: 'Orders placed',
    description:
      'Orders by the day their source says they were placed, colored by their status now. An order linked across sources counts once.',
    domain: 'orders',
    orientation: 'vertical',
    one: 'order',
    many: 'orders',
    series: [
      { id: 'open', label: 'Open', color: 'chart-1' },
      { id: 'completed', label: 'Completed', color: 'chart-2' },
      { id: 'cancelled', label: 'Cancelled', color: 'chart-3' },
      { id: 'unknown', label: 'Status unknown', color: 'muted' },
    ],
    limit:
      'Statuses are today’s, not the status on the day placed. Totals are order counts, not revenue.',
  },
  fulfillment: {
    title: 'Fulfillment backlog',
    description:
      'Open fulfillment work by time since its source last reported progress. Each item counts under its first signal: on hold, then past fulfill-by, then no progress for 48 hours.',
    domain: 'fulfillment',
    orientation: 'vertical',
    one: 'open fulfillment',
    many: 'open fulfillments',
    series: [
      { id: 'held', label: 'On hold', color: 'chart-3' },
      { id: 'overdue', label: 'Past fulfill-by', color: 'chart-5' },
      { id: 'stalled', label: 'No progress', color: 'chart-4' },
      { id: 'none', label: 'No signal', color: 'muted' },
    ],
    points: {
      under_1d: { label: 'Under 1 day' },
      '1_2d': { label: '1–2 days' },
      '2_7d': { label: '2–7 days' },
      over_7d: { label: 'Over 7 days' },
    },
    limit:
      'Today’s backlog only; past backlogs were never observed. Work reported by two systems counts once per system.',
  },
  stock: {
    title: 'Stock risk',
    description:
      'Positions with an active replenishment rule, compared with the rule’s minimum. Stock counts only when its source read is under 5 minutes old.',
    domain: 'inventory',
    orientation: 'horizontal',
    one: 'position',
    many: 'positions',
    series: [{ id: 'positions', label: 'Positions', color: 'chart-1' }],
    points: {
      below_no_order: {
        label: 'Below minimum, no purchase order',
        color: 'error',
      },
      below_with_order: {
        label: 'Below minimum, purchase order recorded',
        color: 'approval',
      },
      unknown: { label: 'Stock unknown', color: 'muted' },
      at_or_above: { label: 'At or above minimum', color: 'success' },
    },
    limit:
      'A recorded purchase order doesn’t mean the supplier confirmed it or that enough stock is on its way. Positions without a rule aren’t counted.',
  },
  cases: {
    title: 'Issues detected',
    description:
      'Issues by the day Luma first detected them, by kind. A reopened issue stays on its first day.',
    domain: 'issues',
    orientation: 'vertical',
    one: 'issue',
    many: 'issues',
    series: [
      'sync_failure',
      'stuck_fulfillment',
      'inventory_mismatch',
      'workflow_failure',
    ].map((id, index) => ({
      id,
      label: issueKind({ class: id }).label,
      color: (['chart-1', 'chart-2', 'chart-3', 'chart-4'] as const)[index]!,
    })),
    limit: 'Counts what Luma detected, not every problem in your sources.',
  },
  procurement: {
    title: 'Purchase orders',
    description:
      'Purchase orders that aren’t closed or cancelled, by the stage their evidence supports. Overdue means a supplier confirmation or delivery is late.',
    domain: 'procurement',
    orientation: 'horizontal',
    one: 'purchase order',
    many: 'purchase orders',
    series: [
      { id: 'not_overdue', label: 'Not overdue', color: 'chart-1' },
      { id: 'overdue', label: 'Overdue', color: 'warning' },
    ],
    points: Object.fromEntries(
      Object.entries(stages).map(([key, stage]) => [
        key,
        { label: stage.label },
      ]),
    ),
    limit:
      'Received means a goods receipt booked in the purchasing system. Stages say nothing about prices or savings.',
  },
};

/** Formats a count with its unit, such as "1 order" or "12 orders". */
export function amount(chart: InsightChart, value: number) {
  const definition = definitions[chart];

  return `${count(value)} ${value === 1 ? definition.one : definition.many}`;
}

const dayFormat = (options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' });

const longDay = dayFormat({ weekday: 'short', month: 'short', day: 'numeric' });

const shortDay = dayFormat({ month: 'short', day: 'numeric' });

const date = (value: string) => new Date(`${value}T00:00:00Z`);

/** Names a calendar bucket, such as "Mon, Sep 21" or "Week of Sep 21". */
export function bucketLabel(point: InsightPoint, bucket: 'day' | 'week') {
  if (!point.start) return point.key;

  return bucket === 'day'
    ? longDay.format(date(point.start))
    : `${shortDay.format(date(point.start))} – ${shortDay.format(date(point.end ?? point.start))}`;
}

/** Formats a time in the workspace time zone, such as "Oct 1, 14:05". */
export function moment(value: string, timeZone: string) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(new Date(value));
}

/** Describes a day range, such as "Sep 2 – Oct 1". */
export function windowLabel(
  window: NonNullable<InsightChartResponse['window']>,
) {
  return `${shortDay.format(date(window.start))} – ${shortDay.format(date(window.end))}`;
}

/**
 * Turns chart points into chart categories, keeping unknown periods distinct from zero and
 * stating why a period is incomplete.
 */
export function chartCategories(
  data: InsightChartResponse,
  timeZone: string,
): ChartCategory[] {
  const definition = definitions[data.chart];
  const bucket = data.window?.bucket;

  return data.points.map((point, index) => {
    const known = definition.points?.[point.key];
    const label = bucket
      ? bucketLabel(point, bucket)
      : (known?.label ?? point.key);
    const current = bucket && index === data.points.length - 1;
    let note: string | undefined;
    if (point.coverage === 'partial')
      note =
        data.dataThrough &&
        point.before &&
        Date.parse(point.before) > Date.parse(data.dataThrough)
          ? `Incomplete: sources read through ${moment(data.dataThrough, timeZone)}`
          : 'Incomplete: starts before the imported history';
    else if (current)
      note = bucket === 'day' ? 'Today so far' : 'This week so far';

    return {
      key: point.key,
      label,
      axisLabel: point.start
        ? shortDay.format(date(point.start))
        : (known?.label ?? point.key),
      values: point.values,
      unknown:
        point.coverage === 'not_imported'
          ? 'Not imported: this period is before the imported history, so its count is unknown.'
          : undefined,
      note,
      color: definition.points?.[point.key]?.color,
    };
  });
}

/** The series to draw: the definition's order and labels, limited to the server's series. */
export function chartSeries(data: InsightChartResponse) {
  return definitions[data.chart].series.filter((s) =>
    data.series.includes(s.id),
  );
}

/** Totals per series across every point, for the legend. */
export function seriesTotals(data: InsightChartResponse) {
  return Object.fromEntries(
    data.series.map((id) => [
      id,
      data.points.reduce((sum, point) => sum + (point.values[id] ?? 0), 0),
    ]),
  );
}

export const sourceStates: Record<
  InsightSource['state'],
  { label: string; state: OperationalState }
> = {
  complete: { label: 'Complete', state: 'verified' },
  limited: { label: 'Limited history', state: 'waiting' },
  importing: { label: 'Importing', state: 'running' },
  stale: { label: 'Stale', state: 'attention' },
  failing: { label: 'Last read failed', state: 'error' },
  paused: { label: 'Sync paused', state: 'attention' },
  disconnected: { label: 'Disconnected', state: 'error' },
  not_synced: { label: 'Observed records only', state: 'waiting' },
};

/** A badge for the chart's overall coverage; unavailable never reads as an empty chart. */
export function coverageBadge(data: InsightChartResponse): {
  label: string;
  tone: 'neutral' | 'warning' | 'danger' | 'success';
} {
  switch (data.coverage.state) {
    case 'complete':
      return { label: 'Complete coverage', tone: 'success' };
    case 'stale':
      return { label: 'Stale sources', tone: 'warning' };
    case 'partial':
      return { label: 'Partial coverage', tone: 'warning' };
    default:
      return data.chart === 'stock'
        ? { label: 'No active rules', tone: 'warning' }
        : { label: 'No source in scope', tone: 'danger' };
  }
}

/** Explains what one source contributes, such as "history from Aug 2". */
export function sourceDetail(source: InsightSource, timeZone: string) {
  const parts = [sourceStates[source.state].label];
  if (source.historyFrom)
    parts.push(`history from ${shortDay.format(new Date(source.historyFrom))}`);
  if (source.state === 'not_synced')
    parts.push('no complete import, so missing records can’t be ruled out');
  else if (source.dataThrough)
    parts.push(`read through ${moment(source.dataThrough, timeZone)}`);

  return parts.join(' · ');
}

const excludedLabels: Record<
  string,
  (value: number, chart: InsightChart) => string
> = {
  no_placed_time: (value, chart) =>
    `${amount(chart, value)} without a placed time aren’t shown.`,
  no_detection_time: (value, chart) =>
    `${amount(chart, value)} without a detection time aren’t shown.`,
  other_class: (value, chart) =>
    `${amount(chart, value)} of other kinds aren’t shown.`,
};

/** Sentences about records in scope that the chart can't place. */
export function excludedText(data: InsightChartResponse) {
  return data.coverage.excluded.map(
    (item) =>
      excludedLabels[item.reason]?.(item.count, data.chart) ??
      `${amount(data.chart, item.count)} can’t be placed on this chart.`,
  );
}

/** States how current the counts are, or why that is unknown. */
export function dataThroughText(data: InsightChartResponse, timeZone: string) {
  if (data.chart === 'cases' || data.chart === 'procurement')
    return `Luma records, current at ${moment(data.asOf, timeZone)}`;
  if (data.chart === 'stock')
    return !data.total
      ? 'No monitored positions'
      : data.dataThrough
        ? `Every position read since ${moment(data.dataThrough, timeZone)}`
        : 'Some positions have no usable stock read';
  if (data.dataThrough)
    return `Data through ${moment(data.dataThrough, timeZone)}`;

  return data.coverage.sources.length
    ? 'Data-through time unknown: not every source has completed an import'
    : 'No source can report these records';
}

/** Names the records a selection opens, such as "Open orders · Mon, Sep 21". */
export function selectionTitle(
  data: InsightChartResponse,
  selection: { point?: string | undefined; series?: string | undefined },
  timeZone: string,
) {
  const definition = definitions[data.chart];
  const point = data.points.find((p) => p.key === selection.point);
  const category = point
    ? chartCategories({ ...data, points: [point] }, timeZone)[0]!.label
    : null;
  const series = definition.series.find((s) => s.id === selection.series);
  const noun = `${definition.many[0]!.toUpperCase()}${definition.many.slice(1)}`;
  const what = series
    ? data.series.length > 1
      ? `${noun} · ${series.label}`
      : noun
    : noun;

  return category ? `${what} · ${category}` : what;
}

/** The value a selection showed on the chart. */
export function selectionValue(
  data: InsightChartResponse,
  selection: { point?: string | undefined; series?: string | undefined },
) {
  const points = selection.point
    ? data.points.filter((p) => p.key === selection.point)
    : data.points;

  return points.reduce(
    (sum, point) =>
      sum +
      (selection.series ? (point.values[selection.series] ?? 0) : point.total),
    0,
  );
}

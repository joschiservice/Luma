import type {
  InsightChart,
  InsightChartResponse,
  InsightPoint,
  InsightRange,
  InsightSource,
} from '@luma/api-contract';
import {
  formatCalendarDate,
  formatDate,
  formatDateTime,
  formatNumber,
} from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { issueKind } from '@luma/ui/components/issues/case-presentation';
import type {
  ChartCategory,
  ChartColor,
  ChartSeries,
} from '@luma/ui/components/primitives/bar-chart';
import type { Domain } from '@luma/ui/components/primitives/domain-icon';
import type { OperationalState } from '@luma/ui/components/primitives/state';

import { stages } from '../procurement/presentation';

/** Names each time range, such as "Last 7 days", in the active language. */
export const rangeLabels = {
  '7d': m.insights_range_7d,
  '30d': m.insights_range_30d,
  '13w': m.insights_range_13w,
} satisfies Record<InsightRange, () => string>;

/** Time ranges as they read inside a sentence, such as "last 7 days". */
const inlineRangeLabels = {
  '7d': m.insights_range_7d_inline,
  '30d': m.insights_range_30d_inline,
  '13w': m.insights_range_13w_inline,
} satisfies Record<InsightRange, () => string>;

/** A count with its noun; `value` is the displayed number, `count` selects the plural. */
type AmountMessage = (inputs: {
  count: number;
  value: NonNullable<unknown>;
}) => string;

type Definition = {
  title: () => string;
  /** What is counted, in one or two sentences people can check against the records. */
  description: () => string;
  domain: Domain;
  orientation: 'vertical' | 'horizontal';
  amount: AmountMessage;
  /** The records a selection lists, such as "Orders". */
  records: () => string;
  /** Why nothing can report these records yet. */
  unavailable: () => string;
  /** Shown under an empty chart; it describes this chart only. */
  empty: () => string;
  /** Series in stacking order; labels and colors follow the series, never its rank. */
  series: () => ChartSeries[];
  /** Labels and colors of breakdown categories. */
  points?: () => Record<string, { label: string; color?: ChartColor }>;
  /** What the chart can't claim, shown with its coverage. */
  limit?: () => string;
};

const caseColors = ['chart-1', 'chart-2', 'chart-3', 'chart-4'] as const;

/**
 * What each chart counts and how it is drawn. Statements here must match the server rules in
 * `@luma/read-models` insights, which the record lists share. Text is read at render time so it
 * follows the active language.
 */
export const definitions: Record<InsightChart, Definition> = {
  orders: {
    title: m.insights_orders_title,
    description: m.insights_orders_description,
    domain: 'orders',
    orientation: 'vertical',
    amount: m.insights_orders_amount,
    records: m.insights_orders_records,
    unavailable: m.insights_orders_unavailable_title,
    empty: m.insights_orders_empty,
    series: () => [
      { id: 'open', label: m.insights_orders_series_open(), color: 'chart-1' },
      {
        id: 'completed',
        label: m.insights_orders_series_completed(),
        color: 'chart-2',
      },
      {
        id: 'cancelled',
        label: m.insights_orders_series_canceled(),
        color: 'chart-3',
      },
      {
        id: 'unknown',
        label: m.insights_orders_series_unknown(),
        color: 'muted',
      },
    ],
    limit: m.insights_orders_limit,
  },
  fulfillment: {
    title: m.insights_fulfillment_title,
    description: m.insights_fulfillment_description,
    domain: 'fulfillment',
    orientation: 'vertical',
    amount: m.insights_fulfillment_amount,
    records: m.insights_fulfillment_records,
    unavailable: m.insights_fulfillment_unavailable_title,
    empty: m.insights_fulfillment_empty,
    series: () => [
      {
        id: 'held',
        label: m.insights_fulfillment_series_held(),
        color: 'chart-3',
      },
      {
        id: 'overdue',
        label: m.insights_fulfillment_series_overdue(),
        color: 'chart-5',
      },
      {
        id: 'stalled',
        label: m.insights_fulfillment_series_stalled(),
        color: 'chart-4',
      },
      {
        id: 'none',
        label: m.insights_fulfillment_series_none(),
        color: 'muted',
      },
    ],
    points: () => ({
      under_1d: { label: m.insights_fulfillment_age_under_1d() },
      '1_2d': { label: m.insights_fulfillment_age_1_2d() },
      '2_7d': { label: m.insights_fulfillment_age_2_7d() },
      over_7d: { label: m.insights_fulfillment_age_over_7d() },
    }),
    limit: m.insights_fulfillment_limit,
  },
  stock: {
    title: m.insights_stock_title,
    description: m.insights_stock_description,
    domain: 'inventory',
    orientation: 'horizontal',
    amount: m.insights_stock_amount,
    records: m.insights_stock_records,
    unavailable: m.insights_stock_unavailable_title,
    empty: m.insights_stock_empty,
    series: () => [
      {
        id: 'positions',
        label: m.insights_stock_series_positions(),
        color: 'chart-1',
      },
    ],
    points: () => ({
      below_no_order: {
        label: m.insights_stock_point_below_no_order(),
        color: 'error',
      },
      below_with_order: {
        label: m.insights_stock_point_below_with_order(),
        color: 'approval',
      },
      unknown: { label: m.insights_stock_point_unknown(), color: 'muted' },
      at_or_above: {
        label: m.insights_stock_point_at_or_above(),
        color: 'success',
      },
    }),
    limit: m.insights_stock_limit,
  },
  cases: {
    title: m.insights_cases_title,
    description: m.insights_cases_description,
    domain: 'issues',
    orientation: 'vertical',
    amount: m.insights_cases_amount,
    records: m.insights_cases_records,
    unavailable: m.insights_cases_unavailable_title,
    empty: m.insights_cases_empty,
    series: () =>
      [
        'sync_failure',
        'stuck_fulfillment',
        'inventory_mismatch',
        'workflow_failure',
      ].map((id, index) => ({
        id,
        label: issueKind({ class: id }).label,
        color: caseColors[index]!,
      })),
    limit: m.insights_cases_limit,
  },
  procurement: {
    title: m.insights_procurement_title,
    description: m.insights_procurement_description,
    domain: 'procurement',
    orientation: 'horizontal',
    amount: m.insights_procurement_amount,
    records: m.insights_procurement_records,
    unavailable: m.insights_procurement_unavailable_title,
    empty: m.insights_procurement_empty,
    series: () => [
      {
        id: 'not_overdue',
        label: m.insights_procurement_series_not_overdue(),
        color: 'chart-1',
      },
      {
        id: 'overdue',
        label: m.insights_procurement_series_overdue(),
        color: 'warning',
      },
    ],
    points: () =>
      Object.fromEntries(
        Object.entries(stages).map(([key, stage]) => [
          key,
          { label: stage.label },
        ]),
      ),
    limit: m.insights_procurement_limit,
  },
};

/** Formats a count with its unit, such as "1 order" or "12 orders". */
export function amount(chart: InsightChart, value: number) {
  return definitions[chart].amount({
    count: value,
    value: formatNumber(value),
  });
}

/** Names a chart with its range for assistive technology, such as "Orders placed, last 7 days". */
export function chartLabel(data: InsightChartResponse) {
  const title = definitions[data.chart].title();

  return data.window
    ? m.insights_chart_label({
        chart: title,
        range: inlineRangeLabels[data.window.range](),
      })
    : title;
}

const longDay = (value: string) =>
  formatCalendarDate(value, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });

const shortDay = (value: string) =>
  formatCalendarDate(value, { month: 'short', day: 'numeric' });

/** Names a calendar bucket, such as "Mon 21 Sept" or "21 Sept – 27 Sept". */
export function bucketLabel(point: InsightPoint, bucket: 'day' | 'week') {
  if (!point.start) return point.key;

  return bucket === 'day'
    ? longDay(point.start)
    : m.insights_date_range({
        start: shortDay(point.start),
        end: shortDay(point.end ?? point.start),
      });
}

/** Formats a time in the workspace time zone, such as "1 Oct, 14:05". */
export function moment(value: string, timeZone: string) {
  return formatDateTime(value, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  });
}

/** Describes a day range, such as "2 Sept – 1 Oct". */
export function windowLabel(
  window: NonNullable<InsightChartResponse['window']>,
) {
  return m.insights_date_range({
    start: shortDay(window.start),
    end: shortDay(window.end),
  });
}

/**
 * Turns chart points into chart categories, keeping unknown periods distinct from zero and
 * stating why a period is incomplete.
 */
export function chartCategories(
  data: InsightChartResponse,
  timeZone: string,
): ChartCategory[] {
  const points = definitions[data.chart].points?.();
  const bucket = data.window?.bucket;

  return data.points.map((point, index) => {
    const known = points?.[point.key];
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
          ? m.insights_note_partial_read_through({
              time: moment(data.dataThrough, timeZone),
            })
          : m.insights_note_partial_history();
    else if (current)
      note =
        bucket === 'day'
          ? m.insights_note_today()
          : m.insights_note_this_week();

    return {
      key: point.key,
      label,
      axisLabel: point.start
        ? shortDay(point.start)
        : (known?.label ?? point.key),
      values: point.values,
      unknown:
        point.coverage === 'not_imported'
          ? m.insights_note_not_imported()
          : undefined,
      note,
      color: known?.color,
    };
  });
}

/** The series to draw: the definition's order and labels, limited to the server's series. */
export function chartSeries(data: InsightChartResponse) {
  return definitions[data.chart]
    .series()
    .filter((s) => data.series.includes(s.id));
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

/** How each source's state reads and which operational state it shows. */
export const sourceStates = {
  complete: { label: m.insights_source_state_complete, state: 'verified' },
  limited: { label: m.insights_source_state_limited, state: 'waiting' },
  importing: { label: m.insights_source_state_importing, state: 'running' },
  stale: { label: m.insights_source_state_stale, state: 'attention' },
  failing: { label: m.insights_source_state_failing, state: 'error' },
  paused: { label: m.insights_source_state_paused, state: 'attention' },
  disconnected: {
    label: m.insights_source_state_disconnected,
    state: 'error',
  },
  not_synced: { label: m.insights_source_state_not_synced, state: 'waiting' },
} satisfies Record<
  InsightSource['state'],
  { label: () => string; state: OperationalState }
>;

/** A badge for the chart's overall coverage; unavailable never reads as an empty chart. */
export function coverageBadge(data: InsightChartResponse): {
  label: string;
  tone: 'neutral' | 'warning' | 'danger' | 'success';
} {
  switch (data.coverage.state) {
    case 'complete':
      return { label: m.insights_coverage_complete(), tone: 'success' };
    case 'stale':
      return { label: m.insights_coverage_stale(), tone: 'warning' };
    case 'partial':
      return { label: m.insights_coverage_partial(), tone: 'warning' };
    default:
      return data.chart === 'stock'
        ? { label: m.insights_coverage_no_rules(), tone: 'warning' }
        : { label: m.insights_coverage_no_source(), tone: 'danger' };
  }
}

/** Explains what one source contributes, such as "Limited history · history from 2 Aug". */
export function sourceDetail(source: InsightSource, timeZone: string) {
  const parts = [sourceStates[source.state].label()];
  if (source.historyFrom)
    parts.push(
      m.insights_source_history_from({
        date: formatDate(source.historyFrom, {
          month: 'short',
          day: 'numeric',
          timeZone: 'UTC',
        }),
      }),
    );
  if (source.state === 'not_synced')
    parts.push(m.insights_source_not_synced_detail());
  else if (source.dataThrough)
    parts.push(
      m.insights_source_read_through({
        time: moment(source.dataThrough, timeZone),
      }),
    );

  return parts.join(' · ');
}

const excludedMessages: Record<string, (inputs: { count: number }) => string> =
  {
    no_placed_time: m.insights_excluded_no_placed_time,
    no_detection_time: m.insights_excluded_no_detection_time,
    other_class: m.insights_excluded_other_class,
  };

/** Sentences about records in scope that the chart can't place. */
export function excludedText(data: InsightChartResponse) {
  return data.coverage.excluded.map((item) =>
    (excludedMessages[item.reason] ?? m.insights_excluded_other)({
      count: item.count,
    }),
  );
}

/** States how current the counts are, or why that is unknown. */
export function dataThroughText(data: InsightChartResponse, timeZone: string) {
  if (data.chart === 'cases' || data.chart === 'procurement')
    return m.insights_data_through_luma({ time: moment(data.asOf, timeZone) });
  if (data.chart === 'stock')
    return !data.total
      ? m.insights_data_through_no_positions()
      : data.dataThrough
        ? m.insights_data_through_positions({
            time: moment(data.dataThrough, timeZone),
          })
        : m.insights_data_through_positions_missing();
  if (data.dataThrough)
    return m.insights_data_through_time({
      time: moment(data.dataThrough, timeZone),
    });

  return data.coverage.sources.length
    ? m.insights_data_through_unknown()
    : m.insights_data_through_no_source();
}

/** Names the records a selection opens, such as "Orders · Open · Mon 21 Sept". */
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
  const series = definition.series().find((s) => s.id === selection.series);
  const noun = definition.records();
  const what =
    series && data.series.length > 1 ? `${noun} · ${series.label}` : noun;

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

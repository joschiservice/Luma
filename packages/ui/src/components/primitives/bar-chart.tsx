import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useId,
  useRef,
  useState,
} from 'react';

import { cn } from '../../lib/utils';

/**
 * Mark colors. `chart-1` to `chart-5` are categorical slots; assign them to series in this
 * order. State colors mean good or bad and always come with a text label. `muted` marks
 * unknown or unclassified values.
 */
export type ChartColor =
  | 'chart-1'
  | 'chart-2'
  | 'chart-3'
  | 'chart-4'
  | 'chart-5'
  | 'muted'
  | 'success'
  | 'approval'
  | 'warning'
  | 'error';

export interface ChartSeries {
  id: string;
  label: string;
  color: ChartColor;
}

export interface ChartCategory {
  key: string;
  /** The full name, used in the tooltip and the spoken label, such as "Mon 21 Sep". */
  label: string;
  /** A short axis label, such as "21". Defaults to `label`. */
  axisLabel?: string;
  values: Record<string, number>;
  /**
   * Why this category's value is unknown, such as "Not imported". No bars are drawn; the
   * category shows a hatched band so it never reads as zero.
   */
  unknown?: string | undefined;
  /** A caveat, such as "Incomplete: data through 14:05". Marked below the axis. */
  note?: string | undefined;
  /** Overrides the series color for single-series breakdowns, such as states. */
  color?: ChartColor | undefined;
}

export interface ChartSelection {
  category: string;
  series?: string | undefined;
}

/** Rounds a maximum up to a readable axis: 1, 2 or 5 times a power of ten per step. */
export function chartTicks(max: number, count = 4) {
  if (max <= 0) return [0, 1];
  const rough = max / count;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step =
    [1, 2, 5, 10].map((m) => m * power).find((s) => s >= rough) ?? power * 10;
  const ticks: number[] = [];
  for (let value = 0; value < max + step; value += step) ticks.push(value);

  return ticks.at(-1)! < max ? [...ticks, ticks.at(-1)! + step] : ticks;
}

function total(category: ChartCategory, series: ChartSeries[]) {
  return series.reduce((sum, s) => sum + (category.values[s.id] ?? 0), 0);
}

const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/** Describes a category for screen readers: its total, each nonzero series and caveats. */
function spoken(
  category: ChartCategory,
  series: ChartSeries[],
  unit: (value: number) => string,
) {
  if (category.unknown)
    return m.ui_chart_category_value({
      category: category.label,
      value: sentence(category.unknown),
    });
  const parts = series
    .filter((s) => category.values[s.id])
    .map((s) =>
      m.ui_chart_series_value({
        series: s.label,
        value: formatNumber(category.values[s.id]!),
      }),
    );

  return [
    m.ui_chart_category_value({
      category: category.label,
      value: unit(total(category, series)),
    }),
    ...(parts.length > 1 ? [parts.join(', ')] : []),
    ...(category.note ? [category.note] : []),
  ]
    .map(sentence)
    .join(' ');
}

function Tooltip({
  category,
  series,
  unit,
  selectable,
}: {
  category: ChartCategory;
  series: ChartSeries[];
  unit: (value: number) => string;
  selectable: boolean;
}) {
  return (
    <>
      <p className="lu-chart-tooltip-title">{category.label}</p>
      {category.unknown ? (
        <p className="lu-chart-tooltip-note">{category.unknown}</p>
      ) : (
        <>
          <p className="lu-chart-tooltip-total">
            {unit(total(category, series))}
          </p>
          {series.length > 1 && (
            <ul>
              {series.map((s) => (
                <li key={s.id}>
                  <span
                    className="lu-chart-key"
                    data-shape="line"
                    data-color={category.color ?? s.color}
                  />
                  <strong>{formatNumber(category.values[s.id] ?? 0)}</strong>
                  <span>{s.label}</span>
                </li>
              ))}
            </ul>
          )}
          {category.note && (
            <p className="lu-chart-tooltip-note">{category.note}</p>
          )}
        </>
      )}
      {selectable && (
        <p className="lu-chart-tooltip-hint">{m.ui_chart_select_hint()}</p>
      )}
    </>
  );
}

/**
 * A stacked bar chart whose categories open their records. Vertical charts suit calendar
 * buckets; horizontal charts suit named categories with long labels and show each total at
 * the bar's end. The chart is one tab stop: arrow keys, Home and End move between categories,
 * and Enter selects the whole category. A pointer selects the category, or the segment of one
 * series when it lands on one. The tooltip repeats every series and caveat; pair the chart
 * with a table of the same values so nothing depends on hovering.
 */
export function BarChart({
  label,
  orientation = 'vertical',
  series,
  categories,
  unit = formatNumber,
  selected,
  onSelect,
  busy = false,
  className,
}: {
  /** Names the chart for assistive technology, such as "Orders placed per day". */
  label: string;
  orientation?: 'vertical' | 'horizontal';
  /** Series in stacking order, from the baseline outward. */
  series: ChartSeries[];
  categories: ChartCategory[];
  /** Formats a value with its unit, such as "12 orders". */
  unit?: (value: number) => string;
  selected?: ChartSelection | null | undefined;
  onSelect?: ((selection: ChartSelection) => void) | undefined;
  /** Keeps the previous values visible but dimmed while new ones load. */
  busy?: boolean;
  className?: string;
}) {
  const id = useId();
  const [active, setActive] = useState(0);
  const [shown, setShown] = useState<number | null>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const max = Math.max(0, ...categories.map((c) => total(c, series)));
  const ticks = chartTicks(max);
  const scale = ticks.at(-1)!;
  const vertical = orientation === 'vertical';
  const [width, setWidth] = useState(640);
  const measure = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(entry?.contentRect.width ?? 640),
    );
    observer.observe(element);

    return () => observer.disconnect();
  }, []);
  // Label every nth axis tick, counted back from the latest, leaving about 64px per label.
  const every = vertical
    ? Math.max(
        1,
        Math.ceil(categories.length / Math.max(2, Math.floor(width / 64))),
      )
    : 1;
  const focusIndex = Math.min(active, Math.max(0, categories.length - 1));
  const notes = categories.some((c) => c.note && !c.unknown);
  const unknown = categories.some((c) => c.unknown);

  function move(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = {
      [vertical ? 'ArrowRight' : 'ArrowDown']: index + 1,
      [vertical ? 'ArrowLeft' : 'ArrowUp']: index - 1,
      Home: 0,
      End: categories.length - 1,
    }[event.key];
    if (next === undefined) {
      if (event.key === 'Escape') setShown(null);

      return;
    }
    event.preventDefault();
    const target = Math.max(0, Math.min(categories.length - 1, next));
    setActive(target);
    setShown(target);
    buttons.current[target]?.focus();
  }

  function select(event: MouseEvent<HTMLButtonElement>, category: string) {
    const segment = (event.target as HTMLElement).closest<HTMLElement>(
      '[data-series]',
    );
    onSelect?.({
      category,
      // A keyboard activation has no pointer position, so it selects the whole category.
      series: event.detail > 0 ? segment?.dataset.series : undefined,
    });
  }

  function segments(category: ChartCategory) {
    const sum = total(category, series);

    return series.map((s, index) => {
      const value = category.values[s.id] ?? 0;
      if (!value) return null;
      const last = series.slice(index + 1).every((n) => !category.values[n.id]);

      return (
        <span
          key={s.id}
          className="lu-chart-segment"
          data-series={s.id}
          data-color={category.color ?? s.color}
          data-end={last ? '' : undefined}
          data-selected={
            selected?.category === category.key && selected.series === s.id
              ? ''
              : undefined
          }
          style={{
            [vertical ? 'height' : 'width']: `${(value / sum) * 100}%`,
          }}
        />
      );
    });
  }

  const tooltip = shown !== null && categories[shown] && (
    <div
      className="lu-chart-tooltip"
      aria-hidden="true"
      data-side={shown >= categories.length / 2 ? 'before' : 'after'}
      style={
        vertical
          ? { left: `${((shown + 0.5) / categories.length) * 100}%` }
          : { top: `${((shown + 1) / categories.length) * 100}%` }
      }
    >
      <Tooltip
        category={categories[shown]}
        series={series}
        unit={unit}
        selectable={!!onSelect}
      />
    </div>
  );

  return (
    <div
      className={cn('lu-chart', className)}
      data-orientation={orientation}
      data-busy={busy ? '' : undefined}
      aria-busy={busy || undefined}
    >
      <div
        role="group"
        aria-roledescription="chart"
        aria-label={label}
        className="lu-chart-frame"
        onPointerLeave={() => setShown(null)}
      >
        {vertical && (
          <div className="lu-chart-y" aria-hidden="true">
            {[...ticks].reverse().map((tick) => (
              <span key={tick}>{formatNumber(tick)}</span>
            ))}
          </div>
        )}
        <div className="lu-chart-plot" ref={measure}>
          {vertical && (
            <div className="lu-chart-grid" aria-hidden="true">
              {ticks.map((tick) => (
                <span
                  key={tick}
                  style={{ bottom: `${(tick / scale) * 100}%` }}
                />
              ))}
            </div>
          )}
          <div className="lu-chart-categories">
            {categories.map((category, index) => {
              const sum = total(category, series);
              const isSelected =
                selected?.category === category.key && !selected.series;

              return (
                <button
                  key={category.key}
                  ref={(element) => {
                    buttons.current[index] = element;
                  }}
                  type="button"
                  className="lu-chart-category"
                  tabIndex={index === focusIndex ? 0 : -1}
                  aria-label={spoken(category, series, unit)}
                  aria-pressed={
                    selected ? selected.category === category.key : undefined
                  }
                  aria-describedby={`${id}-hint`}
                  data-selected={isSelected ? '' : undefined}
                  data-unknown={category.unknown ? '' : undefined}
                  onClick={(event) => select(event, category.key)}
                  onKeyDown={(event) => move(event, index)}
                  onFocus={() => {
                    setActive(index);
                    setShown(index);
                  }}
                  onBlur={() => setShown(null)}
                  onPointerEnter={() => setShown(index)}
                >
                  {!vertical && (
                    <span className="lu-chart-row-label">{category.label}</span>
                  )}
                  <span className="lu-chart-track">
                    {category.unknown ? (
                      <span className="lu-chart-unknown" />
                    ) : (
                      <span
                        className="lu-chart-stack"
                        style={{
                          [vertical ? 'height' : 'width']:
                            `${(sum / scale) * 100}%`,
                        }}
                      >
                        {segments(category)}
                      </span>
                    )}
                    {!vertical && (
                      <span className="lu-chart-row-value">
                        {category.unknown
                          ? m.common_empty_value()
                          : formatNumber(sum)}
                      </span>
                    )}
                  </span>
                  {vertical && (
                    <span className="lu-chart-x">
                      <span>
                        {(categories.length - 1 - index) % every === 0
                          ? (category.axisLabel ?? category.label)
                          : ''}
                      </span>
                      {category.note && !category.unknown && (
                        <span className="lu-chart-note-mark" />
                      )}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {tooltip}
        </div>
      </div>
      <p id={`${id}-hint`} className="sr-only">
        {onSelect
          ? m.ui_chart_keyboard_select_hint()
          : m.ui_chart_keyboard_hint()}
      </p>
      {(notes || unknown) && (
        <ul className="lu-chart-caveats" aria-hidden="true">
          {notes && (
            <li>
              <span className="lu-chart-note-mark" />
              {m.ui_chart_incomplete_period()}
            </li>
          )}
          {unknown && (
            <li>
              <span className="lu-chart-key" data-shape="hatch" />
              {m.ui_chart_unknown_not_zero()}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/**
 * Names each series with a swatch that mirrors its mark. Pass `onSelect` to let each entry
 * open the records of its whole series. Use it whenever a chart has two or more series.
 */
export function ChartLegend({
  series,
  totals,
  onSelect,
  selected,
  className,
}: {
  series: ChartSeries[];
  /** Optional totals shown after each label. */
  totals?: Record<string, number> | undefined;
  onSelect?: ((series: string) => void) | undefined;
  selected?: string | undefined;
  className?: string;
}) {
  const content = (s: ChartSeries): ReactNode => (
    <>
      <span className="lu-chart-key" data-color={s.color} />
      <span>{s.label}</span>
      {totals && (
        <span className="lu-chart-legend-total">
          {formatNumber(totals[s.id] ?? 0)}
        </span>
      )}
    </>
  );

  return (
    <ul className={cn('lu-chart-legend', className)}>
      {series.map((s) => (
        <li key={s.id}>
          {onSelect ? (
            <button
              type="button"
              aria-pressed={selected === s.id}
              onClick={() => onSelect(s.id)}
            >
              {content(s)}
            </button>
          ) : (
            content(s)
          )}
        </li>
      ))}
    </ul>
  );
}

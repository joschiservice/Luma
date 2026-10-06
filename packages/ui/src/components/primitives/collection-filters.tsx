import { Check, type LucideIcon } from 'lucide-react';
import {
  type ReactNode,
  type RefObject,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import {
  calendarPresets,
  type CalendarRange,
  calendarRangeError,
  describeCalendarRange,
} from '../../lib/date-range';
import { cn } from '../../lib/utils';
import { Button } from './button';
import { Disclosure } from './disclosure';
import { Input } from './input';

export interface CollectionFilterOption {
  value: string;
  label: string;
}

interface FilterBase {
  /** Unique within the collection. */
  key: string;
  /** The filter category, such as "Status". */
  label: string;
  icon?: LucideIcon | undefined;
}

/**
 * One filter a collection can present.
 *
 * - `choice` picks one option or Any. It is offered while it has options or a value.
 * - `date-range` picks an inclusive calendar range with presets ending `today`. With `fallback`
 *   it always applies: unset, it shows the fallback name and cannot be removed.
 * - `applied` is set elsewhere, such as from a link to one SKU. It shows as a removable chip
 *   while `value` is set and is never offered as a choice.
 */
export type CollectionFilter =
  | (FilterBase & {
      kind: 'choice';
      value: string | undefined;
      options: readonly CollectionFilterOption[];
      onChange: (value: string | undefined) => void;
    })
  | (FilterBase & {
      kind: 'date-range';
      from: string | undefined;
      to: string | undefined;
      /** Today's ISO calendar date in the workspace timezone. */
      today: string;
      /** The longest inclusive range the collection accepts. */
      maxDays?: number | undefined;
      /** Names the range applied when none is chosen, such as "Last 30 days". */
      fallback?: string | undefined;
      onChange: (range: CalendarRange) => void;
    })
  | (FilterBase & {
      kind: 'applied';
      value: string | undefined;
      onRemove: () => void;
    });

/** Whether the filter narrows the collection beyond its defaults. */
export function filterApplied(filter: CollectionFilter) {
  if (filter.kind === 'date-range') return !!(filter.from || filter.to);

  return filter.value !== undefined;
}

/** Whether the reader can choose a value for the filter. Applied-only filters are never offered. */
export function filterOffered(filter: CollectionFilter) {
  if (filter.kind === 'choice')
    return filter.options.length > 0 || filterApplied(filter);

  return filter.kind === 'date-range';
}

/** The applied value as shown on a chip, or the fallback range while none is chosen. */
export function filterValueLabel(filter: CollectionFilter) {
  if (filter.kind === 'choice')
    return (
      filter.options.find((option) => option.value === filter.value)?.label ??
      filter.value ??
      ''
    );
  if (filter.kind === 'date-range')
    return filterApplied(filter)
      ? describeCalendarRange(filter, filter.today)
      : (filter.fallback ?? '');

  return filter.value ?? '';
}

/** Returns the filter to its default. */
export function clearFilter(filter: CollectionFilter) {
  if (filter.kind === 'choice') filter.onChange(undefined);
  else if (filter.kind === 'date-range') filter.onChange({});
  else filter.onRemove();
}

/**
 * Lists the values for one filter. Choosing a value applies it at once and calls `done`, which
 * closes a picker; inline layouts pass nothing and stay open. `inline` collapses the custom date
 * range so a column of filters stays scannable.
 */
export function FilterEditor({
  filter,
  done,
  inline = false,
}: {
  filter: CollectionFilter;
  done?: () => void;
  inline?: boolean;
}) {
  if (filter.kind === 'choice')
    return <ChoiceOptions filter={filter} done={done} inline={inline} />;
  if (filter.kind === 'date-range')
    return <DateRangeOptions filter={filter} done={done} inline={inline} />;

  return null;
}

/** Long option lists get a field that narrows them; inline lists tolerate a few more options. */
const searchableOptions = { picker: 8, inline: 12 };

function ChoiceOptions({
  filter,
  done,
  inline,
}: {
  filter: Extract<CollectionFilter, { kind: 'choice' }>;
  done: (() => void) | undefined;
  inline: boolean;
}) {
  const [query, setQuery] = useState('');
  const options = filter.options.filter((option) =>
    option.label.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const choose = (value: string | undefined) => {
    filter.onChange(value);
    done?.();
  };

  return (
    <div
      className="collection-filter-options"
      role="group"
      aria-label={`${filter.label} options`}
    >
      {filter.options.length >
      searchableOptions[inline ? 'inline' : 'picker'] ? (
        <Input
          type="search"
          aria-label={`Find ${filter.label.toLowerCase()}`}
          placeholder={`Find ${filter.label.toLowerCase()}…`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      ) : null}
      {query ? null : (
        <Option
          label="Any"
          active={filter.value === undefined}
          onClick={() => choose(undefined)}
        />
      )}
      {options.map((option) => (
        <Option
          key={option.value}
          label={option.label}
          active={filter.value === option.value}
          onClick={() => choose(option.value)}
        />
      ))}
      {!options.length ? (
        <p className="collection-filter-none">No matching options</p>
      ) : null}
    </div>
  );
}

function DateRangeOptions({
  filter,
  done,
  inline,
}: {
  filter: Extract<CollectionFilter, { kind: 'date-range' }>;
  done: (() => void) | undefined;
  inline: boolean;
}) {
  const [from, setFrom] = useState(filter.from ?? '');
  const [to, setTo] = useState(filter.to ?? '');
  const [error, setError] = useState<string>();
  const required = !!filter.fallback;
  const presets = calendarPresets(filter.today).filter(
    (preset) =>
      !filter.maxDays ||
      !calendarRangeError(preset, { maxDays: filter.maxDays }),
  );
  // The default range is offered first; a preset with the fallback's name stands in for it.
  const choices: { label: string; range: CalendarRange }[] = [
    ...(presets.some((preset) => preset.label === filter.fallback)
      ? []
      : [{ label: filter.fallback ?? 'Any time', range: {} }]),
    ...presets.map((preset) => ({
      label: preset.label,
      range:
        preset.label === filter.fallback
          ? {}
          : { from: preset.from, to: preset.to },
    })),
  ];
  const active = (range: CalendarRange) =>
    range.from === filter.from && range.to === filter.to;
  const custom =
    filterApplied(filter) && !choices.some((choice) => active(choice.range));
  const apply = (range: CalendarRange) => {
    filter.onChange(range);
    done?.();
  };
  const form = (
    <form
      className="collection-filter-custom"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const range = { from: from || undefined, to: to || undefined };
        const problem = calendarRangeError(range, {
          required,
          maxDays: filter.maxDays,
        });
        setError(problem);
        if (!problem) apply(range);
      }}
    >
      {inline ? null : (
        <p className="collection-filter-heading">Custom range</p>
      )}
      <label>
        <span>From</span>
        <Input
          type="date"
          value={from}
          max={to || filter.today}
          required={required}
          onChange={(event) => setFrom(event.target.value)}
        />
      </label>
      <label>
        <span>Through</span>
        <Input
          type="date"
          value={to}
          min={from || undefined}
          required={required}
          onChange={(event) => setTo(event.target.value)}
        />
      </label>
      {error ? (
        <p className="collection-filter-error" role="alert">
          {error}
        </p>
      ) : null}
      <Button type="submit" variant="outline" size="sm">
        Apply range
      </Button>
    </form>
  );

  return (
    <div className="collection-filter-dates">
      <div
        className="collection-filter-options"
        role="group"
        aria-label={`${filter.label} presets`}
      >
        {choices.map((choice) => (
          <Option
            key={choice.label}
            label={choice.label}
            active={active(choice.range)}
            onClick={() => apply(choice.range)}
          />
        ))}
      </div>
      {inline ? (
        <Disclosure
          variant="plain"
          className="collection-filter-custom-toggle"
          open={custom}
        >
          <summary>
            Custom range
            {custom ? `: ${describeCalendarRange(filter, filter.today)}` : ''}
          </summary>
          {form}
        </Disclosure>
      ) : (
        form
      )}
    </div>
  );
}

function Option({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Button variant="ghost" aria-pressed={active} onClick={onClick}>
      <span className="truncate">{label}</span>
      {active ? <Check aria-hidden="true" /> : null}
    </Button>
  );
}

/** Every offered filter with its values listed under a heading, for a sheet or a docked panel. */
export function FilterFields({
  filters,
  className,
}: {
  filters: readonly CollectionFilter[];
  className?: string;
}) {
  return (
    <div className={cn('collection-filter-fields', className)}>
      {filters.filter(filterOffered).map((filter) => (
        <FilterSection key={filter.key} filter={filter} />
      ))}
    </div>
  );
}

function FilterSection({ filter }: { filter: CollectionFilter }) {
  const id = useId();
  const Icon = filter.icon;

  return (
    <section className="collection-filter-section" aria-labelledby={id}>
      <h3 id={id} className="collection-filter-section-heading">
        {Icon ? <Icon aria-hidden="true" /> : null}
        {filter.label}
      </h3>
      <FilterEditor filter={filter} inline />
    </section>
  );
}

/**
 * Lays a collection out beside a docked panel that lists every filter and its values, so one
 * click applies a value. The panel shows on wide screens only; below that the toolbar inside
 * `children` must be rendered with `panel` so it offers the same filters as pills. Reserve the
 * panel for feeds with five or more filters that are combined to investigate; tables and split
 * views keep the toolbar pills.
 */
export function CollectionFilterPanel({
  filters,
  children,
}: {
  filters: readonly CollectionFilter[];
  children: ReactNode;
}) {
  const id = useId();

  return (
    <div className="collection-panel-layout">
      <aside className="collection-filter-panel" aria-labelledby={id}>
        <h2 id={id} className="collection-filter-panel-title">
          Filters
        </h2>
        <FilterFields filters={filters} />
      </aside>
      <div className="collection-panel-main">{children}</div>
    </div>
  );
}

/** Moves focus to the first control when a picker opens. */
export function FocusFirst({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusFirst(ref);

  return (
    <div className={className} ref={ref}>
      {children}
    </div>
  );
}

function useFocusFirst(ref: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const focus = () =>
      ref.current?.querySelector<HTMLElement>('input, button')?.focus();
    focus();
    const frame = requestAnimationFrame(focus);

    return () => cancelAnimationFrame(frame);
  }, [ref]);
}

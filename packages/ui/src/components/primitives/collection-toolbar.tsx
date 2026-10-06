import {
  ArrowDownUp,
  ArrowLeft,
  Check,
  ChevronRight,
  ListFilter,
  type LucideIcon,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import {
  type ReactNode,
  type RefObject,
  useEffect,
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
import { Badge } from './badge';
import { Button } from './button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './dropdown-menu';
import { Input } from './input';
import { ResponsivePopover } from './responsive-popover';

export interface CollectionFilterOption {
  value: string;
  label: string;
}

interface FilterBase {
  /** Unique within the toolbar. */
  key: string;
  /** The filter category, such as "Status". */
  label: string;
  icon?: LucideIcon | undefined;
}

/**
 * One filter the toolbar can present.
 *
 * - `choice` picks one option. It can be added from the filter menu while unset.
 * - `date-range` picks an inclusive calendar range with presets ending `today`. With `fallback`
 *   it always applies: the chip shows the fallback name and cannot be removed.
 * - `applied` is set elsewhere, such as from a link to one SKU. It shows as a removable chip
 *   while `value` is set and is never offered in the filter menu.
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

/** Free-text search committed to the caller after typing pauses, or at once on Enter. */
export interface CollectionSearch {
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  /** The accessible name, such as "Search orders". */
  label: string;
  placeholder: string;
  maxLength?: number | undefined;
}

/** A sort order, optionally with a direction the reader can flip. */
export interface CollectionSort {
  value: string;
  options: readonly CollectionFilterOption[];
  onChange: (value: string) => void;
  direction?: 'asc' | 'desc' | undefined;
  onDirectionChange?: ((direction: 'asc' | 'desc') => void) | undefined;
}

export interface CollectionView<Value extends string> {
  value: Value;
  label: string;
  /** Explains what the view includes; shown on hover. */
  description?: string | undefined;
  icon?: ReactNode;
  count?: number | undefined;
  /** Highlights the count when the view holds work that needs attention. */
  attention?: boolean | undefined;
}

/** Switches between a collection's saved views. Each view is a toggle button with an optional count. */
export function CollectionViews<Value extends string>({
  label,
  value,
  views,
  onChange,
}: {
  label: string;
  value: Value;
  views: readonly CollectionView<Value>[];
  onChange: (value: Value) => void;
}) {
  return (
    <div className="collection-views" role="group" aria-label={label}>
      {views.map((view) => (
        <Button
          key={view.value}
          variant="ghost"
          aria-pressed={view.value === value}
          title={view.description}
          onClick={() => onChange(view.value)}
        >
          {view.icon}
          {view.label}
          {view.count !== undefined ? (
            <Badge tone={view.attention && view.count ? 'warning' : 'neutral'}>
              {view.count}
            </Badge>
          ) : null}
        </Button>
      ))}
    </div>
  );
}

const searchDelay = 300;

function applied(filter: CollectionFilter) {
  if (filter.kind === 'date-range') return !!(filter.from || filter.to);

  return filter.value !== undefined;
}

function shown(filter: CollectionFilter) {
  return applied(filter) || (filter.kind === 'date-range' && !!filter.fallback);
}

function addable(filter: CollectionFilter) {
  if (shown(filter)) return false;
  if (filter.kind === 'choice') return filter.options.length > 0;

  return filter.kind === 'date-range';
}

function valueLabel(filter: CollectionFilter) {
  if (filter.kind === 'choice')
    return (
      filter.options.find((option) => option.value === filter.value)?.label ??
      filter.value ??
      ''
    );
  if (filter.kind === 'date-range')
    return applied(filter)
      ? describeCalendarRange(filter, filter.today)
      : (filter.fallback ?? '');

  return filter.value ?? '';
}

function clear(filter: CollectionFilter) {
  if (filter.kind === 'choice') filter.onChange(undefined);
  else if (filter.kind === 'date-range') filter.onChange({});
  else filter.onRemove();
}

/**
 * Lays out a collection's controls in the shared order: views and Refresh; then search, filter
 * chips with an Add filter menu, page actions and sort. Without views, Refresh ends the second
 * row. Applied filters are always visible as chips; choosing a chip edits it and its remove
 * button clears it. The toolbar owns no filter state: every change is reported to the caller,
 * which owns the URL and fetching.
 */
export function CollectionToolbar({
  className,
  views,
  search,
  filters = [],
  sort,
  actions,
  onClear,
  onRefresh,
  refreshing = false,
  refreshLabel = 'Refresh',
}: {
  className?: string;
  views?: ReactNode;
  search?: CollectionSearch | undefined;
  filters?: readonly CollectionFilter[];
  sort?: CollectionSort | undefined;
  /** Display controls for the collection, such as grouping. */
  actions?: ReactNode;
  /** Clears search and every removable filter; shown while any is applied. */
  onClear?: (() => void) | undefined;
  onRefresh: () => void;
  refreshing?: boolean | undefined;
  refreshLabel?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const chips = filters.filter(shown);
  const available = filters.filter(addable);
  const addingFilter = available.find((filter) => filter.key === adding);
  const clearable = !!search?.value || filters.some(applied);

  const refresh = (
    <Button
      variant="ghost"
      className="collection-toolbar-refresh"
      aria-label={refreshLabel}
      title={refreshLabel}
      disabled={refreshing}
      onClick={onRefresh}
    >
      <RefreshCw
        aria-hidden="true"
        className={refreshing ? 'animate-spin motion-reduce:animate-none' : ''}
      />
      Refresh
    </Button>
  );

  // After a chip disappears, focus moves to the filter menu, or to search when every filter is set.
  function restoreFocus() {
    requestAnimationFrame(() => {
      const find = (selector: string) =>
        root.current?.querySelector<HTMLElement>(selector);
      (
        find('.collection-filter-add') ??
        find('.collection-toolbar-search input')
      )?.focus();
    });
  }

  return (
    <div className={cn('collection-toolbar', className)} ref={root}>
      {views ? (
        <div className="collection-toolbar-views">
          {views}
          {refresh}
        </div>
      ) : null}
      <div className="collection-toolbar-controls">
        {search ? <SearchField {...search} /> : null}
        {chips.length || available.length || clearable ? (
          <div
            className="collection-toolbar-filters"
            role="group"
            aria-label="Filters"
          >
            {chips.map((filter) => (
              <FilterChip
                key={filter.key}
                filter={filter}
                open={open === filter.key}
                onOpenChange={(next) => setOpen(next ? filter.key : null)}
                onRemove={() => {
                  clear(filter);
                  restoreFocus();
                }}
              />
            ))}
            {available.length ? (
              <ResponsivePopover
                title={addingFilter?.label ?? 'Add filter'}
                open={open === 'add'}
                onOpenChange={(next) => {
                  setOpen(next ? 'add' : null);
                  if (next) setAdding(null);
                }}
                trigger={
                  <Button variant="ghost" className="collection-filter-add">
                    <ListFilter aria-hidden="true" />
                    {chips.length ? 'Add filter' : 'Filter'}
                  </Button>
                }
              >
                {addingFilter ? (
                  <>
                    <Button
                      variant="ghost"
                      className="collection-filter-back"
                      onClick={() => setAdding(null)}
                    >
                      <ArrowLeft aria-hidden="true" /> All filters
                    </Button>
                    <FilterEditor
                      filter={addingFilter}
                      done={() => {
                        setOpen(null);
                        restoreFocus();
                      }}
                    />
                  </>
                ) : (
                  <FocusFirst className="collection-filter-options">
                    {available.map((filter) => {
                      const Icon = filter.icon;

                      return (
                        <Button
                          key={filter.key}
                          variant="ghost"
                          onClick={() => setAdding(filter.key)}
                        >
                          <span className="collection-filter-category">
                            {Icon ? <Icon aria-hidden="true" /> : null}
                            {filter.label}
                          </span>
                          <ChevronRight aria-hidden="true" />
                        </Button>
                      );
                    })}
                  </FocusFirst>
                )}
              </ResponsivePopover>
            ) : null}
            {clearable && onClear ? (
              <Button
                variant="ghost"
                className="collection-filter-clear"
                onClick={() => {
                  onClear();
                  restoreFocus();
                }}
              >
                Clear
              </Button>
            ) : null}
          </div>
        ) : null}
        {actions || sort || !views ? (
          <div className="collection-toolbar-display">
            {actions}
            {sort ? <SortMenu sort={sort} /> : null}
            {views ? null : refresh}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SearchField({
  value,
  onChange,
  label,
  placeholder,
  maxLength = 120,
}: CollectionSearch) {
  const [draft, setDraft] = useState(value ?? '');
  const [shownValue, setShownValue] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // A pending commit must use the caller's latest handler, which merges the latest filters.
  const latest = useRef(onChange);
  useEffect(() => {
    latest.current = onChange;
  });
  // Links, history and Clear can change the search while the toolbar stays mounted.
  if (shownValue !== value) {
    setShownValue(value);
    setDraft(value ?? '');
  }
  useEffect(() => () => clearTimeout(timer.current), []);

  function commit(next: string) {
    clearTimeout(timer.current);
    const trimmed = next.trim() || undefined;
    if (trimmed !== (value?.trim() || undefined)) latest.current(trimmed);
  }

  return (
    <form
      className="collection-toolbar-search"
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        commit(draft);
      }}
    >
      <Search aria-hidden="true" />
      <Input
        type="search"
        aria-label={label}
        placeholder={placeholder}
        maxLength={maxLength}
        value={draft}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => commit(next), searchDelay);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && draft) {
            event.preventDefault();
            setDraft('');
            commit('');
          }
        }}
      />
    </form>
  );
}

function FilterChip({
  filter,
  open,
  onOpenChange,
  onRemove,
}: {
  filter: CollectionFilter;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRemove: () => void;
}) {
  const value = valueLabel(filter);
  const content = (
    <>
      <span className="collection-filter-label">{filter.label}:</span> {value}
    </>
  );

  return (
    <div className="collection-filter-chip" data-kind={filter.kind}>
      {filter.kind === 'applied' ? (
        <span className="collection-filter-static">{content}</span>
      ) : (
        <ResponsivePopover
          title={filter.label}
          open={open}
          onOpenChange={onOpenChange}
          trigger={
            <Button
              variant="ghost"
              aria-label={`Edit ${filter.label} filter: ${value}`}
            >
              {content}
            </Button>
          }
        >
          <FilterEditor filter={filter} done={() => onOpenChange(false)} />
        </ResponsivePopover>
      )}
      {applied(filter) ? (
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Remove ${filter.label} filter: ${value}`}
          onClick={onRemove}
        >
          <X aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}

function FilterEditor({
  filter,
  done,
}: {
  filter: CollectionFilter;
  done: () => void;
}) {
  if (filter.kind === 'choice')
    return <ChoiceOptions filter={filter} done={done} />;
  if (filter.kind === 'date-range')
    return <DateRangeForm filter={filter} done={done} />;

  return null;
}

/** Long option lists get a filter field so the reader can narrow them by typing. */
const searchableOptions = 8;

function ChoiceOptions({
  filter,
  done,
}: {
  filter: Extract<CollectionFilter, { kind: 'choice' }>;
  done: () => void;
}) {
  const [query, setQuery] = useState('');
  const options = filter.options.filter((option) =>
    option.label.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <FocusFirst
      className="collection-filter-options"
      aria-label={`${filter.label} options`}
    >
      {filter.options.length > searchableOptions ? (
        <Input
          type="search"
          aria-label={`Find ${filter.label.toLowerCase()}`}
          placeholder={`Find ${filter.label.toLowerCase()}…`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      ) : null}
      {options.map((option) => (
        <Button
          key={option.value}
          variant="ghost"
          aria-pressed={filter.value === option.value}
          onClick={() => {
            filter.onChange(option.value);
            done();
          }}
        >
          <span className="truncate">{option.label}</span>
          {filter.value === option.value ? <Check aria-hidden="true" /> : null}
        </Button>
      ))}
      {!options.length ? (
        <p className="collection-filter-none">No matching options</p>
      ) : null}
    </FocusFirst>
  );
}

function DateRangeForm({
  filter,
  done,
}: {
  filter: Extract<CollectionFilter, { kind: 'date-range' }>;
  done: () => void;
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
  const apply = (range: CalendarRange) => {
    filter.onChange(range);
    done();
  };

  return (
    <FocusFirst className="collection-filter-dates">
      <div
        className="collection-filter-options"
        aria-label={`${filter.label} presets`}
      >
        {presets.map((preset) => {
          const active = preset.from === filter.from && preset.to === filter.to;

          return (
            <Button
              key={preset.label}
              variant="ghost"
              aria-pressed={active}
              onClick={() => apply({ from: preset.from, to: preset.to })}
            >
              {preset.label}
              {active ? <Check aria-hidden="true" /> : null}
            </Button>
          );
        })}
      </div>
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
        <p className="collection-filter-heading">Custom range</p>
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
    </FocusFirst>
  );
}

function SortMenu({ sort }: { sort: CollectionSort }) {
  const label =
    sort.options.find((option) => option.value === sort.value)?.label ??
    sort.value;
  const direction = sort.direction ?? 'desc';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            className="collection-toolbar-sort"
            aria-label={`Sort: ${label}${sort.onDirectionChange ? `, ${direction === 'desc' ? 'descending' : 'ascending'}` : ''}`}
          />
        }
      >
        <ArrowDownUp aria-hidden="true" />
        {label}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Sort by</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={sort.value}
            onValueChange={(value: string) => sort.onChange(value)}
          >
            {sort.options.map((option) => (
              <DropdownMenuRadioItem
                key={option.value}
                value={option.value}
                closeOnClick
              >
                {option.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        {sort.onDirectionChange ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Order</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={direction}
                onValueChange={(value: 'asc' | 'desc') =>
                  sort.onDirectionChange?.(value)
                }
              >
                <DropdownMenuRadioItem value="desc" closeOnClick>
                  Newest or highest first
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="asc" closeOnClick>
                  Oldest or lowest first
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Moves focus to the first control when a picker step opens. */
function FocusFirst({
  className,
  children,
  'aria-label': ariaLabel,
}: {
  className: string;
  children: ReactNode;
  'aria-label'?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusFirst(ref);

  return (
    <div className={className} ref={ref} aria-label={ariaLabel}>
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

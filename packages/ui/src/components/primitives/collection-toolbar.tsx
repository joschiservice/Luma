import {
  ArrowDownUp,
  ListFilter,
  Plus,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { cn } from '../../lib/utils';
import { Badge } from './badge';
import { Button } from './button';
import {
  clearFilter,
  type CollectionFilter,
  type CollectionFilterOption,
  filterApplied,
  FilterEditor,
  FilterFields,
  filterOffered,
  filterValueLabel,
  FocusFirst,
} from './collection-filters';
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

export type {
  CollectionFilter,
  CollectionFilterOption,
} from './collection-filters';

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

/** A chip shows the applied value; a fallback date range always applies and is shown too. */
function chipped(filter: CollectionFilter) {
  return (
    filterApplied(filter) || (filter.kind === 'date-range' && !!filter.fallback)
  );
}

/**
 * Lays out a collection's controls in the shared order: views and Refresh; then search, one pill
 * per filter, page actions and sort. Without views, Refresh ends the second row. Every offered
 * filter is visible: unset filters are quiet pills that open their values in one click, applied
 * filters are chips that edit the value and remove it. On small screens unset pills give way to
 * one Filters button that lists every filter in a sheet. With `panel`, the collection sits in a
 * `CollectionFilterPanel`; on wide screens the toolbar then shows only applied chips. The toolbar
 * owns no filter state: every change is reported to the caller, which owns the URL and fetching.
 */
export function CollectionToolbar({
  className,
  views,
  search,
  filters = [],
  sort,
  actions,
  panel = false,
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
  /** The filters are also listed in a docked `CollectionFilterPanel`. */
  panel?: boolean;
  /** Clears search and every removable filter; shown while any is applied. */
  onClear?: (() => void) | undefined;
  onRefresh: () => void;
  refreshing?: boolean | undefined;
  refreshLabel?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<string | null>(null);
  const offered = filters.filter(filterOffered);
  const shown = filters.filter(
    (filter) => chipped(filter) || filterOffered(filter),
  );
  const appliedCount = filters.filter(filterApplied).length;
  const clearable = !!search?.value || appliedCount > 0;
  const openChange = (key: string) => (next: boolean) =>
    setOpen(next ? key : null);

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

  // After a change removes the focused control, focus the filter's pill when it is visible, else
  // the Filters button, the first pill or search, whichever this layout shows.
  function restoreFocus(key?: string) {
    requestAnimationFrame(() => {
      const selectors = [
        key ? `[data-filter="${CSS.escape(key)}"] > [data-slot='button']` : '',
        '.collection-filter-sheet-trigger',
        ".collection-filter-pill > [data-slot='button']",
        '.collection-toolbar-search input',
      ].filter(Boolean);
      for (const selector of selectors)
        for (const element of root.current?.querySelectorAll<HTMLElement>(
          selector,
        ) ?? [])
          if (element.getClientRects().length) return element.focus();
    });
  }

  return (
    <div
      className={cn('collection-toolbar', className)}
      data-panel={panel || undefined}
      ref={root}
    >
      {views ? (
        <div className="collection-toolbar-views">
          {views}
          {refresh}
        </div>
      ) : null}
      <div className="collection-toolbar-controls">
        {search ? <SearchField {...search} /> : null}
        {shown.length || clearable ? (
          <div
            className="collection-toolbar-filters"
            role="group"
            aria-label="Filters"
          >
            {shown.map((filter) =>
              chipped(filter) ? (
                <FilterChip
                  key={filter.key}
                  filter={filter}
                  open={open === filter.key}
                  onOpenChange={openChange(filter.key)}
                  onRemove={() => {
                    clearFilter(filter);
                    restoreFocus(filter.key);
                  }}
                />
              ) : (
                <FilterPill
                  key={filter.key}
                  filter={filter}
                  open={open === filter.key}
                  onOpenChange={openChange(filter.key)}
                  done={() => {
                    setOpen(null);
                    restoreFocus(filter.key);
                  }}
                />
              ),
            )}
            {offered.length ? (
              <ResponsivePopover
                title="Filters"
                open={open === 'sheet'}
                onOpenChange={openChange('sheet')}
                trigger={
                  <Button
                    variant="ghost"
                    className="collection-filter-sheet-trigger"
                    aria-label={
                      appliedCount
                        ? `Filters, ${appliedCount} applied`
                        : 'Filters'
                    }
                  >
                    <ListFilter aria-hidden="true" />
                    Filters
                    {appliedCount ? <Badge>{appliedCount}</Badge> : null}
                  </Button>
                }
              >
                <FocusFirst>
                  <FilterFields filters={offered} />
                </FocusFirst>
                <Button
                  className="collection-filter-sheet-done"
                  onClick={() => setOpen(null)}
                >
                  Done
                </Button>
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

/** An unset filter: one click lists its values. */
function FilterPill({
  filter,
  open,
  onOpenChange,
  done,
}: {
  filter: CollectionFilter;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  done: () => void;
}) {
  return (
    <div className="collection-filter-pill" data-filter={filter.key}>
      <ResponsivePopover
        title={filter.label}
        open={open}
        onOpenChange={onOpenChange}
        trigger={
          <Button variant="ghost" aria-label={`Add ${filter.label} filter`}>
            <Plus aria-hidden="true" />
            {filter.label}
          </Button>
        }
      >
        <FocusFirst>
          <FilterEditor filter={filter} done={done} />
        </FocusFirst>
      </ResponsivePopover>
    </div>
  );
}

/** An applied filter: the value edits it and the remove button returns it to its default. */
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
  const value = filterValueLabel(filter);
  const content = (
    <>
      <span className="collection-filter-label">{filter.label}:</span> {value}
    </>
  );

  return (
    <div
      className="collection-filter-chip"
      data-kind={filter.kind}
      data-filter={filter.key}
    >
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
          <FocusFirst>
            <FilterEditor filter={filter} done={() => onOpenChange(false)} />
          </FocusFirst>
        </ResponsivePopover>
      )}
      {filterApplied(filter) ? (
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

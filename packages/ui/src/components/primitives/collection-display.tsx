import {
  type Announcements,
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { m } from '@luma/i18n/messages';
import { GripVertical, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useId, useState } from 'react';

import { Badge } from './badge';
import { Button } from './button';
import { Checkbox } from './checkbox';
import { FocusFirst } from './collection-filters';
import { Input } from './input';
import { LiveRegion } from './live-region';
import { ResponsivePopover } from './responsive-popover';
import { Select } from './select';

/** Where a column's value comes from: a connected source, Luma itself, or derived from both. */
type DisplayOrigin = 'source' | 'luma' | 'derived';

/** A column people can show, hide and reorder. */
export interface DisplayColumn {
  key: string;
  label: string;
  /** One short line on what the column shows. */
  description?: string | undefined;
  /** Area the column is listed under while hidden, such as "Payment". */
  group?: string | undefined;
  origin?: DisplayOrigin | undefined;
  /** Why the column cannot be shown, such as an archived field or a missing permission. */
  unavailable?: string | undefined;
  /** Always shown, such as the column that names each row. */
  required?: boolean | undefined;
}

export type DisplayDensity = 'comfortable' | 'compact';

export type DisplayLayout = 'table' | 'list' | 'board';

type DisplayGranularity = 'day' | 'week' | 'month';

export interface DisplayGrouping {
  field: string;
  /** Required for date fields, which group by period. */
  granularity?: DisplayGranularity | undefined;
  showEmpty: boolean;
}

/** A field rows can be grouped by; date fields list the periods they support. */
interface DisplayGroupField {
  value: string;
  label: string;
  granularities?: readonly DisplayGranularity[] | undefined;
}

export interface CollectionDisplayProps {
  /**
   * Shown columns in order; changes report the new order of shown keys. `properties` names them
   * as the properties of list rows rather than table columns.
   */
  columns?:
    | {
        options: readonly DisplayColumn[];
        shown: readonly string[];
        onChange: (shown: string[]) => void;
        kind?: 'columns' | 'properties' | undefined;
      }
    | undefined;
  density?:
    | { value: DisplayDensity; onChange: (density: DisplayDensity) => void }
    | undefined;
  /** Shown only when more than one layout is offered. Board needs a grouping. */
  layout?:
    | {
        value: DisplayLayout;
        options: readonly DisplayLayout[];
        onChange: (layout: DisplayLayout) => void;
      }
    | undefined;
  grouping?:
    | {
        value: DisplayGrouping | null;
        fields: readonly DisplayGroupField[];
        onChange: (grouping: DisplayGrouping | null) => void;
      }
    | undefined;
  /** Whether Space and clicks open records in a preview beside the table or list. */
  preview?:
    { value: boolean; onChange: (preview: boolean) => void } | undefined;
  /** Returns to the saved view's display; offered while `modified`. */
  onReset?: (() => void) | undefined;
  modified?: boolean | undefined;
}

const none = '__none';

/**
 * Opens the collection's display options from the toolbar: which columns or properties show and
 * in which order, density, layout, the preview pane and grouping. Columns are reordered by dragging their handle or with
 * the arrow keys on the handle (Alt+arrow keys on the checkbox); hidden columns are listed by
 * area, and unavailable ones stay listed, disabled, with their reason. On small screens it opens
 * as a sheet. Every change is reported through the callbacks; nothing is stored here.
 */
export function CollectionDisplay({
  columns,
  density,
  layout,
  grouping,
  preview,
  onReset,
  modified = false,
}: CollectionDisplayProps) {
  const [open, setOpen] = useState(false);

  return (
    <ResponsivePopover
      title={m.ui_display_title()}
      open={open}
      onOpenChange={setOpen}
      size="wide"
      align="end"
      trigger={
        <Button variant="ghost" className="collection-display-trigger">
          <SlidersHorizontal aria-hidden="true" />
          {m.ui_display_label()}
        </Button>
      }
    >
      <FocusFirst className="collection-display">
        {layout && layout.options.length > 1 ? (
          <LayoutChoice layout={layout} grouped={!!grouping?.value} />
        ) : null}
        {density ? (
          <Segmented
            label={m.ui_display_density()}
            value={density.value}
            options={[
              {
                value: 'comfortable',
                label: m.ui_display_density_comfortable(),
              },
              { value: 'compact', label: m.ui_display_density_compact() },
            ]}
            onChange={density.onChange}
          />
        ) : null}
        {preview ? <PreviewChoice preview={preview} /> : null}
        {grouping && grouping.fields.length ? (
          <GroupingChoice grouping={grouping} />
        ) : null}
        {columns ? <ColumnChoice columns={columns} /> : null}
        {onReset && modified ? (
          <Button
            variant="outline"
            size="sm"
            className="collection-display-reset"
            onClick={onReset}
          >
            <RotateCcw aria-hidden="true" />
            {m.ui_display_reset()}
          </Button>
        ) : null}
      </FocusFirst>
    </ResponsivePopover>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();

  return (
    <section className="collection-display-section" aria-labelledby={id}>
      <h3 id={id} className="collection-display-heading">
        {label}
      </h3>
      {children}
    </section>
  );
}

/** Mutually exclusive choices as native radio buttons, so arrow keys move between them. */
function Segmented<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: Value;
  options: readonly {
    value: Value;
    label: string;
    disabled?: boolean;
    hint?: string | undefined;
  }[];
  onChange: (value: Value) => void;
}) {
  const id = useId();
  const hints = options.filter((option) => option.disabled && option.hint);

  return (
    <fieldset className="collection-display-section">
      <legend className="collection-display-heading">{label}</legend>
      <div className="collection-display-segments">
        {options.map((option) => (
          <label
            key={option.value}
            className="collection-display-segment"
            data-disabled={option.disabled ? '' : undefined}
          >
            <input
              type="radio"
              name={id}
              className="sr-only"
              value={option.value}
              checked={value === option.value}
              disabled={option.disabled}
              aria-describedby={
                option.disabled && option.hint
                  ? `${id}-${option.value}`
                  : undefined
              }
              onChange={() => onChange(option.value)}
            />
            {option.label}
          </label>
        ))}
      </div>
      {hints.map((option) => (
        <p
          key={option.value}
          id={`${id}-${option.value}`}
          className="collection-display-hint"
        >
          {option.hint}
        </p>
      ))}
    </fieldset>
  );
}

function LayoutChoice({
  layout,
  grouped,
}: {
  layout: NonNullable<CollectionDisplayProps['layout']>;
  grouped: boolean;
}) {
  const labels: Record<DisplayLayout, () => string> = {
    table: m.ui_display_layout_table,
    list: m.ui_display_layout_list,
    board: m.ui_display_layout_board,
  };

  return (
    <Segmented
      label={m.ui_display_layout()}
      value={layout.value}
      options={layout.options.map((option) => ({
        value: option,
        label: labels[option](),
        disabled: option === 'board' && !grouped,
        hint:
          option === 'board'
            ? m.ui_display_layout_board_needs_group()
            : undefined,
      }))}
      onChange={layout.onChange}
    />
  );
}

function PreviewChoice({
  preview,
}: {
  preview: NonNullable<CollectionDisplayProps['preview']>;
}) {
  const id = useId();

  return (
    <Section label={m.ui_display_preview()}>
      <label className="collection-display-check" htmlFor={id}>
        <Checkbox
          id={id}
          checked={preview.value}
          aria-describedby={`${id}-hint`}
          onChange={(event) => preview.onChange(event.target.checked)}
        />
        {m.ui_display_preview_label()}
      </label>
      <p id={`${id}-hint`} className="collection-display-hint">
        {m.ui_display_preview_hint()}
      </p>
    </Section>
  );
}

function GroupingChoice({
  grouping,
}: {
  grouping: NonNullable<CollectionDisplayProps['grouping']>;
}) {
  const id = useId();
  const current = grouping.value;
  const field = grouping.fields.find((item) => item.value === current?.field);
  const periods = field?.granularities ?? [];
  const periodLabels: Record<DisplayGranularity, () => string> = {
    day: m.ui_display_granularity_day,
    week: m.ui_display_granularity_week,
    month: m.ui_display_granularity_month,
  };

  return (
    <Section label={m.ui_display_grouping()}>
      <div className="collection-display-grouping">
        <Select
          aria-label={m.ui_display_grouping()}
          options={[
            { value: none, label: m.ui_display_grouping_none() },
            ...grouping.fields.map((item) => ({
              value: item.value,
              label: item.label,
            })),
          ]}
          value={current?.field ?? none}
          onValueChange={(value: string | null) => {
            if (!value || value === none) return grouping.onChange(null);
            const next = grouping.fields.find((item) => item.value === value);
            const granularity =
              next?.granularities?.find(
                (period) => period === current?.granularity,
              ) ?? next?.granularities?.[0];
            grouping.onChange({
              field: value,
              showEmpty: current?.showEmpty ?? false,
              ...(granularity ? { granularity } : {}),
            });
          }}
        />
        {current && periods.length ? (
          <Select
            aria-label={m.ui_display_granularity()}
            options={periods.map((period) => ({
              value: period,
              label: periodLabels[period](),
            }))}
            value={current.granularity ?? periods[0] ?? 'day'}
            onValueChange={(granularity: DisplayGranularity | null) =>
              granularity && grouping.onChange({ ...current, granularity })
            }
          />
        ) : null}
      </div>
      {current ? (
        <label className="collection-display-check" htmlFor={id}>
          <Checkbox
            id={id}
            checked={current.showEmpty}
            onChange={(event) =>
              grouping.onChange({ ...current, showEmpty: event.target.checked })
            }
          />
          {m.ui_display_show_empty_groups()}
        </label>
      ) : null}
    </Section>
  );
}

function ColumnChoice({
  columns,
}: {
  columns: NonNullable<CollectionDisplayProps['columns']>;
}) {
  const hintId = useId();
  const [query, setQuery] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );
  const byKey = new Map(columns.options.map((column) => [column.key, column]));
  const shown = columns.shown.filter((key) => byKey.has(key));
  const term = query.trim().toLowerCase();
  const matches = (column: DisplayColumn) =>
    !term ||
    column.label.toLowerCase().includes(term) ||
    !!column.description?.toLowerCase().includes(term);
  const shownColumns = shown
    .map((key) => byKey.get(key))
    .filter((column): column is DisplayColumn => !!column && matches(column));
  const hidden = columns.options.filter(
    (column) => !shown.includes(column.key) && matches(column),
  );
  const groups = new Map<string, DisplayColumn[]>();
  for (const column of hidden) {
    const group = column.group ?? '';
    groups.set(group, [...(groups.get(group) ?? []), column]);
  }
  const label = (key: string) => byKey.get(key)?.label ?? key;
  const properties = columns.kind === 'properties';

  function move(key: string, to: number) {
    const from = shown.indexOf(key);
    if (from < 0 || to < 0 || to >= shown.length || to === from) return;
    columns.onChange(arrayMove(shown, from, to));
    setAnnouncement(
      m.ui_display_moved({
        column: label(key),
        position: to + 1,
        total: shown.length,
      }),
    );
  }

  function toggle(key: string, show: boolean) {
    columns.onChange(
      show ? [...shown, key] : shown.filter((item) => item !== key),
    );
  }

  const announcements: Announcements = {
    onDragStart: () => undefined,
    onDragOver: () => undefined,
    onDragEnd: ({ active, over }) =>
      over
        ? m.ui_display_moved({
            column: label(String(active.id)),
            position: shown.indexOf(String(over.id)) + 1,
            total: shown.length,
          })
        : undefined,
    onDragCancel: () => undefined,
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over) move(String(active.id), shown.indexOf(String(over.id)));
  };

  return (
    <Section
      label={properties ? m.ui_display_properties() : m.ui_display_columns()}
    >
      <Input
        type="search"
        aria-label={
          properties
            ? m.ui_display_property_search_label()
            : m.ui_display_search_label()
        }
        placeholder={
          properties
            ? m.ui_display_property_search_placeholder()
            : m.ui_display_search_placeholder()
        }
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <p id={hintId} className="collection-display-hint">
        {m.ui_display_move_hint()}
      </p>
      {shownColumns.length ? (
        <div role="group" aria-label={m.ui_display_shown()}>
          <p className="collection-display-subheading" aria-hidden="true">
            {m.ui_display_shown()}
          </p>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={onDragEnd}
            accessibility={{
              announcements,
              screenReaderInstructions: { draggable: m.ui_display_move_hint() },
            }}
          >
            <SortableContext
              items={shownColumns.map((column) => column.key)}
              strategy={verticalListSortingStrategy}
            >
              <ul className="collection-display-columns">
                {shownColumns.map((column) => (
                  <ShownColumn
                    key={column.key}
                    column={column}
                    reorderable={!term && shown.length > 1}
                    hintId={hintId}
                    onMove={(offset) =>
                      move(column.key, shown.indexOf(column.key) + offset)
                    }
                    onHide={() => toggle(column.key, false)}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        </div>
      ) : null}
      {[...groups].map(([group, items]) => (
        <div
          key={group}
          role="group"
          aria-label={
            group ? m.ui_display_hidden_group({ group }) : m.ui_display_hidden()
          }
        >
          <p className="collection-display-subheading" aria-hidden="true">
            {group || m.ui_display_hidden()}
          </p>
          <ul className="collection-display-columns">
            {items.map((column) => (
              <li key={column.key} className="collection-display-column">
                <ColumnToggle
                  column={column}
                  checked={false}
                  onChange={(show) => toggle(column.key, show)}
                />
              </li>
            ))}
          </ul>
        </div>
      ))}
      {!shownColumns.length && !hidden.length ? (
        <p className="collection-filter-none">
          {properties
            ? m.ui_display_property_no_matches()
            : m.ui_display_no_matches()}
        </p>
      ) : null}
      <LiveRegion message={announcement} />
    </Section>
  );
}

function ShownColumn({
  column,
  reorderable,
  hintId,
  onMove,
  onHide,
}: {
  column: DisplayColumn;
  reorderable: boolean;
  hintId: string;
  onMove: (offset: number) => void;
  onHide: () => void;
}) {
  const {
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: column.key, disabled: !reorderable });
  const arrows = (event: KeyboardEvent<HTMLElement>, alt: boolean) => {
    if (!reorderable || alt !== event.altKey) return;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const control = event.currentTarget;
    onMove(event.key === 'ArrowUp' ? -1 : 1);
    // Reordering can move the focused row in the document, which drops its focus.
    requestAnimationFrame(() => control.focus());
  };

  return (
    <li
      ref={setNodeRef}
      className="collection-display-column"
      data-dragging={isDragging ? '' : undefined}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
    >
      {reorderable ? (
        <button
          type="button"
          className="collection-display-handle"
          aria-label={m.ui_display_move({ column: column.label })}
          aria-describedby={hintId}
          ref={setActivatorNodeRef}
          {...listeners}
          onKeyDown={(event) => arrows(event, false)}
        >
          <GripVertical aria-hidden="true" />
        </button>
      ) : null}
      <ColumnToggle
        column={column}
        checked
        onChange={(show) => !show && onHide()}
        onKeyDown={(event) => arrows(event, true)}
      />
    </li>
  );
}

function ColumnToggle({
  column,
  checked,
  onChange,
  onKeyDown,
}: {
  column: DisplayColumn;
  checked: boolean;
  onChange: (checked: boolean) => void;
  onKeyDown?: ((event: KeyboardEvent<HTMLInputElement>) => void) | undefined;
}) {
  const id = useId();
  const origins: Record<DisplayOrigin, () => string> = {
    source: m.ui_display_origin_source,
    luma: m.ui_display_origin_luma,
    derived: m.ui_display_origin_derived,
  };
  // Shown columns stay removable even when they became unavailable.
  const locked = column.required || (!checked && !!column.unavailable);
  const note = column.required ? m.ui_display_required() : column.unavailable;
  // The label names the checkbox; description, reason and origin describe it.
  const described = [
    column.description ? `${id}-description` : '',
    note ? `${id}-note` : '',
    column.origin ? `${id}-origin` : '',
  ].filter(Boolean);

  return (
    <label
      className="collection-display-toggle"
      htmlFor={id}
      data-disabled={locked ? '' : undefined}
    >
      <Checkbox
        id={id}
        checked={checked}
        disabled={locked}
        aria-labelledby={`${id}-name`}
        aria-describedby={described.join(' ') || undefined}
        onChange={(event) => onChange(event.target.checked)}
        onKeyDown={onKeyDown}
      />
      <span className="collection-display-text">
        <span id={`${id}-name`} className="collection-display-name">
          {column.label}
        </span>
        {column.description ? (
          <span
            id={`${id}-description`}
            className="collection-display-description"
          >
            {column.description}
          </span>
        ) : null}
        {note ? (
          <span id={`${id}-note`} className="collection-display-description">
            {note}
          </span>
        ) : null}
      </span>
      {column.origin ? (
        <Badge
          id={`${id}-origin`}
          tone={column.origin === 'source' ? 'neutral' : 'info'}
        >
          {origins[column.origin]()}
        </Badge>
      ) : null}
    </label>
  );
}

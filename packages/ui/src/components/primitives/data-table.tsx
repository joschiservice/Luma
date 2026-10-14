import { mergeProps } from '@base-ui/react/merge-props';
import { useRender } from '@base-ui/react/use-render';
import { m } from '@luma/i18n/messages';
import {
  type ColumnDef,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  EyeOff,
  ListFilter,
  Pin,
  PinOff,
  RotateCcw,
} from 'lucide-react';
import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  clampColumnWidth,
  type DataTableColumnState,
  moveColumn,
  pinColumn,
  setColumnShown,
  setColumnWidth,
  shownColumns,
} from '../../lib/column-state';
import { useRowSelection } from '../../lib/row-selection';
import { cn } from '../../lib/utils';
import { Checkbox } from './checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './dropdown-menu';
import { SelectionAnnouncement } from './live-region';

export type { DataTableColumnState } from '../../lib/column-state';

export type SortDirection = 'asc' | 'desc';

export type DataTableSort<SortKey extends string = string> = {
  key: SortKey;
  direction: SortDirection;
};

export type DataTableColumn<Row, SortKey extends string = string> = {
  /** Identifies the column within the table. */
  key: string;
  header: ReactNode;
  cell: (row: Row) => ReactNode;
  /** Makes the header a sort control for this key. */
  sortKey?: SortKey;
  /** Right-aligns the column with tabular figures for quantities, amounts and counts. */
  numeric?: boolean;
  /** Hides the column below 760px so the primary columns keep their width. */
  hideOnNarrow?: boolean;
  /** Names the column in menus and resize handles when `header` is not plain text. */
  label?: string | undefined;
  /** Width in pixels before anyone resizes a configurable table's column. */
  width?: number | undefined;
  /** Keeps the column shown in a configurable table. The row header column always is. */
  required?: boolean | undefined;
  /** Offers "Filter by this column" in the column menu, through `onColumnFilter`. */
  filterable?: boolean | undefined;
};

/** Row selection through a checkbox column; the caller owns the selected row keys. */
export interface DataTableSelection<Row> {
  selected: readonly string[];
  onChange: (selected: string[]) => void;
  /** Names a row for its checkbox, such as the order number. */
  rowLabel: (row: Row) => string;
}

/** `comfortable` is the default spacing; `default` remains as its earlier name. */
export type DataTableDensity = 'default' | 'comfortable' | 'compact';

const ariaSort = { asc: 'ascending', desc: 'descending' } as const;

const rowLinkProps = {
  className: 'ui-data-table-row-link',
  'data-slot': 'data-table-row-link',
};

const selectColumn = '__select';
/** Keyboard resizing steps in pixels; Shift takes the larger step. */
const resizeStep = { small: 16, large: 64 };

/**
 * Opens the row's link when a click lands outside it. A pinned cell is the containing block for
 * the link's row-wide overlay, so configurable tables forward clicks themselves. Modifier keys
 * travel with the click, so a router link still opens a new tab.
 */
function openRowLink(event: ReactMouseEvent<HTMLTableRowElement>) {
  const target = event.target;
  if (
    !(target instanceof Element) ||
    target.closest('a, button, input, label, [role="separator"]') ||
    window.getSelection()?.toString()
  )
    return;
  event.currentTarget
    .querySelector('[data-slot="data-table-row-link"]')
    ?.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
      }),
    );
}

/** Tracks whether an element's content overflows its box, so it scrolls. */
function useScrollOverflow() {
  const [overflows, setOverflows] = useState(false);
  const ref = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    const measure = () =>
      setOverflows(
        element.scrollWidth > element.clientWidth ||
          element.scrollHeight > element.clientHeight,
      );
    // Measure during commit so the first paint already exposes a scrollable region.
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);

    return () => observer.disconnect();
  }, []);

  return [ref, overflows] as const;
}

function columnName<Row, SortKey extends string>(
  column: DataTableColumn<Row, SortKey>,
) {
  return (
    column.label ??
    (typeof column.header === 'string' ? column.header : column.key)
  );
}

function defaultWidth<Row, SortKey extends string>(
  column: DataTableColumn<Row, SortKey>,
) {
  return column.width ?? (column.numeric ? 120 : 180);
}

/**
 * Renders rows as an accessible table with a visually hidden caption. The `rowHeader` column
 * (the first column by default) labels each row for screen readers. Sortable columns render
 * header buttons that report the next sort through `onSortChange`: the active column flips its
 * direction and another column starts at `firstSortDirection`. A table wider or taller than its
 * container scrolls and becomes a focusable region, so keyboard users can scroll it. Renders
 * `empty` instead of the table when there are no rows. Rows are never sorted, filtered or paged
 * here; the caller passes the rows the server returned.
 *
 * Opt-in features:
 * - `columnState` with `onColumnStateChange` makes columns configurable: each header gets a menu
 *   (sort, filter, move, pin, hide, reset width) and a resize handle that works by drag and
 *   with the arrow keys; double-click or Enter resets the width. The header sticks while the
 *   table scrolls inside its frame, so give the table a maximum height through `className` when
 *   it should scroll within the page.
 * - `selection` adds a checkbox column with a page-wide checkbox; shift-click selects a range.
 *   Selection changes are announced politely.
 * - `focusedRowKey` highlights the row that `useListKeyboard` acts on.
 */
export function DataTable<Row, SortKey extends string = string>({
  caption,
  columns,
  rows,
  rowKey,
  rowHeader = columns[0]?.key,
  empty = null,
  sort,
  onSortChange,
  firstSortDirection = 'asc',
  density = 'default',
  variant = 'framed',
  className,
  columnState,
  onColumnStateChange,
  onColumnFilter,
  selection,
  focusedRowKey,
}: {
  caption: ReactNode;
  columns: DataTableColumn<Row, SortKey>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  rowHeader?: string | undefined;
  empty?: ReactNode;
  sort?: DataTableSort<SortKey> | undefined;
  onSortChange?: ((sort: DataTableSort<SortKey>) => void) | undefined;
  firstSortDirection?: SortDirection | undefined;
  /** Compact suits tables nested inside cards and inspectors. */
  density?: DataTableDensity | undefined;
  /** Plain drops the border when the surrounding surface already supplies one. */
  variant?: 'framed' | 'plain' | undefined;
  className?: string | undefined;
  /** Shown columns, their order, widths and pinned column. Makes columns configurable. */
  columnState?: DataTableColumnState | undefined;
  onColumnStateChange?: ((state: DataTableColumnState) => void) | undefined;
  /** Opens a filter for a `filterable` column, such as the toolbar's filter builder. */
  onColumnFilter?: ((key: string) => void) | undefined;
  selection?: DataTableSelection<Row> | undefined;
  /** The row keyboard navigation acts on; it is highlighted. */
  focusedRowKey?: string | undefined;
}) {
  const captionId = useId();
  const hintId = useId();
  const frameElement = useRef<HTMLDivElement | null>(null);
  const [measureFrame, overflows] = useScrollOverflow();
  const frame = useCallback(
    (element: HTMLDivElement | null) => {
      frameElement.current = element;

      return measureFrame(element);
    },
    [measureFrame],
  );
  const [resizing, setResizing] = useState<{ key: string; width: number }>();
  const drag = useRef<{ key: string; startX: number; startWidth: number }>(
    undefined,
  );
  const configurable = !!columnState && !!onColumnStateChange;
  const keys = columns.map((column) => column.key);
  const required = columns
    .filter((column) => column.required || column.key === rowHeader)
    .map((column) => column.key);
  const shown = columnState
    ? shownColumns(columnState, keys, required)
    : keys.map((key) => ({ key, width: undefined }));
  const shownKeys = shown.map((column) => column.key);
  const byKey = new Map(columns.map((column) => [column.key, column]));
  const rowKeys = rows.map(rowKey);
  const select = useRowSelection({
    keys: rowKeys,
    selected: selection?.selected ?? [],
    onChange: (next) => selection?.onChange(next),
  });

  const definitions: ColumnDef<Row>[] = [
    ...(selection ? [{ id: selectColumn, size: 44 }] : []),
    ...columns.map((column) => ({
      id: column.key,
      size: defaultWidth(column),
      minSize: 48,
      maxSize: 960,
    })),
  ];
  const sizing: Record<string, number> = {};
  for (const column of shown) {
    const definition = byKey.get(column.key);
    if (!definition) continue;
    sizing[column.key] =
      resizing?.key === column.key
        ? resizing.width
        : (column.width ?? defaultWidth(definition));
  }
  // The table model takes a mutable array; copying keeps the caller's rows untouched.
  const data = useMemo(() => [...rows], [rows]);
  // The model is rebuilt from controlled props on every render and its functions are never
  // memoized or passed to memoized children, so skipping compiler memoization is safe.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data,
    columns: definitions,
    getRowId: (row) => rowKey(row),
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    manualFiltering: true,
    manualPagination: true,
    enableRowSelection: !!selection,
    state: {
      columnOrder: [
        selectColumn,
        ...shownKeys,
        ...keys.filter((key) => !shownKeys.includes(key)),
      ],
      columnVisibility: Object.fromEntries(
        keys.map((key) => [key, shownKeys.includes(key)]),
      ),
      columnPinning: {
        left: [
          ...(selection && configurable ? [selectColumn] : []),
          ...(configurable && columnState.pinned ? [columnState.pinned] : []),
        ],
      },
      columnSizing: sizing,
      rowSelection: Object.fromEntries(
        (selection?.selected ?? []).map((key) => [key, true]),
      ),
    },
  });

  if (!rows.length) return <>{empty}</>;

  const update = (next: DataTableColumnState) => onColumnStateChange?.(next);
  const leafColumns = table.getVisibleLeafColumns();
  const widthOf = (id: string) =>
    id === selectColumn ? 44 : (sizing[id] ?? 180);
  const totalWidth = leafColumns.reduce(
    (sum, column) => sum + widthOf(column.id),
    0,
  );
  const stickyLeft = (id: string): CSSProperties | undefined => {
    if (!configurable || !table.getColumn(id)?.getIsPinned()) return undefined;
    let left = 0;
    for (const column of leafColumns) {
      if (column.id === id) break;
      left += widthOf(column.id);
    }

    return { left };
  };

  function focusMenu(key: string | undefined) {
    requestAnimationFrame(() => {
      const target = key
        ? frameElement.current?.querySelector<HTMLElement>(
            `[data-column-menu="${CSS.escape(key)}"]`,
          )
        : undefined;
      (target ?? frameElement.current)?.focus();
    });
  }

  function resizeKey(key: string, event: KeyboardEvent<HTMLDivElement>) {
    if (!columnState) return;
    const current = sizing[key] ?? 180;
    const step = event.shiftKey ? resizeStep.large : resizeStep.small;
    const width =
      event.key === 'ArrowLeft'
        ? current - step
        : event.key === 'ArrowRight'
          ? current + step
          : event.key === 'Enter'
            ? undefined
            : null;
    if (width === null) return;
    event.preventDefault();
    update(setColumnWidth(columnState, keys, key, width, required));
  }

  function resizeStart(key: string, event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const cell = event.currentTarget.closest('th');
    if (!cell) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startWidth = cell.getBoundingClientRect().width;
    drag.current = { key, startX: event.clientX, startWidth };
    setResizing({ key, width: clampColumnWidth(startWidth) });
  }

  function resizeMove(event: PointerEvent<HTMLDivElement>) {
    const active = drag.current;
    if (!active) return;
    setResizing({
      key: active.key,
      width: clampColumnWidth(
        active.startWidth + event.clientX - active.startX,
      ),
    });
  }

  function resizeEnd() {
    const active = drag.current;
    drag.current = undefined;
    if (active && resizing && columnState)
      update(
        setColumnWidth(columnState, keys, active.key, resizing.width, required),
      );
    setResizing(undefined);
  }

  const headers = table.getHeaderGroups()[0]?.headers ?? [];

  return (
    <div
      ref={frame}
      data-slot="data-table"
      data-variant={variant}
      data-configurable={configurable ? '' : undefined}
      className={cn('ui-data-table', className)}
      {...(overflows
        ? { role: 'region', tabIndex: 0, 'aria-labelledby': captionId }
        : {})}
    >
      <table
        data-density={density === 'comfortable' ? 'default' : density}
        style={
          configurable
            ? { width: `max(100%, ${totalWidth}px)`, tableLayout: 'fixed' }
            : undefined
        }
      >
        <caption id={captionId} className="sr-only">
          {caption}
        </caption>
        {configurable ? (
          <colgroup>
            {leafColumns.map((column) => (
              <col key={column.id} style={{ width: widthOf(column.id) }} />
            ))}
          </colgroup>
        ) : null}
        <thead>
          <tr>
            {headers.map((header) => {
              if (header.column.id === selectColumn)
                return (
                  <th
                    key={header.id}
                    scope="col"
                    data-select=""
                    data-pinned={stickyLeft(selectColumn) ? '' : undefined}
                    style={stickyLeft(selectColumn)}
                  >
                    <label className="ui-data-table-select">
                      <Checkbox
                        aria-label={m.ui_table_select_all()}
                        checked={select.allSelected}
                        indeterminate={select.someSelected}
                        onChange={() => select.toggleAll()}
                      />
                    </label>
                  </th>
                );
              const column = byKey.get(header.column.id);
              if (!column) return null;
              const active =
                column.sortKey !== undefined && sort?.key === column.sortKey;
              const position = shownKeys.indexOf(column.key);
              const name = columnName(column);
              const pinned = configurable && columnState.pinned === column.key;
              // Other columns never move in front of the pinned column.
              const first = configurable && columnState.pinned ? 1 : 0;
              const sortControl =
                column.sortKey !== undefined && onSortChange ? (
                  <button
                    type="button"
                    className="ui-data-table-sort"
                    onClick={() =>
                      onSortChange({
                        key: column.sortKey!,
                        direction: active
                          ? sort.direction === 'asc'
                            ? 'desc'
                            : 'asc'
                          : firstSortDirection,
                      })
                    }
                  >
                    {column.header}
                    {!active ? (
                      <ArrowUpDown aria-hidden="true" />
                    ) : sort.direction === 'asc' ? (
                      <ArrowUp aria-hidden="true" />
                    ) : (
                      <ArrowDown aria-hidden="true" />
                    )}
                  </button>
                ) : (
                  column.header
                );

              return (
                <th
                  key={header.id}
                  scope="col"
                  data-numeric={column.numeric ? '' : undefined}
                  data-narrow={column.hideOnNarrow ? 'hide' : undefined}
                  data-pinned={stickyLeft(column.key) ? '' : undefined}
                  style={stickyLeft(column.key)}
                  aria-sort={active ? ariaSort[sort.direction] : undefined}
                >
                  {configurable ? (
                    <div className="ui-data-table-header">
                      <span className="ui-data-table-header-label">
                        {sortControl}
                      </span>
                      <ColumnMenu
                        name={name}
                        columnKey={column.key}
                        sortable={
                          column.sortKey !== undefined && !!onSortChange
                        }
                        onSort={(direction) =>
                          column.sortKey !== undefined &&
                          onSortChange?.({ key: column.sortKey, direction })
                        }
                        onFilter={
                          column.filterable && onColumnFilter
                            ? () => onColumnFilter(column.key)
                            : undefined
                        }
                        canMoveLeft={!pinned && position > first}
                        canMoveRight={
                          !pinned && position < shownKeys.length - 1
                        }
                        onMove={(offset) =>
                          update(
                            moveColumn(
                              columnState,
                              keys,
                              column.key,
                              offset,
                              required,
                            ),
                          )
                        }
                        pinned={pinned}
                        onPin={(pin) =>
                          update(
                            pinColumn(
                              columnState,
                              keys,
                              pin ? column.key : undefined,
                              required,
                            ),
                          )
                        }
                        resized={shown[position]?.width !== undefined}
                        onResetWidth={() =>
                          update(
                            setColumnWidth(
                              columnState,
                              keys,
                              column.key,
                              undefined,
                              required,
                            ),
                          )
                        }
                        hideable={!required.includes(column.key)}
                        onHide={() => {
                          update(
                            setColumnShown(
                              columnState,
                              keys,
                              column.key,
                              false,
                              required,
                            ),
                          );
                          focusMenu(
                            shownKeys[position + 1] ?? shownKeys[position - 1],
                          );
                        }}
                      />
                      <div
                        role="separator"
                        aria-orientation="vertical"
                        aria-label={m.ui_table_resize_column({ column: name })}
                        aria-describedby={hintId}
                        aria-valuemin={48}
                        aria-valuemax={960}
                        aria-valuenow={sizing[column.key]}
                        tabIndex={0}
                        className="ui-data-table-resize"
                        data-resizing={
                          resizing?.key === column.key ? '' : undefined
                        }
                        onKeyDown={(event) => resizeKey(column.key, event)}
                        onPointerDown={(event) =>
                          resizeStart(column.key, event)
                        }
                        onPointerMove={resizeMove}
                        onPointerUp={resizeEnd}
                        onPointerCancel={resizeEnd}
                        onDoubleClick={() =>
                          update(
                            setColumnWidth(
                              columnState,
                              keys,
                              column.key,
                              undefined,
                              required,
                            ),
                          )
                        }
                      />
                    </div>
                  ) : (
                    sortControl
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr
              key={row.id}
              data-list-row=""
              data-focused={row.id === focusedRowKey ? '' : undefined}
              data-selected={row.getIsSelected() ? '' : undefined}
              onClick={configurable ? openRowLink : undefined}
            >
              {row.getVisibleCells().map((cell) => {
                if (cell.column.id === selectColumn)
                  return (
                    <td
                      key={cell.id}
                      data-select=""
                      data-pinned={stickyLeft(selectColumn) ? '' : undefined}
                      style={stickyLeft(selectColumn)}
                    >
                      <label className="ui-data-table-select">
                        <Checkbox
                          aria-label={m.ui_table_select_row({
                            row: selection?.rowLabel(row.original) ?? row.id,
                          })}
                          checked={row.getIsSelected()}
                          // The change comes from a click, which carries Shift for a range.
                          onChange={(event) =>
                            select.toggle(
                              row.index,
                              event.nativeEvent instanceof MouseEvent &&
                                event.nativeEvent.shiftKey,
                            )
                          }
                        />
                      </label>
                    </td>
                  );
                const column = byKey.get(cell.column.id);
                if (!column) return null;
                const Cell = column.key === rowHeader ? 'th' : 'td';

                return (
                  <Cell
                    key={cell.id}
                    scope={Cell === 'th' ? 'row' : undefined}
                    data-numeric={column.numeric ? '' : undefined}
                    data-narrow={column.hideOnNarrow ? 'hide' : undefined}
                    data-pinned={stickyLeft(column.key) ? '' : undefined}
                    style={stickyLeft(column.key)}
                  >
                    {column.cell(row.original)}
                  </Cell>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {configurable ? (
        <p id={hintId} hidden>
          {m.ui_table_resize_hint()}
        </p>
      ) : null}
      {selection ? (
        <SelectionAnnouncement count={selection.selected.length} />
      ) : null}
    </div>
  );
}

/** The menu behind a configurable column's header: sort, filter, move, pin, width and hide. */
function ColumnMenu({
  name,
  columnKey,
  sortable,
  onSort,
  onFilter,
  canMoveLeft,
  canMoveRight,
  onMove,
  pinned,
  onPin,
  resized,
  onResetWidth,
  hideable,
  onHide,
}: {
  name: string;
  columnKey: string;
  sortable: boolean;
  onSort: (direction: SortDirection) => void;
  onFilter: (() => void) | undefined;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  onMove: (offset: number) => void;
  pinned: boolean;
  onPin: (pin: boolean) => void;
  resized: boolean;
  onResetWidth: () => void;
  hideable: boolean;
  onHide: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="ui-data-table-menu"
        data-column-menu={columnKey}
        aria-label={m.ui_table_column_menu({ column: name })}
      >
        <ChevronDown aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto min-w-48">
        {sortable || onFilter ? (
          <>
            <DropdownMenuGroup>
              {sortable ? (
                <>
                  <DropdownMenuItem onClick={() => onSort('asc')}>
                    <ArrowUp aria-hidden="true" />
                    {m.ui_table_sort_ascending()}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onSort('desc')}>
                    <ArrowDown aria-hidden="true" />
                    {m.ui_table_sort_descending()}
                  </DropdownMenuItem>
                </>
              ) : null}
              {onFilter ? (
                <DropdownMenuItem onClick={onFilter}>
                  <ListFilter aria-hidden="true" />
                  {m.ui_table_filter_column()}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuGroup>
          <DropdownMenuItem
            disabled={!canMoveLeft}
            closeOnClick={false}
            onClick={() => onMove(-1)}
          >
            <ArrowLeft aria-hidden="true" />
            {m.ui_table_move_left()}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!canMoveRight}
            closeOnClick={false}
            onClick={() => onMove(1)}
          >
            <ArrowRight aria-hidden="true" />
            {m.ui_table_move_right()}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onPin(!pinned)}>
            {pinned ? (
              <PinOff aria-hidden="true" />
            ) : (
              <Pin aria-hidden="true" />
            )}
            {pinned ? m.ui_table_unpin_column() : m.ui_table_pin_column()}
          </DropdownMenuItem>
          {resized ? (
            <DropdownMenuItem onClick={onResetWidth}>
              <RotateCcw aria-hidden="true" />
              {m.ui_table_reset_width()}
            </DropdownMenuItem>
          ) : null}
          {hideable ? (
            <DropdownMenuItem onClick={onHide}>
              <EyeOff aria-hidden="true" />
              {m.ui_table_hide_column()}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Links a table row to its record. Place it in one cell per row, usually the row header; the
 * link then covers the whole row while other links and buttons in the row stay clickable. Use
 * `render` to supply a router link.
 */
export function DataTableRowLink({
  render,
  ref,
  ...props
}: useRender.ComponentProps<'a'>) {
  return useRender({
    defaultTagName: 'a',
    render,
    ref,
    props: mergeProps<'a'>(rowLinkProps, props),
  });
}

import { mergeProps } from '@base-ui/react/merge-props';
import { useRender } from '@base-ui/react/use-render';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { type ReactNode, useCallback, useId, useState } from 'react';

import { cn } from '../../lib/utils';

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
};

const ariaSort = { asc: 'ascending', desc: 'descending' } as const;

const rowLinkProps = {
  className: 'ui-data-table-row-link',
  'data-slot': 'data-table-row-link',
};

/** Tracks whether an element's content is wider than its box, so it scrolls horizontally. */
function useHorizontalOverflow() {
  const [overflows, setOverflows] = useState(false);
  const ref = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    const measure = () =>
      setOverflows(element.scrollWidth > element.clientWidth);
    // Measure during commit so the first paint already exposes a scrollable region.
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);

    return () => observer.disconnect();
  }, []);

  return [ref, overflows] as const;
}

/**
 * Renders rows as an accessible table with a visually hidden caption. The `rowHeader` column
 * (the first column by default) labels each row for screen readers. Sortable columns render
 * header buttons that report the next sort through `onSortChange`: the active column flips its
 * direction and another column starts at `firstSortDirection`. A table wider than its container
 * scrolls horizontally and becomes a focusable region, so keyboard users can scroll it. Renders
 * `empty` instead of the table when there are no rows.
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
  density?: 'default' | 'compact' | undefined;
  /** Plain drops the border when the surrounding surface already supplies one. */
  variant?: 'framed' | 'plain' | undefined;
  className?: string | undefined;
}) {
  const captionId = useId();
  const [frame, overflows] = useHorizontalOverflow();
  if (!rows.length) return <>{empty}</>;

  return (
    <div
      ref={frame}
      data-slot="data-table"
      data-variant={variant}
      className={cn('ui-data-table', className)}
      {...(overflows
        ? { role: 'region', tabIndex: 0, 'aria-labelledby': captionId }
        : {})}
    >
      <table data-density={density}>
        <caption id={captionId} className="sr-only">
          {caption}
        </caption>
        <thead>
          <tr>
            {columns.map((column) => {
              const active =
                column.sortKey !== undefined && sort?.key === column.sortKey;

              return (
                <th
                  key={column.key}
                  scope="col"
                  data-numeric={column.numeric ? '' : undefined}
                  data-narrow={column.hideOnNarrow ? 'hide' : undefined}
                  aria-sort={active ? ariaSort[sort.direction] : undefined}
                >
                  {column.sortKey !== undefined && onSortChange ? (
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
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) => {
                const Cell = column.key === rowHeader ? 'th' : 'td';

                return (
                  <Cell
                    key={column.key}
                    scope={Cell === 'th' ? 'row' : undefined}
                    data-numeric={column.numeric ? '' : undefined}
                    data-narrow={column.hideOnNarrow ? 'hide' : undefined}
                  >
                    {column.cell(row)}
                  </Cell>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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

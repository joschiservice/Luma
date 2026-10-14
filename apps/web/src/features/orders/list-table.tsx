import './orders.css';

import {
  type CollectionDensity,
  collectionField,
  type OrderListItem,
  ordersCatalog,
} from '@luma/api-contract';
import {
  DataTable,
  type DataTableColumn,
  type DataTableColumnState,
  DataTableRowLink,
  type DataTableSelection,
  type DataTableSort,
} from '@luma/ui/components/primitives/data-table';
import type { ReactElement, ReactNode } from 'react';

import { orderLabel } from '../../shared/orders/presentation';
import { ordersPresentation } from './collection';
import { orderField, OrderFlags } from './fields';

/** Table columns by catalog column ID; the Display menu offers the same IDs. */
const layout: Readonly<
  Record<string, { numeric?: true; hideOnNarrow?: true; width?: number }>
> = {
  number: { width: 220 },
  placed: { hideOnNarrow: true },
  updated: { hideOnNarrow: true },
  due: { hideOnNarrow: true },
  status: {},
  paymentStatus: { hideOnNarrow: true },
  fulfillment: {},
  total: { numeric: true },
  lineCount: { numeric: true, hideOnNarrow: true },
  sources: { hideOnNarrow: true, width: 220 },
  comparison: { hideOnNarrow: true },
  overdue: { hideOnNarrow: true },
  channel: { hideOnNarrow: true },
  tags: { hideOnNarrow: true, width: 220 },
  test: { hideOnNarrow: true },
};

/** The condition field behind a column: the Sources column filters by source. */
export function orderColumnField(key: string) {
  return key === 'sources' ? 'source' : key;
}

function orderColumns(
  link: (order: OrderListItem) => ReactElement,
): DataTableColumn<OrderListItem>[] {
  return Object.entries(layout).map(([key, options]) => {
    const field = collectionField(ordersCatalog, key);
    const filter = collectionField(ordersCatalog, orderColumnField(key));

    return {
      key,
      header: ordersPresentation[key]?.label() ?? key,
      ...options,
      ...(field?.sort ? { sortKey: key } : {}),
      filterable: !!filter?.filter,
      cell:
        key === 'number'
          ? (order: OrderListItem) => (
              <>
                <DataTableRowLink render={link(order)}>
                  {orderLabel(order)}
                </DataTableRowLink>
                <small>
                  {[
                    ...new Set(order.sources.map((source) => source.label)),
                  ].join(' · ')}
                </small>
                <OrderFlags order={order} />
              </>
            )
          : (order: OrderListItem) => orderField(order, key),
    };
  });
}

/**
 * Lists orders as a table whose columns are Orders catalog fields; the order number labels each
 * row and carries its attention flags. Pass `columnState` to make columns configurable, or
 * `columns` for a fixed placement such as a customer's order history. Sorting reports the
 * catalog field; the caller owns sort state and starts from the first page.
 */
export function OrdersTable({
  caption,
  items,
  link,
  empty,
  sort,
  onSortChange,
  columns,
  columnState,
  onColumnStateChange,
  onColumnFilter,
  density = 'comfortable',
  focusedRowKey,
  selection,
  extraColumns = [],
}: {
  caption: string;
  items: readonly OrderListItem[];
  /** The order's link, such as a router `<Link>` without children. */
  link: (order: OrderListItem) => ReactElement;
  empty: ReactNode;
  sort?: DataTableSort | undefined;
  onSortChange?: ((sort: DataTableSort) => void) | undefined;
  /** Fixed columns in order, for placements without the Display menu. */
  columns?: readonly string[] | undefined;
  columnState?: DataTableColumnState | undefined;
  onColumnStateChange?: ((state: DataTableColumnState) => void) | undefined;
  onColumnFilter?: ((key: string) => void) | undefined;
  density?: CollectionDensity | undefined;
  focusedRowKey?: string | undefined;
  selection?: DataTableSelection<OrderListItem> | undefined;
  /** Columns beyond the catalog's, such as custom fields, keyed by their column ID. */
  extraColumns?: readonly DataTableColumn<OrderListItem>[] | undefined;
}) {
  const all = [...orderColumns(link), ...extraColumns];
  const shown = columns
    ? columns.flatMap((key) => all.filter((column) => column.key === key))
    : all;

  return (
    <DataTable
      caption={caption}
      columns={shown}
      rows={items}
      rowKey={(order) => order.id}
      rowHeader="number"
      empty={empty}
      sort={sort}
      onSortChange={onSortChange}
      firstSortDirection="desc"
      columnState={columnState}
      onColumnStateChange={onColumnStateChange}
      onColumnFilter={onColumnFilter}
      density={density}
      focusedRowKey={focusedRowKey}
      selection={selection}
    />
  );
}

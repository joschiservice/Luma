import './fulfillment.css';

import {
  type CollectionDensity,
  collectionField,
  fulfillmentCatalog,
  type FulfillmentItem,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
import {
  DataTable,
  type DataTableColumn,
  type DataTableColumnState,
  DataTableRowLink,
  type DataTableSelection,
  type DataTableSort,
} from '@luma/ui/components/primitives/data-table';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import type { ReactElement, ReactNode } from 'react';

import { fulfillmentPresentation } from './collection';
import {
  fulfillmentField,
  type FulfillmentFieldContext,
  FulfillmentFlags,
  sourceLabel,
} from './fields';
import {
  fulfillmentReason,
  kindLabels,
  orderLabel,
  quantity,
} from './presentation';

/** Table columns by catalog column ID; the Display menu offers the same IDs. */
const layout: Readonly<
  Record<string, { numeric?: true; hideOnNarrow?: true; width?: number }>
> = {
  order: { width: 240 },
  status: {},
  signals: { width: 260 },
  location: { hideOnNarrow: true },
  progress: { hideOnNarrow: true },
  kind: { hideOnNarrow: true },
  source: { hideOnNarrow: true },
  holds: { hideOnNarrow: true },
  method: { hideOnNarrow: true },
  carrier: { hideOnNarrow: true },
  stage: { hideOnNarrow: true },
  delivery: { hideOnNarrow: true },
  fulfillAt: { hideOnNarrow: true },
  fulfillBy: { hideOnNarrow: true },
  estimatedDelivery: { hideOnNarrow: true },
  orderPlaced: { hideOnNarrow: true },
  units: { numeric: true, hideOnNarrow: true },
  updated: { hideOnNarrow: true },
};

/** Columns sorted by another field: the order by its number, progress by the wait. */
const sortKeys: Readonly<Record<string, string>> = {
  order: 'orderNumber',
  progress: 'waiting',
};

/** The sort a column's header applies, if any. */
function fulfillmentColumnSort(key: string) {
  const sort = sortKeys[key] ?? key;

  return collectionField(fulfillmentCatalog, sort)?.sort ? sort : undefined;
}

/** Shows when the fulfillment last moved and the date it is measured against. */
function ProgressCell({
  item,
  context,
}: {
  item: FulfillmentItem;
  context: FulfillmentFieldContext;
}) {
  return (
    <span className="fulfillment-cell">
      <span>{fulfillmentField(item, 'progress', context)}</span>
      {item.open && item.fulfillBy ? (
        <small>
          {rich(m.fulfillment_progress_fulfill_by, {
            date: <WorkspaceDate value={item.fulfillBy} />,
          })}
        </small>
      ) : item.status === 'shipped' && item.estimatedDeliveryAt ? (
        <small>
          {rich(m.fulfillment_progress_expected, {
            date: <WorkspaceDate value={item.estimatedDeliveryAt} />,
          })}
        </small>
      ) : null}
    </span>
  );
}

function fulfillmentColumns(
  link: (item: FulfillmentItem) => ReactElement,
  context: FulfillmentFieldContext,
): DataTableColumn<FulfillmentItem>[] {
  return Object.entries(layout).map(([key, options]) => {
    const filter = collectionField(fulfillmentCatalog, key);
    const sortKey = fulfillmentColumnSort(key);
    const cell =
      key === 'order'
        ? (item: FulfillmentItem) => (
            <span className="fulfillment-cell">
              <DataTableRowLink render={link(item)}>
                {orderLabel(item)}
              </DataTableRowLink>
              <FulfillmentFlags item={item} />
              <small>
                {m.fulfillment_row_context({
                  kind: kindLabels[item.kind],
                  source: sourceLabel(item, context.sources),
                })}{' '}
                · {quantity(item.units, item.unit)}
              </small>
            </span>
          )
        : key === 'signals'
          ? (item: FulfillmentItem) => (
              <span className="fulfillment-cell">
                <span>{fulfillmentField(item, 'signals', context)}</span>
                <small className="fulfillment-reason">
                  {fulfillmentReason(item, context.asOf)}
                </small>
              </span>
            )
          : key === 'progress'
            ? (item: FulfillmentItem) => (
                <ProgressCell item={item} context={context} />
              )
            : (item: FulfillmentItem) => fulfillmentField(item, key, context);

    return {
      key,
      header: fulfillmentPresentation[key]?.label() ?? key,
      ...options,
      ...(sortKey ? { sortKey } : {}),
      filterable: !!filter?.filter,
      cell,
    };
  });
}

/**
 * Lists fulfillments as a table whose columns are Fulfillment catalog fields; the order labels
 * each row and carries its state. Sorting reports the catalog sort; the caller owns sort state
 * and starts from the first page.
 */
export function FulfillmentTable({
  caption,
  items,
  context,
  link,
  empty,
  sort,
  onSortChange,
  columnState,
  onColumnStateChange,
  onColumnFilter,
  density = 'comfortable',
  focusedRowKey,
  selection,
}: {
  caption: string;
  items: readonly FulfillmentItem[];
  context: FulfillmentFieldContext;
  /** The fulfillment's link, such as a router `<Link>` without children. */
  link: (item: FulfillmentItem) => ReactElement;
  empty: ReactNode;
  sort?: DataTableSort | undefined;
  onSortChange?: ((sort: DataTableSort) => void) | undefined;
  columnState?: DataTableColumnState | undefined;
  onColumnStateChange?: ((state: DataTableColumnState) => void) | undefined;
  onColumnFilter?: ((key: string) => void) | undefined;
  density?: CollectionDensity | undefined;
  focusedRowKey?: string | undefined;
  selection?: DataTableSelection<FulfillmentItem> | undefined;
}) {
  return (
    <DataTable
      className="fulfillment-list-table"
      caption={caption}
      columns={fulfillmentColumns(link, context)}
      rows={items}
      rowKey={(item) => item.id}
      rowHeader="order"
      empty={empty}
      sort={sort}
      onSortChange={onSortChange}
      firstSortDirection="asc"
      columnState={columnState}
      onColumnStateChange={onColumnStateChange}
      onColumnFilter={onColumnFilter}
      density={density}
      focusedRowKey={focusedRowKey}
      selection={selection}
    />
  );
}

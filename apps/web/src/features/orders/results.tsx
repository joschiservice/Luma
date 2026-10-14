import {
  type CollectionDensity,
  collectionField,
  type CollectionGroup,
  type CollectionGrouping,
  type CollectionLayout,
  type OrderList,
  type OrderListItem,
  ordersCatalog,
} from '@luma/api-contract';
import { formatCurrency, formatList } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { CollectionBoard } from '@luma/ui/components/primitives/collection-board';
import { CollectionGroups } from '@luma/ui/components/primitives/collection-groups';
import { CollectionList } from '@luma/ui/components/primitives/collection-list';
import type {
  DataTableColumn,
  DataTableColumnState,
  DataTableSort,
} from '@luma/ui/components/primitives/data-table';
import type { ReactElement, ReactNode } from 'react';

import { groupId, type GroupMore } from '../../kit/collections/groups';
import { orderLabel } from '../../shared/orders/presentation';
import { orderField, OrderFlags } from './fields';
import { OrdersTable } from './list-table';

/** Everything the Orders results need besides the rows; the page fills it from the view. */
export interface OrderResultsProps {
  list: OrderList;
  layout: CollectionLayout;
  density: CollectionDensity;
  grouping: CollectionGrouping | null;
  /** Names the table or list for assistive technology. */
  caption: string;
  link: (order: OrderListItem) => ReactElement;
  /** Shown when nothing matches. */
  empty: ReactNode;
  sort?: DataTableSort | undefined;
  onSortChange?: ((sort: DataTableSort) => void) | undefined;
  columnState?: DataTableColumnState | undefined;
  onColumnStateChange?: ((state: DataTableColumnState) => void) | undefined;
  onColumnFilter?: ((key: string) => void) | undefined;
  /** Properties list rows and board cards show, in order. */
  properties: readonly string[];
  focusedKey?: string | undefined;
  /** The order open in the preview. */
  current?: string | undefined;
  selection?:
    | { selected: readonly string[]; onChange: (selected: string[]) => void }
    | undefined;
  groupLabel: (key: CollectionGroup['key']) => string;
  /** Collapsed group IDs, from the member's display settings. */
  collapsed: readonly string[];
  onCollapsedChange: (id: string, collapsed: boolean) => void;
  /** Rows loaded with "Show more" in each group. */
  more?: ((group: CollectionGroup) => GroupMore<OrderListItem>) | undefined;
  /** Table columns beyond the catalog's, such as custom fields. */
  extraColumns?: readonly DataTableColumn<OrderListItem>[];
}

/** One group with its rows in display order. */
interface OrderGroup {
  group: CollectionGroup;
  id: string;
  rows: OrderListItem[];
  more: GroupMore<OrderListItem> | undefined;
}

const noMore = (): undefined => undefined;

/**
 * The groups to show: the list's groups in its order, with their first rows and any rows "Show
 * more" loaded. With "Show empty groups", choice and yes/no fields also list their options that
 * matched nothing, in the catalog's order; other fields can't name groups without a record.
 */
export function orderGroups(
  list: OrderList,
  grouping: CollectionGrouping,
  more: (group: CollectionGroup) => GroupMore<OrderListItem> | undefined,
): OrderGroup[] {
  const byId = new Map(list.items.map((item) => [item.id, item]));
  const returned = list.groups ?? [];
  const field = collectionField(ordersCatalog, grouping.field);
  const keys: CollectionGroup['key'][] | undefined = !grouping.showEmpty
    ? undefined
    : field?.type === 'boolean'
      ? [true, false]
      : field?.options
        ? [...field.options]
        : undefined;
  const groups = keys
    ? [
        ...keys.map(
          (key) =>
            returned.find((group) => group.key === key) ?? {
              key,
              count: 0,
              complete: true,
              itemIds: [],
              nextCursor: null,
              sums: [],
            },
        ),
        ...returned.filter((group) => !keys.includes(group.key)),
      ]
    : returned.filter((group) => group.count > 0);

  return groups.map((group) => {
    const extra = more(group);
    const first = group.itemIds.flatMap((id) => {
      const item = byId.get(id);

      return item ? [item] : [];
    });
    const seen = new Set(first.map((item) => item.id));

    return {
      group,
      id: groupId(group.key),
      rows: [
        ...first,
        ...(extra?.rows ?? []).filter((item) => !seen.has(item.id)),
      ],
      more: extra,
    };
  });
}

/** Totals of a group, one per currency, such as "€1,240.00 · $86.00". */
function sums(group: CollectionGroup) {
  const amounts = group.sums
    .filter((sum) => sum.field === 'total' && sum.currency)
    .map((sum) => {
      const amount = Number(sum.amount);

      return Number.isFinite(amount)
        ? formatCurrency(amount, sum.currency!)
        : `${sum.amount} ${sum.currency}`;
    });

  return amounts.length
    ? m.orders_group_totals({ totals: formatList(amounts) })
    : undefined;
}

function moreButton(group: OrderGroup) {
  return group.more?.load
    ? {
        onClick: group.more.load,
        pending: group.more.pending,
        ...(group.more.failed
          ? { label: m.collections_group_more_failed() }
          : {}),
      }
    : undefined;
}

/**
 * Shows orders in the view's layout: a table, a list of rows with the chosen properties, grouped
 * sections of either, or a board with one column per group. Rows come from the server in the
 * view's sort; nothing is sorted or filtered here.
 */
export function OrderResults(props: OrderResultsProps) {
  const {
    list,
    layout,
    grouping,
    caption,
    link,
    empty,
    groupLabel,
    collapsed,
    onCollapsedChange,
  } = props;
  const rows = (items: readonly OrderListItem[], label: string) =>
    layout === 'list' ? (
      <OrderRows {...props} items={items} caption={label} />
    ) : (
      <OrdersTable
        caption={label}
        items={items}
        link={link}
        empty={null}
        sort={props.sort}
        onSortChange={props.onSortChange}
        columnState={props.columnState}
        onColumnStateChange={props.onColumnStateChange}
        onColumnFilter={props.onColumnFilter}
        density={props.density}
        focusedRowKey={props.focusedKey}
        extraColumns={props.extraColumns}
        selection={
          props.selection
            ? { ...props.selection, rowLabel: (order) => orderLabel(order) }
            : undefined
        }
      />
    );

  if (!grouping || !list.groups)
    return list.items.length ? <>{rows(list.items, caption)}</> : <>{empty}</>;

  const groups = orderGroups(list, grouping, props.more ?? noMore);
  if (!groups.length) return <>{empty}</>;
  const name = (group: OrderGroup) => groupLabel(group.group.key);

  return layout === 'board' ? (
    <CollectionBoard
      label={caption}
      columns={groups.map((group) => ({
        key: group.id,
        label: name(group),
        count: group.group.count,
        complete: group.group.complete,
        summary: sums(group.group),
        items: group.rows,
        more: moreButton(group),
      }))}
      itemKey={(order) => order.id}
      link={link}
      title={(order) => orderLabel(order)}
      status={(order) => <OrderFlags order={order} />}
      properties={props.properties}
      property={orderField}
      focusedKey={props.focusedKey}
      current={props.current}
    />
  ) : (
    <CollectionGroups
      label={caption}
      collapsed={collapsed}
      onCollapsedChange={onCollapsedChange}
      groups={groups.map((group) => ({
        key: group.id,
        label: name(group),
        count: group.group.count,
        complete: group.group.complete,
        summary: sums(group.group),
        content: group.rows.length ? (
          rows(group.rows, `${caption}: ${name(group)}`)
        ) : (
          <p className="order-note">{m.orders_group_empty()}</p>
        ),
        more: moreButton(group),
      }))}
    />
  );
}

/** Orders as list rows with the properties chosen in Display. */
function OrderRows({
  items,
  caption,
  link,
  properties,
  density,
  focusedKey,
  current,
  selection,
}: OrderResultsProps & { items: readonly OrderListItem[] }) {
  return (
    <CollectionList
      label={caption}
      items={items}
      itemKey={(order) => order.id}
      link={link}
      title={(order) => orderLabel(order)}
      status={(order) => <OrderFlags order={order} />}
      properties={properties}
      property={orderField}
      density={density}
      focusedKey={focusedKey}
      current={current}
      selection={
        selection
          ? { ...selection, rowLabel: (order) => orderLabel(order) }
          : undefined
      }
    />
  );
}

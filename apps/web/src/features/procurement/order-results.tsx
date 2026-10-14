import {
  type CollectionDensity,
  collectionField,
  type CollectionGroup,
  type CollectionGrouping,
  type CollectionLayout,
  procurementCatalog,
  type PurchaseOrderList,
} from '@luma/api-contract';
import { formatCurrency, formatList } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { CollectionBoard } from '@luma/ui/components/primitives/collection-board';
import { CollectionGroups } from '@luma/ui/components/primitives/collection-groups';
import { CollectionList } from '@luma/ui/components/primitives/collection-list';
import {
  DataTable,
  type DataTableColumn,
  type DataTableColumnState,
  DataTableRowLink,
  type DataTableSort,
} from '@luma/ui/components/primitives/data-table';
import type { ReactElement, ReactNode } from 'react';

import { groupId, type GroupMore } from '../../kit/collections/groups';
import { purchaseOrdersPresentation } from './collection';
import {
  type ListedPurchaseOrder,
  type LocationNames,
  purchaseOrderField,
  PurchaseOrderFlags,
} from './fields';

/** Table columns by catalog field; the Display menu offers the same IDs. */
const layout: Readonly<
  Record<string, { numeric?: true; hideOnNarrow?: true; width?: number }>
> = {
  reference: { width: 220 },
  number: { hideOnNarrow: true },
  supplier: {},
  status: { hideOnNarrow: true },
  stage: {},
  attention: { hideOnNarrow: true, width: 220 },
  expected: { hideOnNarrow: true },
  confirmationDue: { hideOnNarrow: true },
  nextCheck: { hideOnNarrow: true },
  nextOwner: { hideOnNarrow: true },
  lines: { numeric: true, hideOnNarrow: true },
  created: { hideOnNarrow: true },
  updated: { hideOnNarrow: true },
  authority: { hideOnNarrow: true },
  location: { hideOnNarrow: true },
  sku: { hideOnNarrow: true, width: 220 },
  value: { numeric: true, hideOnNarrow: true },
};

/** Everything the purchase-order results need besides the rows; the page fills it from the view. */
export interface PurchaseOrderResultsProps {
  list: PurchaseOrderList;
  layout: CollectionLayout;
  density: CollectionDensity;
  grouping: CollectionGrouping | null;
  /** Names the table or list for assistive technology. */
  caption: string;
  link: (order: ListedPurchaseOrder) => ReactElement;
  /** Shown when nothing matches. */
  empty: ReactNode;
  sort?: DataTableSort | undefined;
  onSortChange?: ((sort: DataTableSort) => void) | undefined;
  columnState?: DataTableColumnState | undefined;
  onColumnStateChange?: ((state: DataTableColumnState) => void) | undefined;
  onColumnFilter?: ((key: string) => void) | undefined;
  /** Properties list rows and board cards show, in order. */
  properties: readonly string[];
  locations?: LocationNames | undefined;
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
  more?:
    ((group: CollectionGroup) => GroupMore<ListedPurchaseOrder>) | undefined;
  /** Table columns beyond the catalog's, such as custom fields. */
  extraColumns?: readonly DataTableColumn<ListedPurchaseOrder>[];
}

/** One group with its rows in display order. */
interface PurchaseOrderGroup {
  group: CollectionGroup;
  id: string;
  rows: ListedPurchaseOrder[];
  more: GroupMore<ListedPurchaseOrder> | undefined;
}

const noMore = (): undefined => undefined;

/**
 * The groups to show: the list's groups in its order with their first rows and any rows "Show
 * more" loaded. With "Show empty groups", choice fields also list options that matched nothing,
 * in the catalog's order.
 */
export function purchaseOrderGroups(
  list: PurchaseOrderList,
  grouping: CollectionGrouping,
  more: (group: CollectionGroup) => GroupMore<ListedPurchaseOrder> | undefined,
): PurchaseOrderGroup[] {
  const byId = new Map(list.items.map((item) => [item.id, item]));
  const returned = list.groups ?? [];
  const field = collectionField(procurementCatalog, grouping.field);
  const keys =
    grouping.showEmpty && field?.options ? [...field.options] : undefined;
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
        ...returned.filter(
          (group) => typeof group.key !== 'string' || !keys.includes(group.key),
        ),
      ]
    : returned.filter((group) => group.count > 0);

  return groups.map((group) => {
    const extra = more(group);
    const first = group.itemIds.flatMap((id) => byId.get(id) ?? []);
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

/** Order values of a group, one per currency, such as "Value €1,240.00 · $86.00". */
function sums(group: CollectionGroup) {
  const amounts = group.sums
    .filter((sum) => sum.field === 'value' && sum.currency)
    .map((sum) => {
      const amount = Number(sum.amount);

      return Number.isFinite(amount)
        ? formatCurrency(amount, sum.currency!)
        : `${sum.amount} ${sum.currency}`;
    });

  return amounts.length
    ? m.procurement_group_values({ totals: formatList(amounts) })
    : undefined;
}

function moreButton(group: PurchaseOrderGroup) {
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
 * Lists purchase orders as a configurable table whose columns are catalog fields; the reference
 * labels each row and carries its open-item flag. Sorting reports the catalog field; the caller
 * owns sort state.
 */
function PurchaseOrdersTable({
  caption,
  items,
  link,
  sort,
  onSortChange,
  columnState,
  onColumnStateChange,
  onColumnFilter,
  density,
  focusedKey,
  selection,
  locations,
  extraColumns = [],
}: Pick<
  PurchaseOrderResultsProps,
  | 'caption'
  | 'link'
  | 'sort'
  | 'onSortChange'
  | 'columnState'
  | 'onColumnStateChange'
  | 'onColumnFilter'
  | 'density'
  | 'focusedKey'
  | 'selection'
  | 'locations'
  | 'extraColumns'
> & { items: readonly ListedPurchaseOrder[] }) {
  const columns: DataTableColumn<ListedPurchaseOrder>[] = [
    ...Object.entries(layout).map(([key, options]) => {
      const field = collectionField(procurementCatalog, key);

      return {
        key,
        header: purchaseOrdersPresentation[key]?.label() ?? key,
        ...options,
        ...(field?.sort ? { sortKey: key } : {}),
        filterable: !!field?.filter,
        cell:
          key === 'reference'
            ? (order: ListedPurchaseOrder) => (
                <span className="procurement-cell">
                  <DataTableRowLink render={link(order)}>
                    {order.reference}
                  </DataTableRowLink>
                  <PurchaseOrderFlags order={order} />
                </span>
              )
            : (order: ListedPurchaseOrder) =>
                purchaseOrderField(order, key, locations),
      };
    }),
    ...extraColumns,
  ];

  return (
    <DataTable
      caption={caption}
      columns={columns}
      rows={items}
      rowKey={(order) => order.id}
      rowHeader="reference"
      empty={null}
      sort={sort}
      onSortChange={onSortChange}
      firstSortDirection="desc"
      columnState={columnState}
      onColumnStateChange={onColumnStateChange}
      onColumnFilter={onColumnFilter}
      density={density}
      focusedRowKey={focusedKey}
      selection={
        selection
          ? { ...selection, rowLabel: (order) => order.reference }
          : undefined
      }
    />
  );
}

/**
 * Shows purchase orders in the view's layout: a table, a list of rows with the chosen
 * properties, grouped sections of either, or a read-only board with one column per group. Stage
 * is derived from procurement rules, so the board never offers a move. Rows come from the
 * server in the view's sort; nothing is sorted or filtered here.
 */
export function PurchaseOrderResults(props: PurchaseOrderResultsProps) {
  const { list, layout: shape, grouping, caption, link, empty } = props;
  const property = (order: ListedPurchaseOrder, key: string) =>
    purchaseOrderField(order, key, props.locations);
  const rows = (items: readonly ListedPurchaseOrder[], label: string) =>
    shape === 'list' ? (
      <CollectionList
        label={label}
        items={items}
        itemKey={(order) => order.id}
        link={link}
        title={(order) => order.reference}
        status={(order) => <PurchaseOrderFlags order={order} />}
        properties={props.properties}
        property={property}
        density={props.density}
        focusedKey={props.focusedKey}
        current={props.current}
        selection={
          props.selection
            ? { ...props.selection, rowLabel: (order) => order.reference }
            : undefined
        }
      />
    ) : (
      <PurchaseOrdersTable {...props} caption={label} items={items} />
    );

  if (!grouping || !list.groups)
    return list.items.length ? <>{rows(list.items, caption)}</> : <>{empty}</>;

  const groups = purchaseOrderGroups(list, grouping, props.more ?? noMore);
  if (!groups.length) return <>{empty}</>;
  const name = (group: PurchaseOrderGroup) => props.groupLabel(group.group.key);

  return shape === 'board' ? (
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
      title={(order) => order.reference}
      status={(order) => <PurchaseOrderFlags order={order} />}
      properties={props.properties}
      property={property}
      focusedKey={props.focusedKey}
      current={props.current}
    />
  ) : (
    <CollectionGroups
      label={caption}
      collapsed={props.collapsed}
      onCollapsedChange={props.onCollapsedChange}
      groups={groups.map((group) => ({
        key: group.id,
        label: name(group),
        count: group.group.count,
        complete: group.group.complete,
        summary: sums(group.group),
        content: group.rows.length ? (
          rows(group.rows, `${caption}: ${name(group)}`)
        ) : (
          <p className="procurement-muted">{m.procurement_group_empty()}</p>
        ),
        more: moreButton(group),
      }))}
    />
  );
}

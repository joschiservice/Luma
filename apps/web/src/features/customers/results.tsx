import {
  type CollectionDensity,
  collectionField,
  type CollectionGroup,
  type CollectionGrouping,
  type CollectionLayout,
  type CustomerList,
  type CustomerListItem,
  customersCatalog,
} from '@luma/api-contract';
import { formatCurrency, formatList } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
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
import { customersPresentation } from './collection';
import {
  customerField,
  CustomerFlags,
  type CustomerSourceLabel,
  customerSourceLabel,
} from './fields';
import { customerName } from './presentation';

/** Everything the Customers results need besides the rows; the page fills it from the view. */
export interface CustomerResultsProps {
  list: CustomerList;
  layout: CollectionLayout;
  density: CollectionDensity;
  grouping: CollectionGrouping | null;
  /** Names the table or list for assistive technology. */
  caption: string;
  link: (customer: CustomerListItem) => ReactElement;
  /** Shown when nothing matches. */
  empty: ReactNode;
  sort?: DataTableSort | undefined;
  onSortChange?: ((sort: DataTableSort) => void) | undefined;
  columnState?: DataTableColumnState | undefined;
  onColumnStateChange?: ((state: DataTableColumnState) => void) | undefined;
  onColumnFilter?: ((key: string) => void) | undefined;
  /** Properties list rows show, in order. */
  properties: readonly string[];
  focusedKey?: string | undefined;
  /** The customer open in the preview. */
  current?: string | undefined;
  selection?:
    | { selected: readonly string[]; onChange: (selected: string[]) => void }
    | undefined;
  groupLabel: (key: CollectionGroup['key']) => string;
  /** Collapsed group IDs, from the member's display settings. */
  collapsed: readonly string[];
  onCollapsedChange: (id: string, collapsed: boolean) => void;
  /** Rows loaded with "Show more" in each group. */
  more?: ((group: CollectionGroup) => GroupMore<CustomerListItem>) | undefined;
  /** Table columns beyond the catalog's, such as custom fields. */
  extraColumns?: readonly DataTableColumn<CustomerListItem>[];
}

/** One group with its rows in display order. */
interface CustomerGroup {
  group: CollectionGroup;
  id: string;
  rows: CustomerListItem[];
  more: GroupMore<CustomerListItem> | undefined;
}

const noMore = (): undefined => undefined;

/** Table placement by catalog column ID; the Display menu offers the same IDs. */
const layout: Readonly<
  Record<string, { numeric?: true; hideOnNarrow?: true; width?: number }>
> = {
  name: { width: 260 },
  email: { hideOnNarrow: true },
  phone: { hideOnNarrow: true },
  orders: { numeric: true },
  spent: { numeric: true },
  created: { hideOnNarrow: true },
  updated: { hideOnNarrow: true },
  state: { hideOnNarrow: true },
  source: { hideOnNarrow: true },
  tags: { hideOnNarrow: true, width: 220 },
};

/** The name, with the email or why contact details are missing, and the source when several share. */
function NameCell({
  customer,
  link,
  sourceLabel,
  showSource,
}: {
  customer: CustomerListItem;
  link: ReactElement;
  sourceLabel: CustomerSourceLabel;
  showSource: boolean;
}) {
  const details = [
    !customer.shared.contact
      ? m.customers_contact_not_shared()
      : customer.displayName && customer.email
        ? customer.email
        : null,
    showSource ? sourceLabel(customer.connectionId) : null,
  ].filter(Boolean);

  return (
    <div className="customers-cell">
      <DataTableRowLink render={link}>
        {customerName(customer)}
      </DataTableRowLink>
      {details.length ? <small>{details.join(' · ')}</small> : null}
      <CustomerFlags customer={customer} sourceLabel={sourceLabel} />
    </div>
  );
}

/**
 * Lists customers as a table whose columns are Customers catalog fields; the name labels each
 * row. Sorting reports the catalog field; the caller owns sort state.
 */
function CustomersTable({
  caption,
  items,
  link,
  sourceLabel,
  showSource,
  sort,
  onSortChange,
  columnState,
  onColumnStateChange,
  onColumnFilter,
  density,
  focusedRowKey,
  selection,
  extraColumns = [],
}: {
  caption: string;
  items: readonly CustomerListItem[];
  link: (customer: CustomerListItem) => ReactElement;
  sourceLabel: CustomerSourceLabel;
  showSource: boolean;
  sort?: DataTableSort | undefined;
  onSortChange?: ((sort: DataTableSort) => void) | undefined;
  columnState?: DataTableColumnState | undefined;
  onColumnStateChange?: ((state: DataTableColumnState) => void) | undefined;
  onColumnFilter?: ((key: string) => void) | undefined;
  density: CollectionDensity;
  focusedRowKey?: string | undefined;
  selection?: CustomerResultsProps['selection'];
  extraColumns?: readonly DataTableColumn<CustomerListItem>[] | undefined;
}) {
  const columns: DataTableColumn<CustomerListItem>[] = [
    ...Object.entries(layout).map(([key, options]) => {
      const field = collectionField(customersCatalog, key);

      return {
        key,
        header: customersPresentation[key]?.label() ?? key,
        ...options,
        ...(field?.sort ? { sortKey: key } : {}),
        filterable: !!field?.filter,
        cell:
          key === 'name'
            ? (customer: CustomerListItem) => (
                <NameCell
                  customer={customer}
                  link={link(customer)}
                  sourceLabel={sourceLabel}
                  showSource={showSource}
                />
              )
            : (customer: CustomerListItem) =>
                customerField(customer, key, sourceLabel),
      };
    }),
    ...extraColumns,
  ];

  return (
    <DataTable
      caption={caption}
      columns={columns}
      rows={items}
      rowKey={(customer) => customer.id}
      rowHeader="name"
      empty={null}
      sort={sort}
      onSortChange={onSortChange}
      firstSortDirection="desc"
      columnState={columnState}
      onColumnStateChange={onColumnStateChange}
      onColumnFilter={onColumnFilter}
      density={density}
      focusedRowKey={focusedRowKey}
      selection={
        selection
          ? { ...selection, rowLabel: (customer) => customerName(customer) }
          : undefined
      }
    />
  );
}

/**
 * The groups to show: the list's groups in its order, with their first rows and any rows "Show
 * more" loaded. With "Show empty groups", account states also list states that matched nothing.
 */
export function customerGroups(
  list: CustomerList,
  grouping: CollectionGrouping,
  more: (group: CollectionGroup) => GroupMore<CustomerListItem> | undefined,
): CustomerGroup[] {
  const byId = new Map(list.items.map((item) => [item.id, item]));
  const returned = list.groups ?? [];
  const field = collectionField(customersCatalog, grouping.field);
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

/** Amounts spent in a group, one per currency, such as "Spent €1,240.00 · $86.00". */
function sums(group: CollectionGroup) {
  const amounts = group.sums
    .filter((sum) => sum.field === 'spent' && sum.currency)
    .map((sum) => {
      const amount = Number(sum.amount);

      return Number.isFinite(amount)
        ? formatCurrency(amount, sum.currency!)
        : `${sum.amount} ${sum.currency}`;
    });

  return amounts.length
    ? m.customers_group_totals({ totals: formatList(amounts) })
    : undefined;
}

/**
 * Shows customers in the view's layout: a table, a list of rows with the chosen properties, or
 * grouped sections of either. Rows come from the server in the view's sort; nothing is sorted or
 * filtered here.
 */
export function CustomerResults(props: CustomerResultsProps) {
  const {
    list,
    grouping,
    caption,
    empty,
    groupLabel,
    collapsed,
    onCollapsedChange,
  } = props;
  const sharing = list.sources.filter((source) => source.access === 'granted');
  const sourceLabel = customerSourceLabel(list.sources);
  const rows = (items: readonly CustomerListItem[], label: string) =>
    props.layout === 'list' ? (
      <CollectionList
        label={label}
        items={items}
        itemKey={(customer) => customer.id}
        link={props.link}
        title={(customer) => customerName(customer)}
        status={(customer) => (
          <CustomerFlags customer={customer} sourceLabel={sourceLabel} />
        )}
        properties={props.properties}
        property={(customer, key) => customerField(customer, key, sourceLabel)}
        density={props.density}
        focusedKey={props.focusedKey}
        current={props.current}
        selection={
          props.selection
            ? {
                ...props.selection,
                rowLabel: (customer) => customerName(customer),
              }
            : undefined
        }
      />
    ) : (
      <CustomersTable
        caption={label}
        items={items}
        link={props.link}
        sourceLabel={sourceLabel}
        showSource={sharing.length > 1}
        sort={props.sort}
        onSortChange={props.onSortChange}
        columnState={props.columnState}
        onColumnStateChange={props.onColumnStateChange}
        onColumnFilter={props.onColumnFilter}
        density={props.density}
        focusedRowKey={props.focusedKey}
        selection={props.selection}
        extraColumns={props.extraColumns}
      />
    );

  if (!grouping || !list.groups)
    return list.items.length ? <>{rows(list.items, caption)}</> : <>{empty}</>;

  const groups = customerGroups(list, grouping, props.more ?? noMore);
  if (!groups.length) return <>{empty}</>;
  const name = (group: CustomerGroup) => groupLabel(group.group.key);

  return (
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
          <p className="customers-muted">{m.customers_group_empty()}</p>
        ),
        more: group.more?.load
          ? {
              onClick: group.more.load,
              pending: group.more.pending,
              ...(group.more.failed
                ? { label: m.collections_group_more_failed() }
                : {}),
            }
          : undefined,
      }))}
    />
  );
}

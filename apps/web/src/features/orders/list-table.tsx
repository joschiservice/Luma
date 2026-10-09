import './orders.css';

import type { OrderListItem, OrderSort } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Badge } from '@luma/ui/components/primitives/badge';
import {
  DataTable,
  type DataTableColumn,
  DataTableRowLink,
} from '@luma/ui/components/primitives/data-table';
import { StatePill } from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { orderFilters, type OrdersSearch } from './data';
import {
  formatMoney,
  fulfillmentLabel,
  orderLabel,
  paymentLabels,
  sortLabels,
  statusLabels,
  viewLabels,
} from './presentation';

function orderColumns(
  organizationId: string,
  search: OrdersSearch,
): DataTableColumn<OrderListItem, OrderSort>[] {
  return [
    {
      key: 'order',
      header: m.orders_column_order(),
      sortKey: 'number',
      cell: (order) => (
        <>
          <DataTableRowLink
            render={
              <Link
                to="/app/$organizationId/orders/$orderId"
                params={{ organizationId, orderId: order.id }}
                search={search}
              />
            }
          >
            {orderLabel(order)}
          </DataTableRowLink>
          <span className="orders-row-flags">
            {order.issueIds.length ? (
              <StatePill state="attention">
                {m.orders_flag_needs_you()}
              </StatePill>
            ) : null}
            {order.overdue ? (
              <Badge tone="danger">{m.orders_flag_overdue()}</Badge>
            ) : null}
            {order.differs ? (
              <Badge tone="warning">{m.orders_flag_differs()}</Badge>
            ) : null}
          </span>
        </>
      ),
    },
    {
      key: 'placed',
      header: m.orders_column_placed(),
      sortKey: 'placed',
      hideOnNarrow: true,
      cell: (order) =>
        order.placedAt ? (
          <WorkspaceDate value={order.placedAt} />
        ) : (
          m.common_empty_value()
        ),
    },
    {
      key: 'status',
      header: m.orders_column_status(),
      cell: (order) => (
        <span className="orders-cell-stack">
          <span>{statusLabels[order.status] ?? order.status}</span>
          <small>
            {paymentLabels[order.paymentStatus] ?? order.paymentStatus}
          </small>
        </span>
      ),
    },
    {
      key: 'fulfillment',
      header: m.orders_column_fulfillment(),
      cell: (order) => fulfillmentLabel(order),
    },
    {
      key: 'total',
      header: m.orders_column_total(),
      numeric: true,
      cell: (order) => formatMoney(order.total) ?? m.common_empty_value(),
    },
    {
      key: 'sources',
      header: m.orders_column_sources(),
      hideOnNarrow: true,
      cell: (order) => (
        <span className="orders-sources">
          {order.sources.map((source) => (
            <Badge
              key={source.connectionId}
              tone={
                source.deleted || source.connectionStatus !== 'active'
                  ? 'warning'
                  : 'neutral'
              }
              title={source.externalId ?? undefined}
            >
              {source.deleted
                ? m.orders_source_removed({ source: source.label })
                : source.label}
            </Badge>
          ))}
        </span>
      ),
    },
    {
      key: 'updated',
      header: m.orders_column_updated(),
      sortKey: 'updated',
      hideOnNarrow: true,
      cell: (order) => (
        <WorkspaceDate value={order.sourceUpdatedAt ?? order.observedAt} />
      ),
    },
  ];
}

export type OrderColumn =
  | 'order'
  | 'placed'
  | 'status'
  | 'fulfillment'
  | 'total'
  | 'sources'
  | 'updated';

/**
 * Lists one page of orders, or `empty` when the page has none. Each row opens its order with the
 * current filters, and sortable headers change the URL sort, starting from the first page.
 * `columns` limits the table to those columns, for narrower placements.
 */
export function OrdersTable({
  organizationId,
  search,
  items,
  change,
  empty,
  columns,
}: {
  organizationId: string;
  search: OrdersSearch;
  items: OrderListItem[];
  change: (next: OrdersSearch) => void;
  empty: ReactNode;
  columns?: readonly OrderColumn[];
}) {
  const sort = search.sort ?? 'updated';
  const shown = orderColumns(organizationId, search).filter(
    (column) => !columns || (columns as readonly string[]).includes(column.key),
  );

  return (
    <DataTable
      caption={m.orders_list_caption({
        view: viewLabels[search.view ?? 'all'],
        sort: sortLabels[sort],
      })}
      columns={shown}
      rows={items}
      rowKey={(order) => order.id}
      empty={empty}
      sort={{ key: sort, direction: search.direction ?? 'desc' }}
      firstSortDirection="desc"
      onSortChange={(next) =>
        change({
          ...orderFilters(search),
          sort: next.key,
          direction: next.direction,
        })
      }
    />
  );
}

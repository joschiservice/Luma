import type { OrderListItem, OrderSort } from '@luma/api-contract';
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
      header: 'Order',
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
              <StatePill state="attention">Needs you</StatePill>
            ) : null}
            {order.overdue ? <Badge tone="danger">Overdue</Badge> : null}
            {order.differs ? (
              <Badge tone="warning">Differs by source</Badge>
            ) : null}
          </span>
        </>
      ),
    },
    {
      key: 'placed',
      header: 'Placed',
      sortKey: 'placed',
      hideOnNarrow: true,
      cell: (order) =>
        order.placedAt ? <WorkspaceDate value={order.placedAt} /> : '—',
    },
    {
      key: 'status',
      header: 'Status',
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
      header: 'Fulfillment',
      cell: (order) => fulfillmentLabel(order),
    },
    {
      key: 'total',
      header: 'Total',
      numeric: true,
      cell: (order) => formatMoney(order.total) ?? '—',
    },
    {
      key: 'sources',
      header: 'Sources',
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
              {source.label}
              {source.deleted ? ' · removed' : ''}
            </Badge>
          ))}
        </span>
      ),
    },
    {
      key: 'updated',
      header: 'Updated',
      sortKey: 'updated',
      hideOnNarrow: true,
      cell: (order) => (
        <WorkspaceDate value={order.sourceUpdatedAt ?? order.observedAt} />
      ),
    },
  ];
}

/**
 * Lists one page of orders, or `empty` when the page has none. Each row opens its order with the
 * current filters, and sortable headers change the URL sort, starting from the first page.
 */
export function OrdersTable({
  organizationId,
  search,
  items,
  change,
  empty,
}: {
  organizationId: string;
  search: OrdersSearch;
  items: OrderListItem[];
  change: (next: OrdersSearch) => void;
  empty: ReactNode;
}) {
  const sort = search.sort ?? 'updated';

  return (
    <DataTable
      caption={`${viewLabels[search.view ?? 'all']}, sorted by ${sortLabels[sort].toLowerCase()}`}
      columns={orderColumns(organizationId, search)}
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

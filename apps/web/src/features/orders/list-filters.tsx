import {
  type CollectionFilter,
  CollectionToolbar,
  CollectionViews,
} from '@luma/ui/components/primitives/collection-toolbar';
import { WorkspaceTimezone } from '@luma/ui/components/primitives/workspace-date';
import { workspaceDateValue } from '@luma/ui/lib/timezone';
import { CalendarDays, CircleDot, CreditCard, Plug } from 'lucide-react';
import { useContext } from 'react';

import {
  orderPaymentStatuses,
  orderSorts,
  type OrdersSearch,
  orderStatuses,
  orderViews,
} from './data';
import {
  paymentLabels,
  sortLabels,
  statusLabels,
  viewDescriptions,
  viewLabels,
} from './presentation';

export type OrderSource = { id: string; label: string };

/** Whether the order search narrows the list beyond its view and sort. */
export function orderFiltered(search: OrdersSearch) {
  return [
    search.q,
    search.status,
    search.paymentStatus,
    search.connectionId,
    search.placedFrom,
    search.placedTo,
    search.updatedFrom,
    search.updatedBefore,
  ].some(Boolean);
}

/**
 * Presents order views, search, filter chips and sort. The caller owns the URL state; `update`
 * merges a patch into the current filters and returns to the first page.
 */
export function OrderFilters({
  search,
  sources,
  update,
  change,
  refresh,
  refreshing,
}: {
  search: OrdersSearch;
  sources: OrderSource[];
  update: (patch: Partial<OrdersSearch>) => void;
  change: (next: OrdersSearch) => void;
  refresh: () => void;
  refreshing: boolean;
}) {
  const timeZone = useContext(WorkspaceTimezone);
  const view = search.view ?? 'all';
  const filters: CollectionFilter[] = [
    {
      kind: 'choice',
      key: 'status',
      label: 'Status',
      icon: CircleDot,
      value: search.status,
      options: orderStatuses.map((value) => ({
        value,
        label: statusLabels[value]!,
      })),
      onChange: (value) =>
        update({ status: orderStatuses.find((item) => item === value) }),
    },
    {
      kind: 'choice',
      key: 'paymentStatus',
      label: 'Payment',
      icon: CreditCard,
      value: search.paymentStatus,
      options: orderPaymentStatuses.map((value) => ({
        value,
        label: paymentLabels[value]!,
      })),
      onChange: (value) =>
        update({
          paymentStatus: orderPaymentStatuses.find((item) => item === value),
        }),
    },
    {
      kind: 'choice',
      key: 'connectionId',
      label: 'Source',
      icon: Plug,
      value: search.connectionId,
      options: (sources.length > 1 ||
      sources.some((item) => item.id === search.connectionId)
        ? sources
        : []
      ).map((item) => ({ value: item.id, label: item.label })),
      onChange: (value) => update({ connectionId: value }),
    },
    {
      kind: 'date-range',
      key: 'placed',
      label: 'Placed',
      icon: CalendarDays,
      from: search.placedFrom,
      to: search.placedTo,
      today: workspaceDateValue(new Date(), timeZone),
      onChange: (range) =>
        update({ placedFrom: range.from, placedTo: range.to }),
    },
    {
      kind: 'applied',
      key: 'updated',
      label: 'Updated',
      value:
        search.updatedFrom || search.updatedBefore
          ? 'In metric window'
          : undefined,
      onRemove: () =>
        update({ updatedFrom: undefined, updatedBefore: undefined }),
    },
  ];

  return (
    <CollectionToolbar
      views={
        <CollectionViews
          label="Order views"
          value={view}
          views={orderViews.map((value) => ({
            value,
            label: viewLabels[value],
            description: viewDescriptions[value],
          }))}
          onChange={(value) =>
            update({ view: value === 'all' ? undefined : value })
          }
        />
      }
      search={{
        value: search.q,
        onChange: (q) => update({ q }),
        label: 'Search orders',
        placeholder: 'Order number, source ID or SKU…',
      }}
      filters={filters}
      sort={{
        value: search.sort ?? 'updated',
        options: orderSorts.map((value) => ({
          value,
          label: sortLabels[value],
        })),
        onChange: (value) => {
          const sort = orderSorts.find((item) => item === value);
          update({ sort: sort === 'updated' ? undefined : sort });
        },
        direction: search.direction ?? 'desc',
        onDirectionChange: (direction) =>
          update({ direction: direction === 'asc' ? 'asc' : undefined }),
      }}
      onClear={() =>
        change({
          view: search.view,
          sort: search.sort,
          direction: search.direction,
        })
      }
      onRefresh={refresh}
      refreshing={refreshing}
      refreshLabel="Refresh orders"
    />
  );
}

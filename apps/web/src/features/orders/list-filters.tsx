import { Button } from '@luma/ui/components/primitives/button';
import { CollectionToolbar } from '@luma/ui/components/primitives/collection-toolbar';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { ArrowDown, ArrowUp, Search } from 'lucide-react';

import {
  orderPaymentStatuses,
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

/** Lists the removable filter chips for the active order search, excluding view and sort. */
export function orderFilterChips(search: OrdersSearch, sources: OrderSource[]) {
  const source = (id: string) =>
    sources.find((item) => item.id === id)?.label ?? 'One source';

  return [
    search.q ? { key: 'q', label: `“${search.q}”` } : null,
    search.status
      ? { key: 'status', label: statusLabels[search.status]! }
      : null,
    search.paymentStatus
      ? { key: 'paymentStatus', label: paymentLabels[search.paymentStatus]! }
      : null,
    search.connectionId
      ? { key: 'connectionId', label: source(search.connectionId) }
      : null,
    search.placedFrom
      ? { key: 'placedFrom', label: `Placed from ${search.placedFrom}` }
      : null,
    search.placedTo
      ? { key: 'placedTo', label: `Placed to ${search.placedTo}` }
      : null,
    search.updatedFrom || search.updatedBefore
      ? { key: 'updated', label: 'Updated in metric window' }
      : null,
  ].flatMap((chip) => (chip ? [chip] : []));
}

/**
 * Presents order views, search, filters and sort controls. The caller owns the URL state and the
 * unsubmitted search text; `update` merges a patch into the current filters and returns to the
 * first page.
 */
export function OrderFilters({
  search,
  sources,
  draft,
  onDraftChange,
  update,
  change,
  refresh,
  refreshing,
}: {
  search: OrdersSearch;
  sources: OrderSource[];
  draft: string;
  onDraftChange: (draft: string) => void;
  update: (patch: Partial<OrdersSearch>) => void;
  change: (next: OrdersSearch) => void;
  refresh: () => void;
  refreshing: boolean;
}) {
  const view = search.view ?? 'all';
  const direction = search.direction ?? 'desc';

  return (
    <CollectionToolbar
      views={
        <div className="orders-views" role="group" aria-label="Order views">
          {orderViews.map((value) => (
            <Button
              key={value}
              variant="ghost"
              aria-pressed={view === value}
              title={viewDescriptions[value]}
              onClick={() =>
                update({ view: value === 'all' ? undefined : value })
              }
            >
              {viewLabels[value]}
            </Button>
          ))}
        </div>
      }
      filters={orderFilterChips(search, sources).map((chip) => ({
        key: chip.key,
        label: chip.label,
        onRemove: () => {
          if (chip.key === 'q') onDraftChange('');
          update(
            chip.key === 'updated'
              ? { updatedFrom: undefined, updatedBefore: undefined }
              : { [chip.key]: undefined },
          );
        },
      }))}
      onClear={() => {
        onDraftChange('');
        change({
          view: search.view,
          sort: search.sort,
          direction: search.direction,
        });
      }}
      onRefresh={refresh}
      refreshing={refreshing}
      refreshLabel="Refresh orders"
    >
      <form
        className="orders-search"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          update({ q: draft.trim() || undefined });
        }}
      >
        <Search size={15} aria-hidden="true" />
        <Input
          type="search"
          aria-label="Search orders"
          placeholder="Order number, source ID or SKU…"
          value={draft}
          maxLength={120}
          onChange={(event) => onDraftChange(event.target.value)}
        />
        <Button type="submit" variant="outline" size="sm">
          Search
        </Button>
      </form>
      <Select
        aria-label="Order status"
        value={search.status ?? ''}
        options={[
          { value: '', label: 'Any status' },
          ...orderStatuses.map((value) => ({
            value,
            label: statusLabels[value]!,
          })),
        ]}
        onValueChange={(value) =>
          update({ status: (value || undefined) as OrdersSearch['status'] })
        }
      />
      <Select
        aria-label="Payment status"
        value={search.paymentStatus ?? ''}
        options={[
          { value: '', label: 'Any payment' },
          ...orderPaymentStatuses.map((value) => ({
            value,
            label: paymentLabels[value]!,
          })),
        ]}
        onValueChange={(value) =>
          update({
            paymentStatus: (value ||
              undefined) as OrdersSearch['paymentStatus'],
          })
        }
      />
      <Select
        aria-label="Source"
        value={search.connectionId ?? ''}
        options={[
          { value: '', label: 'All sources' },
          ...sources.map((item) => ({ value: item.id, label: item.label })),
        ]}
        onValueChange={(value) => update({ connectionId: value || undefined })}
      />
      <label className="orders-date">
        <span>Placed from</span>
        <Input
          type="date"
          value={search.placedFrom ?? ''}
          max={search.placedTo}
          onChange={(event) =>
            update({ placedFrom: event.target.value || undefined })
          }
        />
      </label>
      <label className="orders-date">
        <span>to</span>
        <Input
          type="date"
          value={search.placedTo ?? ''}
          min={search.placedFrom}
          onChange={(event) =>
            update({ placedTo: event.target.value || undefined })
          }
        />
      </label>
      <Select
        aria-label="Sort orders"
        value={search.sort ?? 'updated'}
        options={Object.entries(sortLabels).map(([value, label]) => ({
          value: value as NonNullable<OrdersSearch['sort']>,
          label,
        }))}
        onValueChange={(value) =>
          update({
            sort: value === 'updated' ? undefined : (value ?? undefined),
          })
        }
      />
      <Button
        variant="outline"
        size="icon"
        aria-label={
          direction === 'desc'
            ? 'Sorted newest or highest first. Sort ascending'
            : 'Sorted oldest or lowest first. Sort descending'
        }
        title="Change sort direction"
        onClick={() =>
          update({ direction: direction === 'desc' ? 'asc' : undefined })
        }
      >
        {direction === 'desc' ? (
          <ArrowDown aria-hidden="true" />
        ) : (
          <ArrowUp aria-hidden="true" />
        )}
      </Button>
    </CollectionToolbar>
  );
}

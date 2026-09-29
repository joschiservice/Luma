import './orders.css';

import type { OrderList, OrderListItem } from '@luma/api-contract';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { CollectionToolbar } from '@luma/ui/components/primitives/collection-toolbar';
import { DomainIcon } from '@luma/ui/components/primitives/domain-icon';
import { Empty } from '@luma/ui/components/primitives/empty';
import { Input } from '@luma/ui/components/primitives/input';
import { Pagination } from '@luma/ui/components/primitives/pagination';
import { Select } from '@luma/ui/components/primitives/select';
import { StatePill } from '@luma/ui/components/primitives/state';
import {
  WorkspaceDate,
  WorkspaceTimezone,
} from '@luma/ui/components/primitives/workspace-date';
import { PageHeader } from '@luma/ui/components/workspace/page-header';
import { onlineManager, useQuery } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  PackageSearch,
  Search,
} from 'lucide-react';
import { useContext, useState, useSyncExternalStore } from 'react';

import { connectionsOptions } from '../connections/data';
import { SignInRedirect } from '../identity/common';
import { IdentityError } from '../identity/data';
import {
  orderFilters,
  orderPageSize,
  orderPaymentStatuses,
  ordersOptions,
  type OrdersSearch,
  orderStatuses,
  orderViews,
} from './data';
import {
  formatMoney,
  fulfillmentLabel,
  orderLabel,
  paymentLabels,
  sortLabels,
  statusLabels,
  viewDescriptions,
  viewLabels,
} from './presentation';

const subscribe = (changed: () => void) => onlineManager.subscribe(changed);
const onlineSnapshot = () => onlineManager.isOnline();
const serverSnapshot = () => true;

export type OrdersError = 'access' | 'page' | 'unavailable';

/** Loads the order list for validated URL filters and keeps a previous-page trail per filter. */
export function OrdersPage() {
  const { organizationId } = useParams({
    from: '/app/$organizationId/orders/',
  });
  const search = useSearch({ from: '/app/$organizationId/orders/' });
  const navigate = useNavigate({ from: '/app/$organizationId/orders/' });
  const timeZone = useContext(WorkspaceTimezone);
  const list = useQuery(ordersOptions(organizationId, search, timeZone));
  const connections = useQuery(connectionsOptions(organizationId));
  const online = useSyncExternalStore(
    subscribe,
    onlineSnapshot,
    serverSnapshot,
  );
  const [trails, setTrails] = useState<Record<string, (string | undefined)[]>>(
    {},
  );
  const filterKey = JSON.stringify(orderFilters(search));
  const trail = trails[filterKey] ?? [undefined];
  const position = trail.indexOf(search.cursor);
  if (list.error instanceof IdentityError && list.error.status === 401)
    return <SignInRedirect />;
  const status = list.error instanceof IdentityError ? list.error.status : 0;
  const error: OrdersError | undefined = !list.error
    ? undefined
    : [403, 404].includes(status)
      ? 'access'
      : status === 400
        ? 'page'
        : 'unavailable';
  const change = (next: OrdersSearch) =>
    void navigate({ search: next, resetScroll: false });
  const sources = connections.data?.map((item) => ({
    id: item.id,
    label: item.label,
  })) ?? [
    ...new Map(
      (list.data?.items ?? []).flatMap((item) =>
        item.sources.map((source) => [
          source.connectionId,
          { id: source.connectionId, label: source.label },
        ]),
      ),
    ).values(),
  ];

  return (
    <OrdersView
      organizationId={organizationId}
      search={search}
      list={error === 'access' ? undefined : list.data}
      loading={list.isPending}
      refreshing={list.isFetching}
      offline={!online}
      error={error}
      sources={sources}
      change={change}
      refresh={() => void list.refetch()}
      next={
        list.data?.nextCursor
          ? () => {
              const cursor = list.data.nextCursor!;
              if (position >= 0)
                setTrails((previous) => ({
                  ...previous,
                  [filterKey]: [...trail.slice(0, position + 1), cursor],
                }));
              change({ ...search, cursor, page: (search.page ?? 1) + 1 });
            }
          : undefined
      }
      previous={
        position > 0
          ? () =>
              change({
                ...search,
                cursor: trail[position - 1],
                page: Math.max(1, (search.page ?? 1) - 1),
              })
          : undefined
      }
    />
  );
}

function SortHeader({
  label,
  sort,
  search,
  change,
  className,
}: {
  label: string;
  sort: NonNullable<OrdersSearch['sort']>;
  search: OrdersSearch;
  change: (next: OrdersSearch) => void;
  className?: string;
}) {
  const active = (search.sort ?? 'updated') === sort;
  const direction = search.direction ?? 'desc';

  return (
    <th
      scope="col"
      className={className}
      aria-sort={
        active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'
      }
    >
      <button
        type="button"
        className="orders-sort"
        onClick={() =>
          change({
            ...orderFilters(search),
            sort,
            direction: active && direction === 'desc' ? 'asc' : 'desc',
          })
        }
      >
        {label}
        {active ? (
          direction === 'asc' ? (
            <ArrowUp size={13} aria-hidden="true" />
          ) : (
            <ArrowDown size={13} aria-hidden="true" />
          )
        ) : (
          <ArrowUpDown size={13} aria-hidden="true" />
        )}
      </button>
    </th>
  );
}

function OrderRow({
  order,
  organizationId,
  search,
}: {
  order: OrderListItem;
  organizationId: string;
  search: OrdersSearch;
}) {
  const total = formatMoney(order.total);
  const updated = order.sourceUpdatedAt ?? order.observedAt;

  return (
    <tr>
      <th scope="row">
        <Link
          className="orders-row-link"
          to="/app/$organizationId/orders/$orderId"
          params={{ organizationId, orderId: order.id }}
          search={search}
        >
          {orderLabel(order)}
        </Link>
        <span className="orders-row-flags">
          {order.issueIds.length ? (
            <StatePill state="attention">Needs you</StatePill>
          ) : null}
          {order.overdue ? <Badge tone="danger">Overdue</Badge> : null}
          {order.differs ? (
            <Badge tone="warning">Differs by source</Badge>
          ) : null}
        </span>
      </th>
      <td className="orders-optional">
        {order.placedAt ? <WorkspaceDate value={order.placedAt} /> : '—'}
      </td>
      <td>
        <span className="orders-cell-stack">
          <span>{statusLabels[order.status] ?? order.status}</span>
          <small>
            {paymentLabels[order.paymentStatus] ?? order.paymentStatus}
          </small>
        </span>
      </td>
      <td>{fulfillmentLabel(order)}</td>
      <td className="orders-number">{total ?? '—'}</td>
      <td className="orders-optional">
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
      </td>
      <td className="orders-optional">
        <WorkspaceDate value={updated} />
      </td>
    </tr>
  );
}

/** Presents the searchable order list with its loading, empty, error, offline and paging states. */
export function OrdersView({
  organizationId,
  search,
  list,
  loading = false,
  refreshing = false,
  offline = false,
  error,
  sources,
  change,
  refresh,
  next,
  previous,
}: {
  organizationId: string;
  search: OrdersSearch;
  list?: OrderList | undefined;
  loading?: boolean;
  refreshing?: boolean;
  offline?: boolean;
  error?: OrdersError | undefined;
  sources: { id: string; label: string }[];
  change: (next: OrdersSearch) => void;
  refresh: () => void;
  next?: (() => void) | undefined;
  previous?: (() => void) | undefined;
}) {
  const [draft, setDraft] = useState(search.q ?? '');
  const [shownQuery, setShownQuery] = useState(search.q);
  // Links and history can change the query while the page stays mounted.
  if (shownQuery !== search.q) {
    setShownQuery(search.q);
    setDraft(search.q ?? '');
  }
  const filters = orderFilters(search);
  const update = (patch: Partial<OrdersSearch>) =>
    change(
      Object.fromEntries(
        Object.entries({ ...filters, ...patch }).filter(
          ([, value]) => value !== undefined && value !== '',
        ),
      ) as OrdersSearch,
    );
  const view = search.view ?? 'all';
  const source = (id: string) =>
    sources.find((item) => item.id === id)?.label ?? 'One source';
  const chips = [
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
  const filtered = chips.length > 0 || view !== 'all';

  return (
    <main className="orders-page">
      <PageHeader
        title="Orders"
        icon={<DomainIcon domain="orders" size="md" />}
        description="Search current orders from your connected stores and ERPs, see what still needs work, and inspect the source facts behind each order."
      />
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
        filters={chips.map((chip) => ({
          key: chip.key,
          label: chip.label,
          onRemove: () => {
            if (chip.key === 'q') setDraft('');
            update(
              chip.key === 'updated'
                ? { updatedFrom: undefined, updatedBefore: undefined }
                : { [chip.key]: undefined },
            );
          },
        }))}
        onClear={() => {
          setDraft('');
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
            onChange={(event) => setDraft(event.target.value)}
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
          onValueChange={(value) =>
            update({ connectionId: value || undefined })
          }
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
            (search.direction ?? 'desc') === 'desc'
              ? 'Sorted newest or highest first. Sort ascending'
              : 'Sorted oldest or lowest first. Sort descending'
          }
          title="Change sort direction"
          onClick={() =>
            update({
              direction:
                (search.direction ?? 'desc') === 'desc' ? 'asc' : undefined,
            })
          }
        >
          {(search.direction ?? 'desc') === 'desc' ? (
            <ArrowDown aria-hidden="true" />
          ) : (
            <ArrowUp aria-hidden="true" />
          )}
        </Button>
      </CollectionToolbar>
      <p className="orders-coverage">
        {viewDescriptions[view]} Orders appear as Luma reads them from each
        source. Totals, placed dates and SKU text show once a source reports
        them.
      </p>
      {offline ? (
        <Alert role="status">
          You are offline. Reconnect to refresh orders.
        </Alert>
      ) : null}
      {error === 'access' ? (
        <Alert tone="danger" role="alert">
          You no longer have access to orders in this workspace.
        </Alert>
      ) : error === 'page' ? (
        <Alert role="alert">
          This page link no longer matches the order filters.{' '}
          <Button variant="outline" onClick={() => update({})}>
            Start from the first page
          </Button>
        </Alert>
      ) : error ? (
        <Alert tone="danger" role="alert">
          Orders could not be loaded.
          {list ? ' The list below may be out of date.' : ''}{' '}
          <Button variant="outline" onClick={refresh}>
            Retry
          </Button>
        </Alert>
      ) : null}
      {list ? (
        list.items.length ? (
          <>
            <div className="orders-table-wrap">
              <table className="orders-table">
                <caption className="sr-only">
                  {viewLabels[view]}, sorted by{' '}
                  {sortLabels[search.sort ?? 'updated'].toLowerCase()}
                </caption>
                <thead>
                  <tr>
                    <SortHeader
                      label="Order"
                      sort="number"
                      search={search}
                      change={change}
                    />
                    <SortHeader
                      label="Placed"
                      sort="placed"
                      search={search}
                      change={change}
                      className="orders-optional"
                    />
                    <th scope="col">Status</th>
                    <th scope="col">Fulfillment</th>
                    <th scope="col" className="orders-number">
                      Total
                    </th>
                    <th scope="col" className="orders-optional">
                      Sources
                    </th>
                    <SortHeader
                      label="Updated"
                      sort="updated"
                      search={search}
                      change={change}
                      className="orders-optional"
                    />
                  </tr>
                </thead>
                <tbody>
                  {list.items.map((order) => (
                    <OrderRow
                      key={order.id}
                      order={order}
                      organizationId={organizationId}
                      search={search}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              count={list.items.length}
              totalCount={list.totalCount}
              page={search.page ?? 1}
              pageSize={orderPageSize}
              hasNext={!!next}
              onPrevious={previous}
              onNext={() => next?.()}
              disabled={refreshing}
              itemLabel="orders"
              label="Order pages"
            />
            {search.cursor && !previous ? (
              <Button variant="ghost" onClick={() => update({})}>
                Return to first page
              </Button>
            ) : null}
          </>
        ) : (
          <Empty className="orders-empty">
            <PackageSearch size={30} aria-hidden="true" />
            <h2>{filtered ? 'No orders match' : 'No orders yet'}</h2>
            <p>
              {filtered
                ? 'Try another search, view or filter. Orders a source has not reported yet do not appear.'
                : 'Orders appear here once a connected store or ERP reports them.'}
            </p>
            {filtered ? (
              <Button
                variant="outline"
                onClick={() => {
                  setDraft('');
                  change({});
                }}
              >
                Clear filters
              </Button>
            ) : (
              <Link
                className="orders-empty-link"
                to="/app/$organizationId/apps"
                params={{ organizationId }}
              >
                Connect a store or ERP
              </Link>
            )}
          </Empty>
        )
      ) : loading && !error ? (
        <div className="orders-loading" role="status">
          <span className="sr-only">Loading orders…</span>
          {Array.from({ length: 6 }, (_, index) => (
            <span key={index} className="lu-skeleton" />
          ))}
        </div>
      ) : null}
    </main>
  );
}

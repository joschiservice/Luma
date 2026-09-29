import './orders.css';

import type { OrderList } from '@luma/api-contract';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { DomainIcon } from '@luma/ui/components/primitives/domain-icon';
import { Empty } from '@luma/ui/components/primitives/empty';
import { Pagination } from '@luma/ui/components/primitives/pagination';
import { WorkspaceTimezone } from '@luma/ui/components/primitives/workspace-date';
import { PageHeader } from '@luma/ui/components/workspace/page-header';
import { onlineManager, useQuery } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { PackageSearch } from 'lucide-react';
import { useContext, useState, useSyncExternalStore } from 'react';

import { connectionsOptions } from '../connections/data';
import { SignInRedirect } from '../identity/common';
import { IdentityError } from '../identity/data';
import {
  orderFilters,
  orderListError,
  orderPageSize,
  type OrdersError,
  ordersOptions,
  type OrdersSearch,
} from './data';
import {
  orderFilterChips,
  OrderFilters,
  type OrderSource,
} from './list-filters';
import { OrdersTable } from './list-table';
import { viewDescriptions } from './presentation';

const subscribe = (changed: () => void) => onlineManager.subscribe(changed);
const onlineSnapshot = () => onlineManager.isOnline();
const serverSnapshot = () => true;

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
  const error = orderListError(list.error, search);
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
      list={error?.kind === 'access' ? undefined : list.data}
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
  sources: OrderSource[];
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
  const filtered =
    orderFilterChips(search, sources).length > 0 || view !== 'all';

  return (
    <main className="orders-page">
      <PageHeader
        title="Orders"
        icon={<DomainIcon domain="orders" size="md" />}
        description="Search current orders from your connected stores and ERPs, see what still needs work, and inspect the source facts behind each order."
      />
      <OrderFilters
        search={search}
        sources={sources}
        draft={draft}
        onDraftChange={setDraft}
        update={update}
        change={change}
        refresh={refresh}
        refreshing={refreshing}
      />
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
      {error?.kind === 'access' ? (
        <Alert tone="danger" role="alert">
          You no longer have access to orders in this workspace.
        </Alert>
      ) : error?.kind === 'page' ? (
        <Alert role="alert">
          {error.message ??
            'This page link no longer matches the order filters.'}{' '}
          <Button variant="outline" onClick={() => update({})}>
            Go to the first page
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
        <>
          <OrdersTable
            organizationId={organizationId}
            search={search}
            items={list.items}
            change={change}
            empty={
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
            }
          />
          {list.items.length ? (
            <Pagination
              count={list.items.length}
              totalCount={list.totalCount ?? undefined}
              page={search.page ?? 1}
              pageSize={orderPageSize}
              hasNext={!!next}
              onPrevious={previous}
              onNext={() => next?.()}
              disabled={refreshing}
              itemLabel="orders"
              label="Order pages"
            />
          ) : null}
          {list.items.length && search.cursor && !previous ? (
            <Button variant="ghost" onClick={() => update({})}>
              Return to first page
            </Button>
          ) : null}
        </>
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

import './orders.css';

import type { OrderList } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { Empty } from '@luma/ui/components/primitives/empty';
import { Pagination } from '@luma/ui/components/primitives/pagination';
import { WorkspaceTimezone } from '@luma/ui/components/primitives/workspace-date';
import { PageTitle } from '@luma/ui/components/workspace/page-header';
import { onlineManager, useQuery } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { PackageSearch } from 'lucide-react';
import {
  type ReactNode,
  useContext,
  useState,
  useSyncExternalStore,
} from 'react';

import { connectionsOptions } from '../../kit/connections/data';
import { SignInRedirect } from '../../kit/identity/common';
import { IdentityError } from '../../kit/identity/data';
import { SyncCoverage } from '../sync/coverage';
import {
  orderFilters,
  orderListError,
  orderPageSize,
  type OrdersError,
  ordersOptions,
  type OrdersSearch,
} from './data';
import { orderFiltered, OrderFilters, type OrderSource } from './list-filters';
import { OrdersTable } from './list-table';

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
      coverage={<SyncCoverage organizationId={organizationId} type="orders" />}
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
  coverage,
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
  /** Which sources and dates the list covers. */
  coverage?: ReactNode;
}) {
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
  const filtered = orderFiltered(search) || view !== 'all';

  return (
    <main className="orders-page">
      <PageTitle title={m.orders_page_title()} />
      <OrderFilters
        search={search}
        sources={sources}
        update={update}
        change={change}
        refresh={refresh}
        refreshing={refreshing}
      />
      {coverage}
      {offline ? <Alert role="status">{m.orders_list_offline()}</Alert> : null}
      {error?.kind === 'access' ? (
        <Alert tone="danger" role="alert">
          {m.orders_access_lost()}
        </Alert>
      ) : error?.kind === 'page' ? (
        <Alert role="alert">
          {error.message ?? m.orders_list_page_mismatch()}{' '}
          <Button variant="outline" onClick={() => update({})}>
            {m.orders_list_first_page()}
          </Button>
        </Alert>
      ) : error ? (
        <Alert tone="danger" role="alert">
          {list ? m.orders_list_refresh_failed() : m.orders_list_load_failed()}{' '}
          <Button variant="outline" onClick={refresh}>
            {m.common_retry()}
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
                <h2>
                  {filtered
                    ? m.orders_list_unmatched_title()
                    : m.orders_list_empty_title()}
                </h2>
                <p>
                  {filtered
                    ? m.orders_list_unmatched_body()
                    : m.orders_list_empty_body()}
                </p>
                {filtered ? (
                  <Button variant="outline" onClick={() => change({})}>
                    {m.common_clear_filters()}
                  </Button>
                ) : (
                  <Link
                    className="orders-empty-link"
                    to="/app/$organizationId/apps"
                    params={{ organizationId }}
                  >
                    {m.orders_list_connect()}
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
              formatTotal={(count) => m.orders_list_pagination_total({ count })}
              label={m.orders_list_pagination_label()}
            />
          ) : null}
          {list.items.length && search.cursor && !previous ? (
            <Button variant="ghost" onClick={() => update({})}>
              {m.orders_list_first_page()}
            </Button>
          ) : null}
        </>
      ) : loading && !error ? (
        <div className="orders-loading" role="status">
          <span className="sr-only">{m.orders_list_loading()}</span>
          {Array.from({ length: 6 }, (_, index) => (
            <span key={index} className="lu-skeleton" />
          ))}
        </div>
      ) : null}
    </main>
  );
}

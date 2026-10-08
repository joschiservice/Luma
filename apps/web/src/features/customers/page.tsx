import './customers.css';

import {
  type CustomerList,
  type CustomerListItem,
  type CustomerSort,
  customerSortSchema,
  customerStateSchema,
} from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { CollectionToolbar } from '@luma/ui/components/primitives/collection-toolbar';
import {
  DataTable,
  type DataTableColumn,
  DataTableRowLink,
} from '@luma/ui/components/primitives/data-table';
import { Empty } from '@luma/ui/components/primitives/empty';
import { Pagination } from '@luma/ui/components/primitives/pagination';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { PageTitle } from '@luma/ui/components/workspace/page-header';
import { onlineManager, useQuery } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { Plug, Search, UserRound, UsersRound } from 'lucide-react';
import {
  type ReactNode,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react';

import { SignInRedirect } from '../identity/common';
import { IdentityError } from '../identity/data';
import { formatMoney } from '../orders/presentation';
import { SyncCoverage } from '../sync/coverage';
import {
  customerFilters,
  customerListQuery,
  customerPageSize,
  customersOptions,
  customerSourceOptions,
  type CustomersSearch,
} from './data';
import {
  accessMessage,
  customerName,
  sortLabels,
  stateDescriptions,
  stateLabels,
} from './presentation';

const subscribe = (changed: () => void) => onlineManager.subscribe(changed);
const onlineSnapshot = () => onlineManager.isOnline();
const serverSnapshot = () => true;

/**
 * Connects the customer list to workspace-scoped queries. Filters and sorting live in the URL;
 * search text is personal data and stays in page state.
 */
export function CustomersPage() {
  const { organizationId } = useParams({
    from: '/app/$organizationId/customers/',
  });
  const search = useSearch({ from: '/app/$organizationId/customers/' });
  const navigate = useNavigate({ from: '/app/$organizationId/customers/' });
  const [q, setQ] = useState('');
  const query = useQuery(customersOptions(organizationId, search, q));
  const link =
    search.connectionId && search.customerId
      ? { connectionId: search.connectionId, externalId: search.customerId }
      : null;
  const resolved = useQuery({
    ...customerSourceOptions(
      organizationId,
      link?.connectionId ?? '',
      link?.externalId ?? '',
    ),
    enabled: !!link,
  });
  const online = useSyncExternalStore(
    subscribe,
    onlineSnapshot,
    serverSnapshot,
  );
  const [trails, setTrails] = useState<Record<string, (string | undefined)[]>>(
    {},
  );
  const resolvedId = link ? resolved.data : null;
  useEffect(() => {
    if (resolvedId)
      void navigate({
        to: '/app/$organizationId/customers/$customerId',
        params: { organizationId, customerId: resolvedId },
        replace: true,
      });
  }, [navigate, organizationId, resolvedId]);
  const filterKey = JSON.stringify([customerFilters(search), q.trim()]);
  const trail = trails[filterKey] ?? [undefined];
  const index = trail.indexOf(search.cursor);
  if (
    [query.error, resolved.error].some(
      (error) => error instanceof IdentityError && error.status === 401,
    )
  )
    return <SignInRedirect />;
  const change = (next: CustomersSearch) =>
    void navigate({ search: next, resetScroll: false });

  return (
    <CustomersView
      organizationId={organizationId}
      coverage={
        <SyncCoverage organizationId={organizationId} type="customers" />
      }
      search={search}
      q={q}
      setQ={(value) => {
        setQ(value);
        change(customerFilters(search));
      }}
      list={query.isError ? undefined : query.data}
      stale={query.isError ? query.data : undefined}
      loading={query.isPending}
      error={
        query.error instanceof IdentityError && query.error.status === 403
          ? 'access'
          : query.error?.message
      }
      offline={!online}
      refreshing={query.isFetching}
      unresolved={!!link && resolved.data === null}
      page={index >= 0 ? index + 1 : undefined}
      change={change}
      next={
        query.data?.nextCursor
          ? () => {
              const cursor = query.data.nextCursor!;
              if (index >= 0)
                setTrails((previous) => ({
                  ...previous,
                  [filterKey]: [...trail.slice(0, index + 1), cursor],
                }));
              change({ ...customerFilters(search), cursor });
            }
          : undefined
      }
      previous={
        index > 0
          ? () =>
              change({ ...customerFilters(search), cursor: trail[index - 1] })
          : undefined
      }
      refresh={() => void query.refetch()}
    />
  );
}

function customerColumns(
  organizationId: string,
  list: CustomerList,
): DataTableColumn<CustomerListItem, CustomerSort>[] {
  const sharing = list.sources.filter((source) => source.access === 'granted');
  const sourceLabel = (connectionId: string) =>
    list.sources.find((source) => source.connectionId === connectionId)
      ?.label ?? m.customers_source_fallback();

  return [
    {
      key: 'customer',
      header: m.customers_column_customer(),
      sortKey: 'name',
      cell: (item) => {
        const details = [
          !item.shared.contact
            ? m.customers_contact_not_shared()
            : item.displayName && item.email
              ? item.email
              : null,
          sharing.length > 1 ? sourceLabel(item.connectionId) : null,
        ].filter(Boolean);

        return (
          <div className="customers-cell">
            <DataTableRowLink
              render={
                <Link
                  to="/app/$organizationId/customers/$customerId"
                  params={{ organizationId, customerId: item.id }}
                />
              }
            >
              {customerName(item)}
            </DataTableRowLink>
            {details.length ? <small>{details.join(' · ')}</small> : null}
          </div>
        );
      },
    },
    {
      key: 'orders',
      header: m.customers_column_orders(),
      sortKey: 'orders',
      numeric: true,
      cell: (item) =>
        item.orderCount === null ? (
          <span className="customers-muted">{m.common_empty_value()}</span>
        ) : (
          formatNumber(item.orderCount)
        ),
    },
    {
      key: 'spent',
      header: m.customers_column_spent(),
      numeric: true,
      cell: (item) =>
        formatMoney(item.amountSpent) ?? (
          <span className="customers-muted">{m.common_empty_value()}</span>
        ),
    },
    {
      key: 'since',
      header: m.customers_column_since(),
      sortKey: 'created',
      hideOnNarrow: true,
      cell: (item) =>
        item.sourceCreatedAt ? (
          <WorkspaceDate value={item.sourceCreatedAt} precision="day" />
        ) : (
          <span className="customers-muted">{m.common_not_reported()}</span>
        ),
    },
    {
      key: 'account',
      header: m.customers_column_account(),
      hideOnNarrow: true,
      cell: (item) => (
        <span title={stateDescriptions[item.state]}>
          {stateLabels[item.state]}
        </span>
      ),
    },
  ];
}

/** Presents imported customers with search, filters, source access, paging and every list state. */
export function CustomersView({
  organizationId,
  search,
  q,
  setQ,
  list,
  stale,
  loading = false,
  error,
  offline = false,
  refreshing = false,
  unresolved = false,
  page,
  change,
  refresh,
  next,
  previous,
  coverage,
}: {
  organizationId: string;
  search: CustomersSearch;
  /** Search text; kept out of the URL because it may contain names or email addresses. */
  q: string;
  setQ: (q: string) => void;
  list?: CustomerList | undefined;
  /** The last loaded page, shown read-only after a failed refresh. */
  stale?: CustomerList | undefined;
  loading?: boolean;
  /** `access` when the reader can no longer view customers. */
  error?: string | undefined;
  offline?: boolean;
  refreshing?: boolean;
  /** A source customer link points at a customer Luma has not imported. */
  unresolved?: boolean;
  /** One-based page number, when known. */
  page?: number | undefined;
  change: (search: CustomersSearch) => void;
  refresh: () => void;
  next?: (() => void) | undefined;
  previous?: (() => void) | undefined;
  /** Which sources the list covers. */
  coverage?: ReactNode;
}) {
  const filters = customerFilters(search);
  const update = (patch: Partial<CustomersSearch>) =>
    change({ ...filters, ...patch });
  const shown = list ?? stale;
  const sources = shown?.sources ?? [];
  const sharing = sources.filter((source) => source.access === 'granted');
  const notices = sources.flatMap((source) => {
    const message = accessMessage(source);

    return message ? [{ id: source.connectionId, message }] : [];
  });
  // Only sources that share customers are offered; a linked source stays readable as a chip.
  const sourceOptions = (sharing.length > 1 ? sharing : []).map((source) => ({
    value: source.connectionId,
    label: source.label,
  }));
  if (
    search.connectionId &&
    !sourceOptions.some((option) => option.value === search.connectionId)
  )
    sourceOptions.push({
      value: search.connectionId,
      label:
        sources.find((source) => source.connectionId === search.connectionId)
          ?.label ?? m.customers_source_selected(),
    });
  const { sort, direction } = customerListQuery(search);
  const filtered = !!(q.trim() || search.state || search.connectionId);
  const clear = () => {
    setQ('');
    change({ sort: search.sort, direction: search.direction });
  };
  const sortBy = (key: CustomerSort, order: 'asc' | 'desc') =>
    update({
      sort: key === 'created' ? undefined : key,
      direction:
        order === (key === 'name' ? 'asc' : 'desc') ? undefined : order,
    });

  return (
    <main className="customers-page">
      <PageTitle title={m.customers_page_title()} />
      <CollectionToolbar
        search={{
          value: q || undefined,
          onChange: (value) => setQ(value ?? ''),
          label: m.customers_list_search_label(),
          placeholder: m.customers_list_search_placeholder(),
        }}
        filters={[
          {
            kind: 'choice',
            key: 'state',
            label: m.customers_filter_account(),
            icon: UserRound,
            value: search.state,
            options: customerStateSchema.options.map((value) => ({
              value,
              label: stateLabels[value],
            })),
            onChange: (value) =>
              update({
                state: customerStateSchema.options.find(
                  (item) => item === value,
                ),
              }),
          },
          {
            kind: 'choice',
            key: 'connectionId',
            label: m.customers_filter_source(),
            icon: Plug,
            value: search.connectionId,
            options: sourceOptions,
            onChange: (connectionId) => update({ connectionId }),
          },
        ]}
        sort={{
          value: sort,
          options: customerSortSchema.options.map((value) => ({
            value,
            label: sortLabels[value],
          })),
          onChange: (value) => {
            const key = customerSortSchema.options.find(
              (item) => item === value,
            );
            if (key) sortBy(key, key === 'name' ? 'asc' : 'desc');
          },
          direction,
          onDirectionChange: (order) => sortBy(sort, order),
        }}
        onClear={clear}
        onRefresh={refresh}
        refreshing={refreshing}
        refreshLabel={m.customers_list_refresh()}
      />
      {coverage}
      {unresolved ? (
        <Alert tone="info" role="status">
          <p>{m.customers_list_unresolved()}</p>
          <Button
            variant="outline"
            onClick={() =>
              change({ sort: search.sort, direction: search.direction })
            }
          >
            {m.customers_list_show_all()}
          </Button>
        </Alert>
      ) : null}
      {notices.map((notice) => (
        <Alert key={notice.id} tone="info">
          <p>{notice.message}</p>
          <Link
            to="/app/$organizationId/connections"
            params={{ organizationId }}
          >
            {m.customers_review_connections()}
          </Link>
        </Alert>
      ))}
      {offline ? (
        <Alert role="status">{m.customers_list_offline()}</Alert>
      ) : null}
      {error === 'access' ? (
        <Alert tone="danger" role="alert">
          {m.customers_access_lost()}
        </Alert>
      ) : error ? (
        <Alert tone="danger" role="alert">
          {stale
            ? m.customers_list_refresh_failed()
            : `${m.customers_list_load_failed()} ${error}`}{' '}
          <Button variant="outline" onClick={refresh}>
            {m.common_retry()}
          </Button>
          {search.cursor ? (
            <Button variant="ghost" onClick={() => update({})}>
              {m.customers_list_first_page()}
            </Button>
          ) : null}
        </Alert>
      ) : null}
      {shown && error !== 'access' ? (
        <>
          <DataTable
            caption={m.customers_list_caption({ sort: sortLabels[sort] })}
            columns={customerColumns(organizationId, shown)}
            rows={shown.items}
            rowKey={(item) => item.id}
            sort={{ key: sort, direction }}
            firstSortDirection="desc"
            onSortChange={(next) => sortBy(next.key, next.direction)}
            empty={
              <CustomersEmpty
                organizationId={organizationId}
                list={shown}
                filtered={filtered}
                clear={clear}
              />
            }
          />
          {shown.items.length ? (
            <Pagination
              count={shown.items.length}
              totalCount={shown.totalCount}
              page={page}
              pageSize={customerPageSize}
              hasNext={!!next}
              onPrevious={previous}
              onNext={() => next?.()}
              disabled={refreshing}
              formatTotal={(count) =>
                m.customers_list_pagination_total({ count })
              }
              label={m.customers_list_pagination_label()}
            />
          ) : null}
          {shown.items.length && search.cursor && !previous ? (
            <Button variant="ghost" onClick={() => update({})}>
              {m.customers_list_first_page()}
            </Button>
          ) : null}
        </>
      ) : loading && !error ? (
        <div className="customers-loading" role="status">
          <span className="sr-only">{m.customers_list_loading()}</span>
          {Array.from({ length: 6 }, (_, i) => (
            <span className="lu-skeleton" key={i} />
          ))}
        </div>
      ) : null}
    </main>
  );
}

/** Explains an empty list: no match, nothing shared yet, still importing, or no customers. */
function CustomersEmpty({
  organizationId,
  list,
  filtered,
  clear,
}: {
  organizationId: string;
  list: CustomerList;
  filtered: boolean;
  clear: () => void;
}) {
  if (filtered)
    return (
      <Empty>
        <Search size={30} aria-hidden="true" />
        <h2>{m.customers_empty_unmatched_title()}</h2>
        <p>{m.customers_empty_unmatched_body()}</p>
        <Button onClick={clear} variant="outline">
          {m.common_clear_filters()}
        </Button>
      </Empty>
    );
  const sharing = list.sources.some((source) => source.access === 'granted');
  const importing = list.sources.some(
    (source) => source.access === 'granted' && source.importing,
  );

  return (
    <Empty>
      <UsersRound size={30} aria-hidden="true" />
      <h2>
        {!sharing
          ? m.customers_empty_not_shared_title()
          : importing
            ? m.customers_empty_importing_title()
            : m.customers_empty_title()}
      </h2>
      <p>
        {!sharing
          ? m.customers_empty_not_shared_body()
          : importing
            ? m.customers_empty_importing_body()
            : m.customers_empty_body()}
      </p>
      <Link
        to={
          sharing
            ? '/app/$organizationId/sync'
            : '/app/$organizationId/connections'
        }
        params={{ organizationId }}
      >
        {sharing
          ? m.customers_open_data_sync()
          : m.customers_review_connections()}
      </Link>
    </Empty>
  );
}

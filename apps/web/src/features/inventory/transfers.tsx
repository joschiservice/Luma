import './inventory.css';

import {
  collectionWhereIssues,
  transfersCatalog,
  type TransferSummary,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import {
  type CollectionSort,
  CollectionToolbar,
} from '@luma/ui/components/primitives/collection-toolbar';
import { Empty } from '@luma/ui/components/primitives/empty';
import { Pagination } from '@luma/ui/components/primitives/pagination';
import { RefreshButton } from '@luma/ui/components/primitives/refresh-button';
import {
  listShortcutGroup,
  ShortcutHelp,
} from '@luma/ui/components/primitives/shortcut-help';
import { WorkspaceTimezone } from '@luma/ui/components/primitives/workspace-date';
import { PageTitle } from '@luma/ui/components/workspace/page-header';
import { type ListShortcut, useListKeyboard } from '@luma/ui/lib/list-keyboard';
import { useQuery } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { ArrowRightLeft } from 'lucide-react';
import { type ReactNode, type Ref, useContext, useRef, useState } from 'react';

import { useCollectionControls } from '../../kit/collections/controls';
import { DescribedFilter } from '../../kit/collections/described-filter';
import type { CatalogPresentation } from '../../kit/collections/fields';
import { sortOptions } from '../../kit/collections/fields';
import {
  CollectionLoading,
  CollectionNotices,
} from '../../kit/collections/notices';
import {
  type CollectionError,
  collectionError,
  collectionServerIssue,
  useCursorPaging,
  useOnline,
} from '../../kit/collections/paging';
import { repairedState } from '../../kit/collections/repair';
import type { CollectionSearch } from '../../kit/collections/state';
import { useCollectionView } from '../../kit/collections/use-collection-view';
import { CollectionViewBar } from '../../kit/collections/view-bar';
import { connectionsOptions } from '../../kit/connections/data';
import { SignInRedirect } from '../../kit/identity/common';
import { ApiError } from '../../kit/identity/data';
import { usePermissions } from '../../kit/identity/permissions';
import { SyncCoverage } from '../sync/coverage';
import {
  transferListQuery,
  transferOptions,
  transferPageSize,
  type TransferSearch,
  transfersOptions,
} from './data';
import { TransferDetailView } from './transfer-detail';
import { transferKey, transferLabels, TransferTable } from './transfer-table';

/** The list commands the Transfers page handles, for shortcut help. */
const shortcuts: readonly ListShortcut[] = [
  'next',
  'previous',
  'open',
  'escape',
  'search',
  'filter',
  'help',
];

/** The Sort menu's value for the newest requests first, which a view without a sort uses. */
const requestOrder = 'requested';

/** How the Transfers list names each catalog field. */
const transfersPresentation: CatalogPresentation = Object.fromEntries(
  Object.entries(transferLabels).map(([id, label]) => [id, { label }]),
);

/** Names a built-in Transfers view: transfers or receiving shipments. */
function transferSegmentLabel(segment: string) {
  return segment === 'inventory_shipment'
    ? m.inventory_transfer_shipments()
    : m.inventory_transfer_transfers();
}

/** Returns the list state without paging, so a list change starts on page one. */
function transferFilters(search: TransferSearch): TransferSearch {
  const filters = { ...search };
  delete filters.cursor;
  delete filters.page;

  return filters;
}

/**
 * Browses source transfers and receiving records without adding their quantities to stock: the
 * member's view with its conditions and sort from the URL and remembered state, the shared
 * toolbar and view bar, list keys and keyset paging with Previous.
 */
export function TransfersPage() {
  const { organizationId } = useParams({
    from: '/app/$organizationId/inventory/transfers/',
  });
  const search = useSearch({
    from: '/app/$organizationId/inventory/transfers/',
  });
  const navigate = useNavigate({
    from: '/app/$organizationId/inventory/transfers/',
  });
  const timeZone = useContext(WorkspaceTimezone);
  const permissions = usePermissions(organizationId);
  const can = permissions.can;
  const online = useOnline();
  const go = (next: TransferSearch) =>
    void navigate({ search: next, resetScroll: false });
  // Clearing conditions also clears search text and the SKU or location; other changes keep them.
  const keepQuery = useRef(true);
  const view = useCollectionView({
    catalog: transfersCatalog,
    organizationId,
    search,
    navigate: (next: Partial<CollectionSearch>) =>
      go({
        ...(keepQuery.current && search.q ? { q: search.q } : {}),
        ...(keepQuery.current && search.skuId ? { skuId: search.skuId } : {}),
        ...(keepQuery.current && search.locationId
          ? { locationId: search.locationId }
          : {}),
        ...next,
      }),
  });
  const state = view.state;
  const connections = useQuery(connectionsOptions(organizationId));
  const clientIssues = permissions.ready
    ? collectionWhereIssues(transfersCatalog, state.where)
    : [];
  const query = transferListQuery(state, search, timeZone);
  const list = useQuery({
    ...transfersOptions(organizationId, query),
    enabled: permissions.ready && !clientIssues.length,
  });
  const serverIssue = search.cursor
    ? undefined
    : collectionServerIssue(list.error);
  const data = list.data;
  const options = {
    connections: [
      ...new Map(
        [
          ...(connections.data ?? []).map((item) => ({
            value: item.id,
            label: item.label,
          })),
          ...(data?.items ?? []).map((item) => ({
            value: item.connectionId,
            label: item.label,
          })),
        ].map((option) => [option.value, option]),
      ).values(),
    ],
  };
  const controls = useCollectionControls({
    view,
    catalog: transfersCatalog,
    presentation: transfersPresentation,
    can,
    options,
    required: ['name'],
    title: 'name',
    serverIssues: serverIssue ? [serverIssue] : [],
  });
  const issues = [...clientIssues, ...(serverIssue ? [serverIssue] : [])];
  const repair = issues.length
    ? () => view.change(repairedState(transfersCatalog, state, issues, can))
    : undefined;
  const error: CollectionError | undefined = clientIssues.length
    ? { kind: 'invalid', message: m.collections_needs_repair() }
    : collectionError(list.error, search.cursor);
  const keys = (data?.items ?? []).map(transferKey);
  const paging = useCursorPaging({
    key: JSON.stringify([
      organizationId,
      view.key,
      query.kind,
      query.where,
      query.sort,
      query.direction,
      query.q,
      query.skuId,
      query.locationId,
    ]),
    cursor: search.cursor,
    page: search.page,
    nextCursor: data?.nextCursor,
    go: ({ cursor, page }) => go({ ...search, cursor, page }),
  });
  const searchInput = useRef<HTMLInputElement>(null);
  const rows = useRef<HTMLDivElement>(null);
  const [help, setHelp] = useState(false);
  const recordSearch = (item: TransferSummary) => ({
    ...transferFilters(search),
    cursor: search.cursor,
    page: search.page,
    connectionId: item.connectionId,
  });
  const keyboard = useListKeyboard({
    rows,
    count: keys.length,
    keys,
    onOpen: (index) => {
      const item = data?.items[index];
      if (item)
        void navigate({
          to: '/app/$organizationId/inventory/transfers/$transferId',
          params: { organizationId, transferId: item.id },
          search: recordSearch(item),
        });
    },
    onFocusSearch: () => searchInput.current?.focus(),
    onOpenFilter: () => controls.conditions.onOpenChange?.(true),
    onShowHelp: () => setHelp(true),
  });

  if (list.error instanceof ApiError && list.error.status === 401)
    return <SignInRedirect />;

  const segment = state.segment ?? 'inventory_transfer';
  const filtered =
    !!search.q ||
    !!search.skuId ||
    !!search.locationId ||
    state.where.conditions.length > 0;
  const clear = () => {
    keepQuery.current = false;
    controls.clearConditions();
    keepQuery.current = true;
  };
  const sort: CollectionSort = {
    value: state.sort?.field ?? requestOrder,
    options: [
      ...(view.base.sort
        ? []
        : [
            {
              value: requestOrder,
              label: m.inventory_transfer_sort_requested(),
            },
          ]),
      ...sortOptions(transfersCatalog, transfersPresentation, can),
    ],
    onChange: (field) =>
      view.change({
        ...state,
        sort:
          field === requestOrder
            ? null
            : { field, direction: state.sort?.direction ?? 'asc' },
      }),
    ...(state.sort
      ? {
          direction: state.sort.direction,
          onDirectionChange: (direction: 'asc' | 'desc') =>
            state.sort &&
            view.change({ ...state, sort: { ...state.sort, direction } }),
        }
      : {}),
  };
  const sortLabel =
    sort.options.find((option) => option.value === sort.value)?.label ??
    sort.value;
  const listError = error && error.kind !== 'invalid' ? error : undefined;
  const results =
    data && error?.kind !== 'access' && error?.kind !== 'invalid' ? (
      data.items.length ? (
        <TransferTable
          organizationId={organizationId}
          items={data.items}
          caption={m.inventory_transfer_caption({
            view: view.saved?.name ?? transferSegmentLabel(segment),
            sort: sortLabel,
          })}
          link={(item) => (
            <Link
              to="/app/$organizationId/inventory/transfers/$transferId"
              params={{ organizationId, transferId: item.id }}
              search={recordSearch(item)}
            />
          )}
          sort={
            state.sort
              ? { key: state.sort.field, direction: state.sort.direction }
              : undefined
          }
          onSortChange={(next) =>
            view.change({
              ...state,
              sort: { field: next.key, direction: next.direction },
            })
          }
          columnState={controls.columnState}
          onColumnStateChange={controls.onColumnStateChange}
          onColumnFilter={(key) => controls.filterBy(key)}
          density={state.density}
          focusedRowKey={keyboard.focusedKey}
        />
      ) : (
        <TransfersEmpty filtered={filtered} clear={clear} />
      )
    ) : null;

  return (
    <TransfersView
      organizationId={organizationId}
      toolbar={
        <CollectionToolbar
          views={
            <CollectionViewBar
              organizationId={organizationId}
              view={view}
              path="inventory/transfers"
              segmentLabel={transferSegmentLabel}
            />
          }
          search={{
            value: search.q,
            onChange: (q) =>
              go({ ...transferFilters(search), q: q || undefined }),
            label: m.inventory_transfer_search(),
            placeholder: m.inventory_transfer_search(),
            inputRef: searchInput,
          }}
          filters={[
            ...controls.filters,
            {
              kind: 'applied',
              key: 'skuId',
              label: m.inventory_filter_sku(),
              value: search.skuId ? m.inventory_selected_sku() : undefined,
              onRemove: () =>
                go({ ...transferFilters(search), skuId: undefined }),
            },
            {
              kind: 'applied',
              key: 'locationId',
              label: m.inventory_filter_location(),
              value: search.locationId
                ? m.inventory_selected_location()
                : undefined,
              onRemove: () =>
                go({ ...transferFilters(search), locationId: undefined }),
            },
          ]}
          conditions={controls.conditions}
          actions={
            <DescribedFilter
              organizationId={organizationId}
              domain="transfers"
              listName={m.inventory_transfer_title()}
              fields={controls.conditions.fields}
              apply={(conditions) =>
                view.change({
                  ...state,
                  where: {
                    match: state.where.match,
                    conditions: [...state.where.conditions, ...conditions],
                  },
                })
              }
            />
          }
          display={controls.display}
          sort={sort}
          onClear={clear}
          onRefresh={() => {
            void list.refetch();
            void connections.refetch();
          }}
          refreshing={list.isFetching}
          refreshLabel={m.inventory_transfer_refresh()}
        />
      }
      coverage={
        <SyncCoverage
          organizationId={organizationId}
          type={
            segment === 'inventory_shipment'
              ? 'inventory_shipments'
              : 'inventory_transfers'
          }
        />
      }
      notices={
        <CollectionNotices
          offline={!online}
          error={error?.kind === 'invalid' ? error : listError}
          hasRows={!!data?.items.length}
          retry={() => void list.refetch()}
          firstPage={() =>
            go({ ...search, cursor: undefined, page: undefined })
          }
          repair={repair}
        />
      }
      loading={!data && list.isPending && !error}
      results={results}
      pagination={
        data?.items.length ? (
          <>
            <Pagination
              count={data.items.length}
              totalCount={data.totalCount ?? undefined}
              page={paging.page}
              pageSize={transferPageSize}
              hasNext={!!paging.next}
              onPrevious={paging.previous}
              onNext={() => paging.next?.()}
              formatTotal={(count) =>
                m.inventory_transfer_pagination_total({ count })
              }
              label={m.inventory_transfer_pagination_label()}
            />
            {paging.first && !paging.previous ? (
              <Button variant="ghost" onClick={paging.first}>
                {m.inventory_list_first_page_button()}
              </Button>
            ) : null}
          </>
        ) : null
      }
      rowsRef={rows}
      help={
        <ShortcutHelp
          open={help}
          onOpenChange={setHelp}
          groups={[listShortcutGroup(shortcuts)]}
        />
      }
    />
  );
}

/** Explains an empty list: nothing synced for this record type, or nothing matching the filters. */
function TransfersEmpty({
  filtered,
  clear,
}: {
  filtered: boolean;
  clear: () => void;
}) {
  return (
    <Empty>
      <ArrowRightLeft size={30} aria-hidden="true" />
      <h2>
        {filtered
          ? m.inventory_transfer_unmatched_title()
          : m.inventory_transfer_empty()}
      </h2>
      <p>
        {filtered
          ? m.inventory_transfer_unmatched_body()
          : m.inventory_transfer_empty_body()}
      </p>
      {filtered ? (
        <Button onClick={clear} variant="outline">
          {m.common_clear_filters()}
        </Button>
      ) : null}
    </Empty>
  );
}

/**
 * Lays out the Transfers page in the shared list order: title, the way back to stock, toolbar,
 * coverage, notices, then the results with pagination.
 */
function TransfersView({
  organizationId,
  toolbar,
  coverage,
  notices,
  loading = false,
  results,
  pagination,
  rowsRef,
  help,
}: {
  organizationId: string;
  toolbar: ReactNode;
  /** Which sources the list covers. */
  coverage?: ReactNode;
  notices?: ReactNode;
  loading?: boolean;
  results?: ReactNode;
  pagination?: ReactNode;
  /** Contains the rows, for list keys. */
  rowsRef?: Ref<HTMLDivElement>;
  help?: ReactNode;
}) {
  return (
    <main className="inventory-page">
      <Link to="/app/$organizationId/inventory" params={{ organizationId }}>
        {m.inventory_transfer_stock()}
      </Link>
      <PageTitle title={m.inventory_transfer_title()} />
      <p className="inventory-note">{m.inventory_transfer_intro()}</p>
      {toolbar}
      {coverage}
      {notices}
      <div ref={rowsRef} className="inventory-results">
        {results ?? (loading ? <CollectionLoading /> : null)}
        {pagination}
      </div>
      {help}
    </main>
  );
}

/** Loads exact receiving evidence for the selected source rather than combining providers. */
export function TransferPage() {
  const { organizationId, transferId } = useParams({
    from: '/app/$organizationId/inventory/transfers/$transferId',
  });
  const search = useSearch({
    from: '/app/$organizationId/inventory/transfers/$transferId',
  });
  const query = useQuery(
    transferOptions(organizationId, transferId, search.connectionId),
  );
  const online = useOnline();
  if (query.error instanceof ApiError && query.error.status === 401)
    return <SignInRedirect />;
  // The list's view and page, without this record's source.
  const listSearch: TransferSearch = { ...search };
  delete listSearch.connectionId;
  const error = collectionError(query.error, undefined);

  return (
    <main className="inventory-page">
      <Link
        to="/app/$organizationId/inventory/transfers"
        params={{ organizationId }}
        search={listSearch}
      >
        {m.inventory_transfer_back()}
      </Link>
      {!online ? <Alert role="status">{m.inventory_offline()}</Alert> : null}
      {error?.kind === 'access' ? (
        <Alert role="alert" tone="danger">
          {m.inventory_transfer_unavailable_record()}
        </Alert>
      ) : error ? (
        <Alert role="alert" tone="danger">
          {query.data
            ? m.inventory_transfer_refresh_failed()
            : m.inventory_transfer_load_failed()}{' '}
          <Button variant="outline" onClick={() => void query.refetch()}>
            {m.common_retry()}
          </Button>
        </Alert>
      ) : null}
      {query.data ? (
        <TransferDetailView
          organizationId={organizationId}
          detail={query.data}
          actions={
            <RefreshButton
              label={m.inventory_list_refresh()}
              refreshing={query.isFetching}
              onClick={() => void query.refetch()}
            />
          }
        />
      ) : query.isPending && !error ? (
        <p role="status">{m.inventory_transfer_loading()}</p>
      ) : null}
    </main>
  );
}

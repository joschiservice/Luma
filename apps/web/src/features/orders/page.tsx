import './orders.css';

import {
  collectionField,
  type OrderListItem,
  ordersCatalog,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button, buttonVariants } from '@luma/ui/components/primitives/button';
import { CollectionPreview } from '@luma/ui/components/primitives/collection-preview';
import { CollectionToolbar } from '@luma/ui/components/primitives/collection-toolbar';
import { Empty } from '@luma/ui/components/primitives/empty';
import { Pagination } from '@luma/ui/components/primitives/pagination';
import {
  listShortcutGroup,
  ShortcutHelp,
} from '@luma/ui/components/primitives/shortcut-help';
import { WorkspaceTimezone } from '@luma/ui/components/primitives/workspace-date';
import { PageTitle } from '@luma/ui/components/workspace/page-header';
import {
  type CellFilterValue,
  type ConditionWhere,
  whereWithCellValue,
} from '@luma/ui/lib/collection-conditions';
import { type ListShortcut, useListKeyboard } from '@luma/ui/lib/list-keyboard';
import { selectRange } from '@luma/ui/lib/row-selection';
import { useQuery } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { Maximize2, PackageSearch } from 'lucide-react';
import { type ReactNode, type Ref, useContext, useRef, useState } from 'react';

import { useCollectionControls } from '../../kit/collections/controls';
import { DescribedFilter } from '../../kit/collections/described-filter';
import {
  CollectionLoading,
  CollectionNotices,
} from '../../kit/collections/notices';
import { useCursorPaging, useOnline } from '../../kit/collections/paging';
import { usePrivateSearch } from '../../kit/collections/private-search';
import { useRecordCollection } from '../../kit/collections/record-collection';
import { type CollectionSearch, viewParam } from '../../kit/collections/state';
import { useCollectionView } from '../../kit/collections/use-collection-view';
import { CollectionViewBar } from '../../kit/collections/view-bar';
import { connectionsOptions } from '../../kit/connections/data';
import { SignInRedirect } from '../../kit/identity/common';
import { ApiError } from '../../kit/identity/data';
import { usePermissions } from '../../kit/identity/permissions';
import { orderLabel } from '../../shared/orders/presentation';
import { CollectionBulkActions } from '../adaptive/bulk-actions';
import {
  adaptiveAvailabilityOptions,
  customFieldsOptions,
  customFieldValuesOptions,
} from '../adaptive/data';
import { customFieldColumns, customFieldText } from '../adaptive/presentation';
import { CollectionSummaryBand } from '../adaptive/summary-band';
import { fulfillmentsOptions } from '../fulfillment/data';
import { SyncCoverage } from '../sync/coverage';
import {
  orderGroupLabel,
  orderSegmentLabel,
  ordersPresentation,
} from './collection';
import {
  orderFilters,
  orderListQuery,
  orderPageSize,
  ordersOptions,
  type OrdersSearch,
} from './data';
import { orderColumnField } from './list-table';
import { OrderPreview } from './preview';
import { orderGroups, OrderResults } from './results';

/** The list commands the Orders page handles, for shortcut help. */
const shortcuts: readonly ListShortcut[] = [
  'next',
  'previous',
  'open',
  'preview',
  'toggle-selection',
  'extend-selection',
  'escape',
  'search',
  'filter',
  'help',
];

/**
 * The Orders list: the member's view with its conditions, sort, grouping and layout from the
 * URL and remembered state, the shared toolbar and view bar, list keys, an optional preview
 * pane and keyset paging. A filter change keeps the previous rows until the new ones arrive.
 * Search can match customer names and email addresses, so its text stays in page state; a
 * link's `?q=` is adopted and removed from the address.
 */
export function OrdersPage() {
  const { organizationId } = useParams({
    from: '/app/$organizationId/orders/',
  });
  const search = useSearch({ from: '/app/$organizationId/orders/' });
  const navigate = useNavigate({ from: '/app/$organizationId/orders/' });
  const timeZone = useContext(WorkspaceTimezone);
  const permissions = usePermissions(organizationId);
  const can = permissions.can;
  const online = useOnline();
  const go = (next: OrdersSearch) =>
    void navigate({ search: next, resetScroll: false });
  const view = useCollectionView({
    catalog: ordersCatalog,
    organizationId,
    search,
    navigate: (next: Partial<CollectionSearch>) =>
      go({
        ...(search.from ? { from: search.from } : {}),
        ...(search.item ? { item: search.item } : {}),
        ...next,
      }),
  });
  const state = view.state;
  // Naming the view keeps the remembered view from replacing the one the link opened.
  const [q, setQ] = usePrivateSearch(
    search.q,
    () =>
      void navigate({
        search: (current) => ({
          ...current,
          q: undefined,
          view: current.view ?? viewParam(view.key),
        }),
        replace: true,
        resetScroll: false,
      }),
  );

  const connections = useQuery(connectionsOptions(organizationId));
  const locations = useQuery({
    ...fulfillmentsOptions(organizationId, { view: 'open' }, 1),
    enabled: can('fulfillment.read'),
    staleTime: 5 * 60_000,
  });
  const availability = useQuery(adaptiveAvailabilityOptions(organizationId));
  const fields = useQuery({
    ...customFieldsOptions(organizationId, 'order'),
    enabled: !!availability.data?.fields && can('adaptive.fields.read'),
  });
  const custom = customFieldColumns(fields.data ?? []);

  const query = orderListQuery(state, { q, cursor: search.cursor }, timeZone);
  const {
    list,
    serverIssue,
    repair,
    error,
    grouping,
    collapsed,
    setCollapsed,
    more,
  } = useRecordCollection({
    catalog: ordersCatalog,
    view,
    permissions,
    cursor: search.cursor,
    list: ordersOptions(organizationId, query),
    resetKey: JSON.stringify([organizationId, query]),
    groupPage: (key, cursor) =>
      ordersOptions(
        organizationId,
        orderListQuery(state, { q, cursor: search.cursor }, timeZone, {
          key,
          cursor,
        }),
      ),
    customFields: { availability, definitions: fields, columns: custom },
    gatedFields: true,
  });
  const options = {
    connections: connections.data?.map((item) => ({
      value: item.id,
      label: item.label,
    })) ?? [
      ...new Map(
        (list.data?.items ?? []).flatMap((item) =>
          item.sources.map((source) => [
            source.connectionId,
            { value: source.connectionId, label: source.label },
          ]),
        ),
      ).values(),
    ],
    locations: (locations.data?.locations ?? []).map((location) => ({
      value: location.id,
      label: location.name ?? m.orders_location_unnamed(),
    })),
  };
  const currencies = [
    ...new Set(
      (list.data?.items ?? []).flatMap((item) =>
        item.total ? [item.total.currency] : [],
      ),
    ),
  ];
  const controls = useCollectionControls({
    view,
    catalog: ordersCatalog,
    presentation: ordersPresentation,
    can,
    options,
    currencies,
    custom,
    required: ['number'],
    title: 'number',
    preview: true,
    serverIssues: serverIssue ? [serverIssue] : [],
  });
  const data = list.data;
  const groups =
    data && grouping && data.groups ? orderGroups(data, grouping, more) : [];
  // Keys in the order rows appear on the page, so the list keys follow the screen.
  const keys = grouping
    ? groups
        .filter(
          (group) => state.layout === 'board' || !collapsed.includes(group.id),
        )
        .flatMap((group) => group.rows.map((row) => row.id))
    : (data?.items ?? []).map((row) => row.id);
  const rowsById = new Map(
    [...(data?.items ?? []), ...groups.flatMap((group) => group.rows)].map(
      (row) => [row.id, row],
    ),
  );
  // Custom field columns read the shown orders' values in one request per page.
  const customShown = custom.filter((field) =>
    controls.columns.includes(`custom:${field.id}`),
  );
  const customValues = useQuery({
    ...customFieldValuesOptions(organizationId, 'order', [...rowsById.keys()]),
    enabled:
      customShown.length > 0 && rowsById.size > 0 && state.layout !== 'board',
  });
  const extraColumns = customShown.map((field) => ({
    key: `custom:${field.id}`,
    header: field.label,
    hideOnNarrow: true,
    cell: (order: OrderListItem) =>
      field.archived
        ? m.collections_field_archived()
        : customFieldText(
            field,
            customValues.data?.values.find(
              (value) =>
                value.recordId === order.id && value.fieldId === field.id,
            )?.value,
          ),
  }));

  const paging = useCursorPaging({
    // Search text never enters browser storage; a new search starts on the first page.
    key: JSON.stringify([
      organizationId,
      view.key,
      query.view,
      query.where,
      query.sort,
      query.direction,
      !!query.q,
    ]),
    cursor: search.cursor,
    page: search.page,
    nextCursor: grouping ? null : data?.nextCursor,
    go: ({ cursor, page }) => go({ ...search, cursor, page }),
  });

  const searchInput = useRef<HTMLInputElement>(null);
  const rows = useRef<HTMLDivElement>(null);
  const [help, setHelp] = useState(false);
  // Selection belongs to one page of one view; changing either starts empty.
  const selectionKey = JSON.stringify([query, search.cursor]);
  const [selection, setSelection] = useState<{ key: string; ids: string[] }>({
    key: selectionKey,
    ids: [],
  });
  const selected = selection.key === selectionKey ? selection.ids : [];
  const setSelected = (next: string[] | ((current: string[]) => string[])) =>
    setSelection((current) => {
      const ids = current.key === selectionKey ? current.ids : [];

      return {
        key: selectionKey,
        ids: typeof next === 'function' ? next(ids) : next,
      };
    });
  const anchor = useRef<number>(-1);
  const previewOn = state.preview && state.layout !== 'board';
  const open = previewOn ? search.item : undefined;
  const setOpen = (item: string | undefined) => go({ ...search, item });
  const detailSearch = { ...search, item: undefined };
  const openOrder = (orderId: string) =>
    void navigate({
      to: '/app/$organizationId/orders/$orderId',
      params: { organizationId, orderId },
      search: detailSearch,
    });
  const keyboard = useListKeyboard({
    rows,
    count: keys.length,
    keys,
    preview: previewOn ? { open, onOpenChange: setOpen } : undefined,
    onOpen: (index) => {
      const key = keys[index];
      if (key) openOrder(key);
    },
    onToggleSelection: (index) => {
      const key = keys[index];
      if (!key) return;
      anchor.current = index;
      setSelected((current) =>
        current.includes(key)
          ? current.filter((item) => item !== key)
          : [...current, key],
      );
    },
    onExtendSelection: (index) => {
      const from = anchor.current < 0 ? index : anchor.current;
      const key = keys[index];
      if (!key) return;
      setSelected((current) =>
        selectRange(keys, current, from, index, !current.includes(key)),
      );
      anchor.current = index;
    },
    onEscape: () => {
      if (!selected.length) return false;
      setSelected([]);

      return true;
    },
    onFocusSearch: () => searchInput.current?.focus(),
    onOpenFilter: () => controls.conditions.onOpenChange?.(true),
    onShowHelp: () => setHelp(true),
  });

  if (list.error instanceof ApiError && list.error.status === 401)
    return <SignInRedirect />;

  const link = (order: OrderListItem) => (
    <Link
      id={`order-${order.id}`}
      to="/app/$organizationId/orders/$orderId"
      params={{ organizationId, orderId: order.id }}
      search={detailSearch}
      onClick={(event) => {
        if (!previewOn || event.metaKey || event.ctrlKey || event.shiftKey)
          return;
        event.preventDefault();
        setOpen(order.id);
      }}
    />
  );
  const filterValue = (
    field: string,
    value: CellFilterValue,
    exclude: boolean,
  ) => {
    const definition = collectionField(ordersCatalog, field);
    if (!definition?.filter) return;
    const where = whereWithCellValue(
      state.where as ConditionWhere,
      { id: field, type: definition.type, operators: definition.filter },
      value,
      exclude,
    );
    if (where) view.change({ ...state, where: where as typeof state.where });
  };
  const filtered =
    !!q ||
    state.where.conditions.length > 0 ||
    (state.segment ?? 'all') !== 'all';
  const viewName =
    view.saved?.name ?? orderSegmentLabel(state.segment ?? 'all');
  const sortLabel = state.sort
    ? (ordersPresentation[state.sort.field]?.label() ??
      custom.find((field) => `custom:${field.id}` === state.sort?.field)
        ?.label ??
      state.sort.field)
    : '';
  const shownOrder = open ? rowsById.get(open) : undefined;
  const hasRows = !!data && (data.items.length > 0 || groups.length > 0);
  const listError = error && error.kind !== 'invalid' ? error : undefined;

  const results =
    data && error?.kind !== 'access' && error?.kind !== 'invalid' ? (
      <OrderResults
        extraColumns={extraColumns}
        list={data}
        layout={state.layout}
        density={state.density}
        grouping={grouping}
        caption={m.orders_list_caption({ view: viewName, sort: sortLabel })}
        link={link}
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
              <Button
                variant="outline"
                onClick={() => {
                  setQ('');
                  view.reset();
                }}
              >
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
        onColumnFilter={(key) => controls.filterBy(orderColumnField(key))}
        properties={controls.properties}
        focusedKey={keyboard.focusedKey}
        current={open}
        selection={{ selected, onChange: setSelected }}
        groupLabel={(key) =>
          orderGroupLabel(
            grouping?.field ?? '',
            grouping?.granularity,
            key,
            options,
          )
        }
        collapsed={collapsed}
        onCollapsedChange={setCollapsed}
        more={more}
      />
    ) : null;

  return (
    <OrdersView
      toolbar={
        <CollectionToolbar
          views={
            <CollectionViewBar
              organizationId={organizationId}
              view={view}
              path="orders"
              segmentLabel={orderSegmentLabel}
              exportColumns={controls.columns.map((id) => ({
                id,
                label:
                  ordersPresentation[id]?.label() ??
                  custom.find((field) => `custom:${field.id}` === id)?.label ??
                  id,
              }))}
            />
          }
          search={{
            value: q || undefined,
            onChange: (text) => {
              setQ(text ?? '');
              go({
                ...orderFilters(search),
                ...(search.from ? { from: search.from } : {}),
                ...(search.item ? { item: search.item } : {}),
              });
            },
            label: m.orders_list_search_label(),
            placeholder: m.orders_list_search_placeholder(),
            inputRef: searchInput,
          }}
          filters={controls.filters}
          conditions={controls.conditions}
          actions={
            <DescribedFilter
              organizationId={organizationId}
              domain="orders"
              listName={m.orders_page_title()}
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
          sort={controls.sort}
          onClear={() => {
            setQ('');
            controls.clearConditions();
          }}
          onRefresh={() => {
            void list.refetch();
            void connections.refetch();
          }}
          refreshing={list.isFetching}
          refreshLabel={m.orders_list_refresh()}
        />
      }
      coverage={<SyncCoverage organizationId={organizationId} type="orders" />}
      summary={
        <CollectionSummaryBand organizationId={organizationId} view={view} />
      }
      actions={
        <CollectionBulkActions
          organizationId={organizationId}
          view={view}
          selected={selected}
          clear={() => setSelected([])}
        />
      }
      notices={
        <>
          <CollectionNotices
            offline={!online}
            error={error?.kind === 'invalid' ? error : listError}
            hasRows={hasRows}
            retry={() => void list.refetch()}
            firstPage={() =>
              go({ ...search, cursor: undefined, page: undefined })
            }
            repair={repair}
          />
          {data?.groupsTruncated ? (
            <Alert role="status">{m.collections_groups_truncated()}</Alert>
          ) : null}
        </>
      }
      loading={!data && list.isPending && !error}
      results={results}
      pagination={
        data && !grouping && data.items.length ? (
          <>
            <Pagination
              count={data.items.length}
              totalCount={data.totalCount ?? undefined}
              page={paging.page}
              pageSize={orderPageSize}
              hasNext={!!paging.next}
              onPrevious={paging.previous}
              onNext={() => paging.next?.()}
              formatTotal={(count) => m.orders_list_pagination_total({ count })}
              label={m.orders_list_pagination_label()}
            />
            {paging.first && !paging.previous ? (
              <Button variant="ghost" onClick={paging.first}>
                {m.orders_list_first_page()}
              </Button>
            ) : null}
          </>
        ) : null
      }
      rowsRef={rows}
      preview={
        previewOn
          ? {
              open: !!open,
              title: shownOrder ? orderLabel(shownOrder) : undefined,
              actions: open ? (
                <Link
                  to="/app/$organizationId/orders/$orderId"
                  params={{ organizationId, orderId: open }}
                  search={detailSearch}
                  className={buttonVariants({ variant: 'ghost', size: 'icon' })}
                  aria-label={m.orders_preview_open()}
                  title={m.orders_preview_open()}
                >
                  <Maximize2 aria-hidden="true" />
                </Link>
              ) : null,
              content: open ? (
                <OrderPreview
                  key={open}
                  organizationId={organizationId}
                  orderId={open}
                  order={shownOrder}
                  filter={filterValue}
                />
              ) : null,
              onClose: () => setOpen(undefined),
            }
          : undefined
      }
      help={
        <ShortcutHelp
          open={help}
          onOpenChange={setHelp}
          groups={[
            listShortcutGroup(
              previewOn
                ? shortcuts
                : shortcuts.filter((command) => command !== 'preview'),
            ),
          ]}
        />
      }
    />
  );
}

/**
 * Lays out the Orders page in the shared list order: title, toolbar, coverage, notices, then the
 * results with pagination, beside an optional preview pane.
 */
export function OrdersView({
  toolbar,
  coverage,
  summary,
  notices,
  actions,
  loading = false,
  results,
  pagination,
  preview,
  rowsRef,
  help,
}: {
  toolbar: ReactNode;
  /** Which sources and dates the list covers. */
  coverage?: ReactNode;
  /** A saved view's metrics and charts. */
  summary?: ReactNode;
  notices?: ReactNode;
  /** Actions for the selected orders, shown above the results. */
  actions?: ReactNode;
  loading?: boolean;
  results?: ReactNode;
  pagination?: ReactNode;
  preview?:
    | {
        open: boolean;
        title?: ReactNode;
        actions?: ReactNode;
        content: ReactNode;
        onClose: () => void;
      }
    | undefined;
  /** Contains the rows, for list keys. */
  rowsRef?: Ref<HTMLDivElement>;
  help?: ReactNode;
}) {
  const body = (
    <div ref={rowsRef} className="orders-results">
      {actions}
      {results ?? (loading ? <CollectionLoading /> : null)}
      {pagination}
    </div>
  );

  return (
    <main className="orders-page">
      <PageTitle title={m.orders_page_title()} />
      {toolbar}
      {coverage}
      {summary}
      {notices}
      {preview ? (
        <CollectionPreview
          className="orders-preview"
          open={preview.open}
          list={body}
          preview={preview.content}
          label={m.orders_preview_label()}
          title={preview.title}
          actions={preview.actions}
          onClose={preview.onClose}
        />
      ) : (
        body
      )}
      {help}
    </main>
  );
}

import './customers.css';

import {
  collectionField,
  type CollectionGroup,
  type CollectionViewState,
  collectionWhereIssues,
  type CustomerList,
  type CustomerListItem,
  customersCatalog,
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
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { Maximize2, Search, UsersRound } from 'lucide-react';
import {
  type ReactNode,
  type Ref,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

import { useCollectionControls } from '../../kit/collections/controls';
import { DescribedFilter } from '../../kit/collections/described-filter';
import { useGroupPages } from '../../kit/collections/groups';
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
import { usePrivateSearch } from '../../kit/collections/private-search';
import { repairedState } from '../../kit/collections/repair';
import {
  type CollectionSearch,
  groupOf,
  viewParam,
} from '../../kit/collections/state';
import { useCollectionView } from '../../kit/collections/use-collection-view';
import { CollectionViewBar } from '../../kit/collections/view-bar';
import { SignInRedirect } from '../../kit/identity/common';
import { IdentityError } from '../../kit/identity/data';
import { usePermissions } from '../../kit/identity/permissions';
import { CollectionBulkActions } from '../adaptive/bulk-actions';
import {
  adaptiveAvailabilityOptions,
  customFieldsOptions,
  customFieldValuesOptions,
} from '../adaptive/data';
import { customFieldColumns, customFieldText } from '../adaptive/presentation';
import { CollectionSummaryBand } from '../adaptive/summary-band';
import { SyncCoverage } from '../sync/coverage';
import {
  customerGroupLabel,
  customerSegmentLabel,
  customersPresentation,
} from './collection';
import {
  customerFilters,
  customerListQuery,
  customerPageSize,
  customersOptions,
  customerSourceOptions,
  type CustomersSearch,
} from './data';
import { customerSourceLabel } from './fields';
import { accessMessage, customerName } from './presentation';
import { CustomerPreview } from './preview';
import { customerGroups, CustomerResults } from './results';

/** The list commands the Customers page handles, for shortcut help. */
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
 * Repairs a view as every list does, and also drops a sort on a field the reader's role can't
 * use, such as the last order date without access to orders.
 */
function repaired(
  state: CollectionViewState,
  issues: readonly { index: number | null }[],
  can: (permission: string) => boolean,
): CollectionViewState {
  const next = repairedState(customersCatalog, state, issues, can);
  const permission = next.sort
    ? collectionField(customersCatalog, next.sort.field)?.permission
    : undefined;

  return permission && !can(permission)
    ? { ...next, sort: customersCatalog.defaultSort }
    : next;
}

/**
 * The Customers list: the member's view with its conditions, sort, grouping and layout from the
 * URL and remembered state, the shared toolbar and view bar, list keys, an optional preview pane
 * and keyset paging. Search text is personal data, so it stays in page state; a link's `?q=` is
 * adopted and removed from the address. A source customer link (`customerId` with
 * `connectionId`) opens the imported profile, or says Luma hasn't imported the customer.
 */
export function CustomersPage() {
  const { organizationId } = useParams({
    from: '/app/$organizationId/customers/',
  });
  const search = useSearch({ from: '/app/$organizationId/customers/' });
  const navigate = useNavigate({ from: '/app/$organizationId/customers/' });
  const queryClient = useQueryClient();
  const timeZone = useContext(WorkspaceTimezone);
  const permissions = usePermissions(organizationId);
  const can = permissions.can;
  const online = useOnline();
  const go = (next: CustomersSearch) =>
    void navigate({ search: next, resetScroll: false });
  const view = useCollectionView({
    catalog: customersCatalog,
    organizationId,
    search,
    navigate: (next: Partial<CollectionSearch>) =>
      go({ ...(search.item ? { item: search.item } : {}), ...next }),
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
  const resolvedId = link ? resolved.data : null;
  useEffect(() => {
    if (resolvedId)
      void navigate({
        to: '/app/$organizationId/customers/$customerId',
        params: { organizationId, customerId: resolvedId },
        replace: true,
      });
  }, [navigate, organizationId, resolvedId]);

  const availability = useQuery(adaptiveAvailabilityOptions(organizationId));
  const fields = useQuery({
    ...customFieldsOptions(organizationId, 'customer'),
    enabled: !!availability.data?.fields && can('adaptive.fields.read'),
  });
  const custom = customFieldColumns(fields.data ?? []);

  // Problems the client can see before asking, once permissions and custom fields are known.
  const usesCustom = state.where.conditions.some((condition) =>
    condition.field.startsWith('custom:'),
  );
  const fieldsKnown =
    !usesCustom ||
    fields.isSuccess ||
    fields.isError ||
    (availability.isSuccess &&
      permissions.ready &&
      !(availability.data.fields && can('adaptive.fields.read')));
  const ready = permissions.ready && fieldsKnown;
  const fieldPermissions = new Set(
    customersCatalog.fields.flatMap((field) =>
      field.permission && can(field.permission) ? [field.permission] : [],
    ),
  );
  const clientIssues = ready
    ? collectionWhereIssues(customersCatalog, state.where, {
        permissions: fieldPermissions,
        customFieldTypes: new Map(
          custom
            .filter((field) => !field.archived)
            .map((field) => [field.id, field.type]),
        ),
      })
    : [];
  const query = customerListQuery(
    state,
    { q, cursor: search.cursor },
    timeZone,
  );
  const list = useQuery({
    ...customersOptions(organizationId, query),
    enabled: ready && !clientIssues.length,
  });
  // With a page cursor, a refused request means the page link is stale, not the view.
  const serverIssue = search.cursor
    ? undefined
    : collectionServerIssue(list.error);
  const data = list.data;
  const sources = data?.sources ?? [];
  const sourceLabel = customerSourceLabel(sources);
  const options = {
    // Sources that share customers, or still hold imported ones, can be chosen.
    connections: sources
      .filter((source) => source.access === 'granted' || source.records > 0)
      .map((source) => ({ value: source.connectionId, label: source.label })),
  };
  const currencies = [
    ...new Set(
      (data?.items ?? []).flatMap((item) =>
        item.amountSpent ? [item.amountSpent.currency] : [],
      ),
    ),
  ];
  const controls = useCollectionControls({
    view,
    catalog: customersCatalog,
    presentation: customersPresentation,
    can,
    options,
    currencies,
    custom,
    required: ['name'],
    title: 'name',
    preview: true,
    serverIssues: serverIssue ? [serverIssue] : [],
  });
  // A 403 for a reader who can read customers means a field the view uses is closed to them.
  const fieldDenied =
    list.error instanceof IdentityError &&
    list.error.status === 403 &&
    can('customers.read');
  const issues = [
    ...clientIssues,
    ...(serverIssue ? [serverIssue] : []),
    ...(fieldDenied ? [{ index: null }] : []),
  ];
  const repair = issues.length
    ? () => view.change(repaired(state, issues, can))
    : undefined;
  const error: CollectionError | undefined =
    clientIssues.length || fieldDenied
      ? { kind: 'invalid', message: m.collections_needs_repair() }
      : collectionError(list.error, search.cursor);

  const grouping = state.group;
  const groupPrefix = `${groupOf(state) ?? ''}=`;
  const collapsed = view.display.collapsedGroups
    .filter((id) => id.startsWith(groupPrefix))
    .map((id) => id.slice(groupPrefix.length));
  const more = useGroupPages<CustomerListItem>({
    resetKey: JSON.stringify([organizationId, query]),
    load: (key: CollectionGroup['key'], cursor: string) =>
      queryClient
        .fetchQuery(
          customersOptions(
            organizationId,
            customerListQuery(state, { q, cursor: search.cursor }, timeZone, {
              key,
              cursor,
            }),
          ),
        )
        .then((page) => ({
          rows: page.items,
          nextCursor: page.groups?.[0]?.nextCursor ?? page.nextCursor,
        })),
  });
  const groups =
    data && grouping && data.groups ? customerGroups(data, grouping, more) : [];
  // Keys in the order rows appear on the page, so the list keys follow the screen.
  const keys = grouping
    ? groups
        .filter((group) => !collapsed.includes(group.id))
        .flatMap((group) => group.rows.map((row) => row.id))
    : (data?.items ?? []).map((row) => row.id);
  const rowsById = new Map(
    [...(data?.items ?? []), ...groups.flatMap((group) => group.rows)].map(
      (row) => [row.id, row],
    ),
  );
  // Custom field columns read the shown customers' values in one request per page.
  const customShown = custom.filter((field) =>
    controls.columns.includes(`custom:${field.id}`),
  );
  const customValues = useQuery({
    ...customFieldValuesOptions(organizationId, 'customer', [
      ...rowsById.keys(),
    ]),
    enabled: customShown.length > 0 && rowsById.size > 0,
  });
  const extraColumns = customShown.map((field) => ({
    key: `custom:${field.id}`,
    header: field.label,
    hideOnNarrow: true,
    cell: (customer: CustomerListItem) =>
      field.archived
        ? m.collections_field_archived()
        : customFieldText(
            field,
            customValues.data?.values.find(
              (value) =>
                value.recordId === customer.id && value.fieldId === field.id,
            )?.value,
          ),
  }));

  const paging = useCursorPaging({
    // Search text never enters browser storage; a new search starts on the first page.
    key: JSON.stringify([
      organizationId,
      view.key,
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
  // The customer page's breadcrumb returns to this list, page and view.
  const detailSearch: CustomersSearch = {
    ...customerFilters(search),
    cursor: search.cursor,
    page: search.page,
  };
  const openCustomer = (customerId: string) =>
    void navigate({
      to: '/app/$organizationId/customers/$customerId',
      params: { organizationId, customerId },
      search: detailSearch,
    });
  const keyboard = useListKeyboard({
    rows,
    count: keys.length,
    keys,
    preview: previewOn ? { open, onOpenChange: setOpen } : undefined,
    onOpen: (index) => {
      const key = keys[index];
      if (key) openCustomer(key);
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

  if (
    [list.error, resolved.error].some(
      (failure) => failure instanceof IdentityError && failure.status === 401,
    )
  )
    return <SignInRedirect />;

  const rowLink = (customer: CustomerListItem) => (
    <Link
      id={`customer-${customer.id}`}
      to="/app/$organizationId/customers/$customerId"
      params={{ organizationId, customerId: customer.id }}
      search={detailSearch}
      onClick={(event) => {
        if (!previewOn || event.metaKey || event.ctrlKey || event.shiftKey)
          return;
        event.preventDefault();
        setOpen(customer.id);
      }}
    />
  );
  const filterValue = (
    field: string,
    value: CellFilterValue,
    exclude: boolean,
  ) => {
    const definition = collectionField(customersCatalog, field);
    if (!definition?.filter) return;
    const where = whereWithCellValue(
      state.where as ConditionWhere,
      { id: field, type: definition.type, operators: definition.filter },
      value,
      exclude,
    );
    if (where) view.change({ ...state, where: where as typeof state.where });
  };
  const filtered = !!q.trim() || state.where.conditions.length > 0;
  const clear = () => {
    setQ('');
    view.reset();
  };
  const viewName =
    view.saved?.name ?? customerSegmentLabel(state.segment ?? 'all');
  const fieldLabel = (id: string) =>
    customersPresentation[id]?.label() ??
    custom.find((field) => `custom:${field.id}` === id)?.label ??
    id;
  const shownCustomer = open ? rowsById.get(open) : undefined;
  const hasRows = !!data && (data.items.length > 0 || groups.length > 0);
  const listError = error && error.kind !== 'invalid' ? error : undefined;

  const results =
    data && error?.kind !== 'access' && error?.kind !== 'invalid' ? (
      <CustomerResults
        extraColumns={extraColumns}
        list={data}
        layout={state.layout}
        density={state.density}
        grouping={grouping}
        caption={m.customers_list_caption({
          view: viewName,
          sort: state.sort ? fieldLabel(state.sort.field) : '',
        })}
        link={rowLink}
        empty={
          <CustomersEmpty
            organizationId={organizationId}
            list={data}
            filtered={filtered}
            clear={clear}
          />
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
        onColumnFilter={(key) => controls.filterBy(key)}
        properties={controls.properties}
        focusedKey={keyboard.focusedKey}
        current={open}
        selection={{ selected, onChange: setSelected }}
        groupLabel={(key) =>
          customerGroupLabel(
            grouping?.field ?? '',
            grouping?.granularity,
            key,
            options,
          )
        }
        collapsed={collapsed}
        onCollapsedChange={(id, closed) =>
          view.setDisplay({
            ...view.display,
            collapsedGroups: [
              ...view.display.collapsedGroups.filter(
                (item) => item !== `${groupPrefix}${id}`,
              ),
              ...(closed ? [`${groupPrefix}${id}`] : []),
            ].slice(-100),
          })
        }
        more={more}
      />
    ) : null;

  return (
    <CustomersView
      toolbar={
        <CollectionToolbar
          views={
            <CollectionViewBar
              organizationId={organizationId}
              view={view}
              path="customers"
              segmentLabel={customerSegmentLabel}
              exportColumns={controls.columns.map((id) => ({
                id,
                label: fieldLabel(id),
              }))}
            />
          }
          search={{
            value: q || undefined,
            onChange: (text) => {
              setQ(text ?? '');
              go({
                ...customerFilters(search),
                ...(search.item ? { item: search.item } : {}),
              });
            },
            label: m.customers_list_search_label(),
            placeholder: m.customers_list_search_placeholder(),
            inputRef: searchInput,
          }}
          filters={controls.filters}
          conditions={controls.conditions}
          actions={
            <DescribedFilter
              organizationId={organizationId}
              domain="customers"
              listName={m.customers_page_title()}
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
          onRefresh={() => void list.refetch()}
          refreshing={list.isFetching}
          refreshLabel={m.customers_list_refresh()}
        />
      }
      coverage={
        <SyncCoverage organizationId={organizationId} type="customers" />
      }
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
          {link && resolved.data === null ? (
            <Alert tone="info" role="status">
              <p>{m.customers_list_unresolved()}</p>
              <Button
                variant="outline"
                onClick={() => go(customerFilters(search))}
              >
                {m.customers_list_show_all()}
              </Button>
            </Alert>
          ) : null}
          <CustomerAccessNotices
            organizationId={organizationId}
            sources={sources}
          />
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
              totalCount={data.totalCount}
              page={paging.page}
              pageSize={customerPageSize}
              hasNext={!!paging.next}
              onPrevious={paging.previous}
              onNext={() => paging.next?.()}
              formatTotal={(count) =>
                m.customers_list_pagination_total({ count })
              }
              label={m.customers_list_pagination_label()}
            />
            {paging.first && !paging.previous ? (
              <Button variant="ghost" onClick={paging.first}>
                {m.customers_list_first_page()}
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
              title: shownCustomer ? customerName(shownCustomer) : undefined,
              actions: open ? (
                <Link
                  to="/app/$organizationId/customers/$customerId"
                  params={{ organizationId, customerId: open }}
                  search={detailSearch}
                  className={buttonVariants({ variant: 'ghost', size: 'icon' })}
                  aria-label={m.customers_preview_open()}
                  title={m.customers_preview_open()}
                >
                  <Maximize2 aria-hidden="true" />
                </Link>
              ) : null,
              content: open ? (
                <CustomerPreview
                  key={open}
                  organizationId={organizationId}
                  customerId={open}
                  customer={shownCustomer}
                  sourceLabel={sourceLabel}
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

/** Explains why a source's customers are missing when reconnecting it would help. */
export function CustomerAccessNotices({
  organizationId,
  sources,
}: {
  organizationId: string;
  sources: CustomerList['sources'];
}) {
  return (
    <>
      {sources.flatMap((source) => {
        const message = accessMessage(source);

        return message
          ? [
              <Alert key={source.connectionId} tone="info">
                <p>{message}</p>
                <Link
                  to="/app/$organizationId/connections"
                  params={{ organizationId }}
                >
                  {m.customers_review_connections()}
                </Link>
              </Alert>,
            ]
          : [];
      })}
    </>
  );
}

/**
 * Lays out the Customers page in the shared list order: title, toolbar, coverage, summary,
 * notices, then the results with pagination, beside an optional preview pane.
 */
export function CustomersView({
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
  /** Which sources the list covers. */
  coverage?: ReactNode;
  /** A saved view's metrics and charts. */
  summary?: ReactNode;
  notices?: ReactNode;
  /** Actions for the selected customers, shown above the results. */
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
    <div ref={rowsRef} className="customers-results">
      {actions}
      {results ?? (loading ? <CollectionLoading /> : null)}
      {pagination}
    </div>
  );

  return (
    <main className="customers-page">
      <PageTitle title={m.customers_page_title()} />
      {toolbar}
      {coverage}
      {summary}
      {notices}
      {preview ? (
        <CollectionPreview
          className="customers-preview"
          open={preview.open}
          list={body}
          preview={preview.content}
          label={m.customers_preview_label()}
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

/** Explains an empty list: no match, nothing shared yet, still importing, or no customers. */
export function CustomersEmpty({
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

import './products.css';

import {
  type CatalogItem,
  collectionField,
  type CollectionGroup,
  collectionWhereIssues,
  type ProductList,
  productsCatalog,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button, buttonVariants } from '@luma/ui/components/primitives/button';
import { CollectionPreview } from '@luma/ui/components/primitives/collection-preview';
import {
  type CollectionSort,
  CollectionToolbar,
  CollectionViews,
} from '@luma/ui/components/primitives/collection-toolbar';
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
import { Maximize2, Package } from 'lucide-react';
import { type ReactNode, type Ref, useContext, useRef, useState } from 'react';

import { useCollectionControls } from '../../kit/collections/controls';
import { DescribedFilter } from '../../kit/collections/described-filter';
import { sortOptions } from '../../kit/collections/fields';
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
import { repairedState } from '../../kit/collections/repair';
import { type CollectionSearch, groupOf } from '../../kit/collections/state';
import { useCollectionView } from '../../kit/collections/use-collection-view';
import { CollectionViewBar } from '../../kit/collections/view-bar';
import { connectionsOptions } from '../../kit/connections/data';
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
import { recordReturnPath } from '../records/data';
import { SyncCoverage } from '../sync/coverage';
import {
  listingColumn,
  listingColumns,
  listingColumnSource,
  productGroupLabel,
  productSegmentLabel,
  productsPresentation,
} from './collection';
import {
  productFilters,
  productListQuery,
  productPageSize,
  productsOptions,
  type ProductsSearch,
} from './data';
import { viewDescriptions } from './presentation';
import { ProductPreview } from './preview';
import { productGroups, ProductResults } from './results';

/** The list commands the Products page handles, for shortcut help. */
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

/** The Sort menu's value for the catalog order, which a view without a sort uses. */
const catalogOrder = 'rank';

/** Explains an empty list: nothing imported yet, or nothing matching the view and filters. */
export function ProductsEmpty({
  organizationId,
  segment,
  filtered,
  clear,
}: {
  organizationId: string;
  segment: string;
  filtered: boolean;
  clear: () => void;
}) {
  const narrowed = filtered || segment !== 'all';

  return (
    <Empty>
      <Package size={30} aria-hidden="true" />
      <h2>
        {narrowed
          ? m.products_list_unmatched_title()
          : m.products_list_empty_title()}
      </h2>
      <p>
        {narrowed
          ? !filtered
            ? m.products_list_view_empty({ view: productSegmentLabel(segment) })
            : m.products_list_unmatched_body()
          : m.products_list_empty_body()}
      </p>
      {filtered ? (
        <Button onClick={clear} variant="outline">
          {m.common_clear_filters()}
        </Button>
      ) : !narrowed ? (
        <Link to="/app/$organizationId/sync" params={{ organizationId }}>
          {m.products_open_data_sync()}
        </Link>
      ) : null}
    </Empty>
  );
}

/**
 * The Products list: the member's view with its conditions, sort, grouping and layout from the
 * URL and remembered state, comparison views with their counts, the shared toolbar and view bar,
 * one listing column per catalog source, list keys, an optional preview pane and keyset paging.
 * A filter change keeps the previous rows until the new ones arrive.
 */
export function ProductsPage() {
  const { organizationId } = useParams({
    from: '/app/$organizationId/products/',
  });
  const search = useSearch({ from: '/app/$organizationId/products/' });
  const navigate = useNavigate({ from: '/app/$organizationId/products/' });
  const queryClient = useQueryClient();
  const timeZone = useContext(WorkspaceTimezone);
  const permissions = usePermissions(organizationId);
  const can = permissions.can;
  const online = useOnline();
  const go = (next: ProductsSearch) =>
    void navigate({ search: next, resetScroll: false });
  // Clearing conditions also clears search text; other view changes keep it.
  const keepQuery = useRef(true);
  const view = useCollectionView({
    catalog: productsCatalog,
    organizationId,
    search,
    navigate: (next: Partial<CollectionSearch>) =>
      go({
        ...(keepQuery.current && search.q ? { q: search.q } : {}),
        ...(search.from ? { from: search.from } : {}),
        ...(search.item ? { item: search.item } : {}),
        ...next,
      }),
  });
  const state = view.state;

  const connections = useQuery(connectionsOptions(organizationId));
  const availability = useQuery(adaptiveAvailabilityOptions(organizationId));
  const fields = useQuery({
    ...customFieldsOptions(organizationId, 'product'),
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
    productsCatalog.fields.flatMap((field) =>
      field.permission && can(field.permission) ? [field.permission] : [],
    ),
  );
  const clientIssues = ready
    ? collectionWhereIssues(productsCatalog, state.where, {
        permissions: fieldPermissions,
        customFieldTypes: new Map(
          custom
            .filter((field) => !field.archived)
            .map((field) => [field.id, field.type]),
        ),
      })
    : [];
  const query = productListQuery(state, search, timeZone);
  const list = useQuery({
    ...productsOptions(organizationId, query),
    enabled: ready && !clientIssues.length,
  });
  // With a page cursor, a refused request means the page link is stale, not the view.
  const serverIssue = search.cursor
    ? undefined
    : collectionServerIssue(list.error);
  const data = list.data;
  const sources = data?.sources ?? [];
  // Catalog sources name each listing; connections cover sources whose catalog hasn't arrived.
  const sourceOptions = [
    ...new Map(
      [
        ...sources.map((source) => ({
          value: source.connectionId,
          label: source.label,
        })),
        ...(connections.data ?? []).map((item) => ({
          value: item.id,
          label: item.label,
        })),
      ].map((option) => [option.value, option]),
    ).values(),
  ];
  const options = { connections: sourceOptions };
  const currencies = [
    ...new Set(
      (data?.items ?? []).flatMap((item) =>
        item.listings.flatMap((listing) =>
          listing.price?.currency ? [listing.price.currency] : [],
        ),
      ),
    ),
  ];
  const controls = useCollectionControls({
    view,
    catalog: productsCatalog,
    presentation: productsPresentation,
    can,
    options,
    currencies,
    sources: sourceOptions,
    custom,
    required: ['sku'],
    title: 'sku',
    preview: true,
    extraColumns: listingColumns(sources),
    ...(sources.length
      ? {
          defaultColumns: [
            'sku',
            ...sources.map((source) => listingColumn(source.connectionId)),
          ],
        }
      : {}),
    serverIssues: serverIssue ? [serverIssue] : [],
  });
  // A 403 for a reader who can read products means a field the view uses is closed to them.
  const fieldDenied =
    list.error instanceof IdentityError &&
    list.error.status === 403 &&
    can('products.read');
  const issues = [
    ...clientIssues,
    ...(serverIssue ? [serverIssue] : []),
    ...(fieldDenied ? [{ index: null }] : []),
  ];
  const repair = issues.length
    ? () => view.change(repairedState(productsCatalog, state, issues, can))
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
  const resetKey = JSON.stringify([organizationId, query]);
  const more = useGroupPages<CatalogItem>({
    resetKey,
    load: (key: CollectionGroup['key'], cursor: string) =>
      queryClient
        .fetchQuery(
          productsOptions(
            organizationId,
            productListQuery(state, search, timeZone, { key, cursor }),
          ),
        )
        .then((page) => ({
          rows: page.items,
          nextCursor: page.groups?.[0]?.nextCursor ?? page.nextCursor,
        })),
  });
  const groups =
    data && grouping && data.groups ? productGroups(data, grouping, more) : [];
  // Keys in the order rows appear on the page, so the list keys follow the screen.
  const keys = grouping
    ? groups
        .filter((group) => !collapsed.includes(group.id))
        .flatMap((group) => group.rows.map((row) => row.skuId))
    : (data?.items ?? []).map((row) => row.skuId);
  const rowsById = new Map(
    [...(data?.items ?? []), ...groups.flatMap((group) => group.rows)].map(
      (row) => [row.skuId, row],
    ),
  );
  // Custom field columns read the shown SKUs' values in one request per page.
  const customShown = custom.filter((field) =>
    controls.columns.includes(`custom:${field.id}`),
  );
  const customValues = useQuery({
    ...customFieldValuesOptions(organizationId, 'product', [
      ...rowsById.keys(),
    ]),
    enabled:
      customShown.length > 0 && rowsById.size > 0 && state.layout === 'table',
  });
  const customColumns = customShown.map((field) => ({
    key: `custom:${field.id}`,
    header: field.label,
    hideOnNarrow: true,
    cell: (item: CatalogItem) =>
      field.archived
        ? m.collections_field_archived()
        : customFieldText(
            field,
            customValues.data?.values.find(
              (value) =>
                value.recordId === item.skuId && value.fieldId === field.id,
            )?.value,
          ),
  }));

  const paging = useCursorPaging({
    key: JSON.stringify([
      organizationId,
      view.key,
      query.view,
      query.where,
      query.sort,
      query.direction,
      query.q,
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
  const previewOn = state.preview;
  const open = previewOn ? search.item : undefined;
  const setOpen = (item: string | undefined) => go({ ...search, item });
  const detailSearch = { ...search, item: undefined };
  const openProduct = (skuId: string) =>
    void navigate({
      to: '/app/$organizationId/products/$skuId',
      params: { organizationId, skuId },
      search: detailSearch,
    });
  const keyboard = useListKeyboard({
    rows,
    count: keys.length,
    keys,
    preview: previewOn ? { open, onOpenChange: setOpen } : undefined,
    onOpen: (index) => {
      const key = keys[index];
      if (key) openProduct(key);
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

  if (list.error instanceof IdentityError && list.error.status === 401)
    return <SignInRedirect />;

  const link = (item: CatalogItem) => (
    <Link
      id={`product-${item.skuId}`}
      to="/app/$organizationId/products/$skuId"
      params={{ organizationId, skuId: item.skuId }}
      search={detailSearch}
      onClick={(event) => {
        if (!previewOn || event.metaKey || event.ctrlKey || event.shiftKey)
          return;
        event.preventDefault();
        setOpen(item.skuId);
      }}
    />
  );
  const matchLink = (skuId: string, text: string) => (
    <Link
      to="/app/$organizationId/products/$skuId"
      params={{ organizationId, skuId }}
      search={detailSearch}
    >
      {text}
    </Link>
  );
  const filterValue = (
    field: string,
    value: CellFilterValue,
    exclude: boolean,
  ) => {
    const definition = collectionField(productsCatalog, field);
    if (!definition?.filter) return;
    const where = whereWithCellValue(
      state.where as ConditionWhere,
      { id: field, type: definition.type, operators: definition.filter },
      value,
      exclude,
    );
    if (where) view.change({ ...state, where: where as typeof state.where });
  };
  const segment = state.segment ?? 'all';
  const filtered = !!search.q || state.where.conditions.length > 0;
  const viewName = view.saved?.name ?? productSegmentLabel(segment);
  const sortable = sortOptions(
    productsCatalog,
    productsPresentation,
    can,
    custom,
  );
  // Built-in views have no sort and list SKUs in catalog order; a saved sort can't be removed.
  const sort: CollectionSort = {
    value: state.sort?.field ?? catalogOrder,
    options: [
      ...(view.base.sort
        ? []
        : [{ value: catalogOrder, label: m.products_sort_catalog() }]),
      ...sortable,
    ],
    onChange: (field) =>
      view.change({
        ...state,
        sort:
          field === catalogOrder
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
  const shownItem = open ? rowsById.get(open) : undefined;
  const hasRows = !!data && (data.items.length > 0 || groups.length > 0);
  const listError = error && error.kind !== 'invalid' ? error : undefined;
  const clear = () => {
    keepQuery.current = false;
    controls.clearConditions();
    keepQuery.current = true;
  };

  const results =
    data && error?.kind !== 'access' && error?.kind !== 'invalid' ? (
      <ProductResults
        list={data}
        layout={state.layout}
        density={state.density}
        grouping={grouping}
        caption={m.products_list_caption_sorted({
          view: viewName,
          sort: sortLabel,
        })}
        link={link}
        matchLink={matchLink}
        empty={
          <ProductsEmpty
            organizationId={organizationId}
            segment={segment}
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
        extraColumns={customColumns}
        properties={controls.properties}
        focusedKey={keyboard.focusedKey}
        current={open}
        selection={{ selected, onChange: setSelected }}
        groupLabel={(key) =>
          productGroupLabel(
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
    <ProductsView
      back={recordReturnPath(organizationId, search.from)}
      toolbar={
        <CollectionToolbar
          views={
            <>
              <CollectionViewBar
                organizationId={organizationId}
                view={view}
                path="products"
                segmentLabel={productSegmentLabel}
                exportColumns={controls.columns
                  .filter((id) => !listingColumnSource(id))
                  .map((id) => ({
                    id,
                    label:
                      productsPresentation[id]?.label() ??
                      custom.find((field) => `custom:${field.id}` === id)
                        ?.label ??
                      id,
                  }))}
              />
              <ProductTabs
                value={view.ref.kind === 'builtin' ? view.ref.segment : null}
                counts={data?.counts}
                onChange={(next) => view.open(`builtin:${next}`)}
              />
            </>
          }
          search={{
            value: search.q,
            onChange: (q) =>
              go({
                ...productFilters(search),
                q: q || undefined,
                ...(search.from ? { from: search.from } : {}),
                ...(search.item ? { item: search.item } : {}),
              }),
            label: m.products_list_search_label(),
            placeholder: m.products_list_search_placeholder(),
            inputRef: searchInput,
          }}
          filters={controls.filters}
          conditions={controls.conditions}
          actions={
            <DescribedFilter
              organizationId={organizationId}
              domain="products"
              listName={m.products_page_title()}
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
          refreshLabel={m.products_list_refresh()}
        />
      }
      coverage={
        <SyncCoverage organizationId={organizationId} type="products" />
      }
      note={m.products_list_note()}
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
              totalCount={data.counts[query.view ?? 'all']}
              page={paging.page}
              pageSize={productPageSize}
              hasNext={!!paging.next}
              onPrevious={paging.previous}
              onNext={() => paging.next?.()}
              formatTotal={(count) =>
                m.products_list_pagination_total({ count })
              }
              label={m.products_list_pagination_label()}
            />
            {paging.first && !paging.previous ? (
              <Button variant="ghost" onClick={paging.first}>
                {m.products_list_first_page_button()}
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
              title: shownItem?.sku.trim(),
              actions: open ? (
                <Link
                  to="/app/$organizationId/products/$skuId"
                  params={{ organizationId, skuId: open }}
                  search={detailSearch}
                  className={buttonVariants({ variant: 'ghost', size: 'icon' })}
                  aria-label={m.products_preview_open()}
                  title={m.products_preview_open()}
                >
                  <Maximize2 aria-hidden="true" />
                </Link>
              ) : null,
              content: open ? (
                <ProductPreview
                  key={open}
                  organizationId={organizationId}
                  skuId={open}
                  item={shownItem}
                  sources={sources}
                  asOf={data?.asOf ?? ''}
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
 * The built-in comparison views as tabs with their counts under the current search and
 * conditions. A saved view selects no tab.
 */
export function ProductTabs({
  value,
  counts,
  onChange,
}: {
  value: string | null;
  counts?: ProductList['counts'] | undefined;
  onChange: (segment: string) => void;
}) {
  return (
    <CollectionViews
      label={m.products_list_views_label()}
      value={value}
      views={productsCatalog.segments.map((segment) => ({
        value: segment,
        label: productSegmentLabel(segment),
        description: (viewDescriptions as Record<string, string>)[segment],
        count: counts?.[segment as keyof ProductList['counts']],
        attention: segment !== 'all',
      }))}
      onChange={onChange}
    />
  );
}

/**
 * Lays out the Products page in the shared list order: title, toolbar, coverage, notices, then
 * the results with pagination, beside an optional preview pane.
 */
export function ProductsView({
  back,
  toolbar,
  coverage,
  note,
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
  /** Where the reader came from, such as an issue, for a back link. */
  back?: string | null | undefined;
  toolbar: ReactNode;
  /** Which sources the list covers. */
  coverage?: ReactNode;
  /** How sources are compared. */
  note?: ReactNode;
  /** A saved view's metrics and charts. */
  summary?: ReactNode;
  notices?: ReactNode;
  /** Actions for the selected SKUs, shown above the results. */
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
    <div ref={rowsRef} className="products-results">
      {actions}
      {results ?? (loading ? <CollectionLoading /> : null)}
      {pagination}
    </div>
  );

  return (
    <main className="products-page">
      {back ? <Link to={back}>← {m.products_back_context()}</Link> : null}
      <PageTitle title={m.products_page_title()} />
      {toolbar}
      {coverage}
      {note ? <p className="products-note">{note}</p> : null}
      {summary}
      {notices}
      {preview ? (
        <CollectionPreview
          className="products-preview"
          open={preview.open}
          list={body}
          preview={preview.content}
          label={m.products_preview_label()}
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

import './inventory.css';

import {
  collectionField,
  type CollectionGroup,
  collectionWhereIssues,
  inventoryCatalog,
  type StockPosition,
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
import { Boxes, Maximize2 } from 'lucide-react';
import { type ReactNode, type Ref, useContext, useRef, useState } from 'react';

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
import { repairedState } from '../../kit/collections/repair';
import { type CollectionSearch, groupOf } from '../../kit/collections/state';
import { useCollectionView } from '../../kit/collections/use-collection-view';
import { CollectionViewBar } from '../../kit/collections/view-bar';
import { connectionsOptions } from '../../kit/connections/data';
import { SignInRedirect } from '../../kit/identity/common';
import { ApiError } from '../../kit/identity/data';
import { usePermissions } from '../../kit/identity/permissions';
import { StockProtectionNotice } from '../../shared/stock-protection/notice';
import { CollectionBulkActions } from '../adaptive/bulk-actions';
import { CollectionSummaryBand } from '../adaptive/summary-band';
import { recordReturnPath } from '../records/data';
import { SyncCoverage } from '../sync/coverage';
import {
  inventoryGroupLabel,
  inventoryPresentation,
  inventorySegmentLabel,
} from './collection';
import {
  inventoryFilters,
  inventoryListOptions,
  inventoryListQuery,
  inventoryLocationsOptions,
  inventoryPageSize,
  type InventorySearch,
} from './data';
import { inventoryColumnField } from './list-table';
import { InventoryPreview } from './preview';
import { inventoryGroups, InventoryResults, positionLabel } from './results';

/** The list commands the Inventory page handles, for shortcut help. */
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

/** Explains an empty list: nothing imported yet, or nothing matching the view and filters. */
export function InventoryEmpty({
  organizationId,
  filtered,
  clear,
}: {
  organizationId: string;
  filtered: boolean;
  clear: () => void;
}) {
  return (
    <Empty>
      <Boxes size={30} aria-hidden="true" />
      <h2>
        {filtered
          ? m.inventory_list_unmatched_title()
          : m.inventory_list_empty_title()}
      </h2>
      <p>
        {filtered
          ? m.inventory_list_unmatched_body()
          : m.inventory_list_empty_body()}
      </p>
      {filtered ? (
        <Button onClick={clear} variant="outline">
          {m.common_clear_filters()}
        </Button>
      ) : (
        <Link to="/app/$organizationId/apps" params={{ organizationId }}>
          {m.inventory_list_connect()}
        </Link>
      )}
    </Empty>
  );
}

/**
 * The Inventory list: the member's view with its conditions, sort, grouping and layout from the
 * URL and remembered state, the shared toolbar and view bar, list keys, an optional preview pane
 * and keyset paging. Quantities stay per source. A filter change keeps the previous rows until
 * the new ones arrive.
 */
export function InventoryPage() {
  const { organizationId } = useParams({
    from: '/app/$organizationId/inventory/',
  });
  const search = useSearch({ from: '/app/$organizationId/inventory/' });
  const navigate = useNavigate({ from: '/app/$organizationId/inventory/' });
  const queryClient = useQueryClient();
  const timeZone = useContext(WorkspaceTimezone);
  const permissions = usePermissions(organizationId);
  const can = permissions.can;
  const online = useOnline();
  const go = (next: InventorySearch) =>
    void navigate({ search: next, resetScroll: false });
  // Clearing conditions also clears search text and the SKU; other view changes keep them.
  const keepQuery = useRef(true);
  const view = useCollectionView({
    catalog: inventoryCatalog,
    organizationId,
    search,
    navigate: (next: Partial<CollectionSearch>) =>
      go({
        ...(keepQuery.current && search.q ? { q: search.q } : {}),
        ...(keepQuery.current && search.skuId ? { skuId: search.skuId } : {}),
        ...(search.from ? { from: search.from } : {}),
        ...(search.item ? { item: search.item } : {}),
        ...next,
      }),
  });
  const state = view.state;

  const connections = useQuery(connectionsOptions(organizationId));
  const locations = useQuery(inventoryLocationsOptions(organizationId));
  const ready = permissions.ready;
  const fieldPermissions = new Set(
    inventoryCatalog.fields.flatMap((field) =>
      field.permission && can(field.permission) ? [field.permission] : [],
    ),
  );
  const clientIssues = ready
    ? collectionWhereIssues(inventoryCatalog, state.where, {
        permissions: fieldPermissions,
      })
    : [];
  const query = inventoryListQuery(state, search, timeZone);
  const list = useQuery({
    ...inventoryListOptions(organizationId, query),
    enabled: ready && !clientIssues.length,
  });
  // With a page cursor, a refused request means the page link is stale, not the view.
  const serverIssue = search.cursor
    ? undefined
    : collectionServerIssue(list.error);
  const data = list.data;
  const unique = (values: readonly { value: string; label: string }[]) => [
    ...new Map(values.map((option) => [option.value, option])).values(),
  ];
  const sources = unique([
    ...(connections.data ?? []).map((item) => ({
      value: item.id,
      label: item.label,
    })),
    ...(data?.items ?? []).flatMap((item) =>
      item.sources.map((source) => ({
        value: source.connectionId,
        label: source.label,
      })),
    ),
  ]);
  const options = {
    connections: sources,
    locations: unique([
      ...(locations.data ?? []),
      ...(data?.items ?? []).map((item) => ({
        value: item.locationId,
        label: item.location,
      })),
    ]),
  };
  const controls = useCollectionControls({
    view,
    catalog: inventoryCatalog,
    presentation: inventoryPresentation,
    can,
    options,
    sources,
    required: ['sku'],
    title: 'sku',
    preview: true,
    serverIssues: serverIssue ? [serverIssue] : [],
  });
  // A 403 for a reader who can read inventory means a field the view uses is closed to them.
  const fieldDenied =
    list.error instanceof ApiError &&
    list.error.status === 403 &&
    can('inventory.read');
  const issues = [
    ...clientIssues,
    ...(serverIssue ? [serverIssue] : []),
    ...(fieldDenied ? [{ index: null }] : []),
  ];
  const repair = issues.length
    ? () => view.change(repairedState(inventoryCatalog, state, issues, can))
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
  const more = useGroupPages<StockPosition>({
    resetKey,
    load: (key: CollectionGroup['key'], cursor: string) =>
      queryClient
        .fetchQuery(
          inventoryListOptions(
            organizationId,
            inventoryListQuery(state, search, timeZone, { key, cursor }),
          ),
        )
        .then((page) => ({
          rows: page.items,
          nextCursor: page.groups?.[0]?.nextCursor ?? page.nextCursor,
        })),
  });
  const groups =
    data && grouping && data.groups
      ? inventoryGroups(data, grouping, more)
      : [];
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

  const paging = useCursorPaging({
    key: JSON.stringify([
      organizationId,
      view.key,
      query.view,
      query.where,
      query.sort,
      query.direction,
      query.q,
      query.skuId,
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
  const openPosition = (positionId: string) =>
    void navigate({
      to: '/app/$organizationId/inventory/$positionId',
      params: { organizationId, positionId },
      search: detailSearch,
    });
  const keyboard = useListKeyboard({
    rows,
    count: keys.length,
    keys,
    preview: previewOn ? { open, onOpenChange: setOpen } : undefined,
    onOpen: (index) => {
      const key = keys[index];
      if (key) openPosition(key);
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

  const link = (position: StockPosition) => (
    <Link
      id={`position-${position.id}`}
      to="/app/$organizationId/inventory/$positionId"
      params={{ organizationId, positionId: position.id }}
      search={detailSearch}
      onClick={(event) => {
        if (!previewOn || event.metaKey || event.ctrlKey || event.shiftKey)
          return;
        event.preventDefault();
        setOpen(position.id);
      }}
    />
  );
  const filterValue = (
    field: string,
    value: CellFilterValue,
    exclude: boolean,
  ) => {
    const definition = collectionField(inventoryCatalog, field);
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
  const filtered =
    !!search.q ||
    !!search.skuId ||
    state.where.conditions.length > 0 ||
    segment !== 'all';
  const viewName = view.saved?.name ?? inventorySegmentLabel(segment);
  const sortLabel = state.sort
    ? (inventoryPresentation[state.sort.field]?.label() ?? state.sort.field)
    : '';
  const shownPosition = open ? rowsById.get(open) : undefined;
  const hasRows = !!data && (data.items.length > 0 || groups.length > 0);
  const listError = error && error.kind !== 'invalid' ? error : undefined;
  const skuLabel = search.skuId
    ? (data?.items.find((item) => item.skuId === search.skuId)?.sku ??
      m.inventory_selected_sku())
    : undefined;
  const clear = () => {
    keepQuery.current = false;
    controls.clearConditions();
    keepQuery.current = true;
  };
  // Grouping by SKU keys by canonical ID; the rows carry the SKU's label.
  const groupName = (key: string) =>
    grouping?.field === 'sku'
      ? data?.items.find((item) => item.skuId === key)?.sku
      : grouping?.field === 'location'
        ? data?.items.find((item) => item.locationId === key)?.location
        : undefined;

  const results =
    data && error?.kind !== 'access' && error?.kind !== 'invalid' ? (
      <InventoryResults
        list={data}
        layout={state.layout}
        density={state.density}
        grouping={grouping}
        caption={m.inventory_list_caption_sorted({
          view: viewName,
          sort: sortLabel,
        })}
        link={link}
        empty={
          <InventoryEmpty
            organizationId={organizationId}
            filtered={filtered}
            clear={() => {
              keepQuery.current = false;
              view.reset();
              keepQuery.current = true;
            }}
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
        onColumnFilter={(key) => controls.filterBy(inventoryColumnField(key))}
        properties={controls.properties}
        focusedKey={keyboard.focusedKey}
        current={open}
        selection={{ selected, onChange: setSelected }}
        groupLabel={(key) =>
          inventoryGroupLabel(
            grouping?.field ?? '',
            grouping?.granularity,
            key,
            options,
            groupName,
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
    <InventoryView
      organizationId={organizationId}
      back={recordReturnPath(organizationId, search.from)}
      toolbar={
        <CollectionToolbar
          views={
            <CollectionViewBar
              organizationId={organizationId}
              view={view}
              path="inventory"
              segmentLabel={inventorySegmentLabel}
              exportColumns={controls.columns.map((id) => ({
                id,
                label: inventoryPresentation[id]?.label() ?? id,
              }))}
            />
          }
          search={{
            value: search.q,
            onChange: (q) =>
              go({
                ...inventoryFilters(search),
                q: q || undefined,
                ...(search.from ? { from: search.from } : {}),
                ...(search.item ? { item: search.item } : {}),
              }),
            label: m.inventory_list_search_label(),
            placeholder: m.inventory_list_search_placeholder(),
            inputRef: searchInput,
          }}
          filters={[
            ...controls.filters,
            {
              kind: 'applied',
              key: 'skuId',
              label: m.inventory_filter_sku(),
              value: skuLabel,
              onRemove: () =>
                go({ ...inventoryFilters(search), skuId: undefined }),
            },
          ]}
          conditions={controls.conditions}
          actions={
            <DescribedFilter
              organizationId={organizationId}
              domain="inventory"
              listName={m.inventory_page_title()}
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
          onClear={clear}
          onRefresh={() => {
            void list.refetch();
            void connections.refetch();
            void locations.refetch();
          }}
          refreshing={list.isFetching}
          refreshLabel={m.inventory_list_refresh()}
        />
      }
      coverage={
        <SyncCoverage organizationId={organizationId} type="inventory" />
      }
      note={m.inventory_list_note()}
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
              pageSize={inventoryPageSize}
              hasNext={!!paging.next}
              onPrevious={paging.previous}
              onNext={() => paging.next?.()}
              formatTotal={(count) =>
                m.inventory_list_pagination_total({ count })
              }
              label={m.inventory_list_pagination_label()}
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
      preview={
        previewOn
          ? {
              open: !!open,
              title: shownPosition ? positionLabel(shownPosition) : undefined,
              actions: open ? (
                <Link
                  to="/app/$organizationId/inventory/$positionId"
                  params={{ organizationId, positionId: open }}
                  search={detailSearch}
                  className={buttonVariants({ variant: 'ghost', size: 'icon' })}
                  aria-label={m.inventory_preview_open()}
                  title={m.inventory_preview_open()}
                >
                  <Maximize2 aria-hidden="true" />
                </Link>
              ) : null,
              content: open ? (
                <InventoryPreview
                  key={open}
                  organizationId={organizationId}
                  positionId={open}
                  position={shownPosition}
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
 * Lays out the Inventory page in the shared list order: title, the way to transfers, toolbar,
 * coverage, notices, then the results with pagination, beside an optional preview pane.
 */
export function InventoryView({
  organizationId,
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
  organizationId: string;
  /** Where the reader came from, such as an issue, for a back link. */
  back?: string | null | undefined;
  toolbar: ReactNode;
  /** Which sources the list covers. */
  coverage?: ReactNode;
  /** How rows and quantities are read. */
  note?: ReactNode;
  /** A saved view's metrics and charts. */
  summary?: ReactNode;
  notices?: ReactNode;
  /** Actions for the selected positions, shown above the results. */
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
    <div ref={rowsRef} className="inventory-results">
      {actions}
      {results ?? (loading ? <CollectionLoading /> : null)}
      {pagination}
    </div>
  );

  return (
    <main className="inventory-page">
      {back ? <Link to={back}>← {m.inventory_back_context()}</Link> : null}
      <PageTitle title={m.inventory_page_title()} />
      <Button
        variant="outline"
        className="inventory-transfers-link"
        render={
          <Link
            to="/app/$organizationId/inventory/transfers"
            params={{ organizationId }}
          />
        }
        nativeButton={false}
      >
        {m.inventory_transfer_nav()}
      </Button>
      {toolbar}
      {coverage}
      {note ? <p className="inventory-note">{note}</p> : null}
      {summary}
      {notices}
      <StockProtectionNotice organizationId={organizationId} />
      {preview ? (
        <CollectionPreview
          className="inventory-preview"
          open={preview.open}
          list={body}
          preview={preview.content}
          label={m.inventory_preview_label()}
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

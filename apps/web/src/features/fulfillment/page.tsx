import './fulfillment.css';

import {
  collectionField,
  fulfillmentCatalog,
  type FulfillmentItem,
  type FulfillmentList,
  type FulfillmentView as FulfillmentSegment,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button, buttonVariants } from '@luma/ui/components/primitives/button';
import { CollectionPreview } from '@luma/ui/components/primitives/collection-preview';
import {
  CollectionToolbar,
  type CollectionView,
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
import { useQuery } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { CircleCheck, Maximize2, Truck } from 'lucide-react';
import { type ReactNode, type Ref, useContext, useRef, useState } from 'react';

import { useCollectionControls } from '../../kit/collections/controls';
import { DescribedFilter } from '../../kit/collections/described-filter';
import {
  CollectionLoading,
  CollectionNotices,
} from '../../kit/collections/notices';
import { useCursorPaging, useOnline } from '../../kit/collections/paging';
import { useRecordCollection } from '../../kit/collections/record-collection';
import type { CollectionSearch } from '../../kit/collections/state';
import { useCollectionView } from '../../kit/collections/use-collection-view';
import { CollectionViewBar } from '../../kit/collections/view-bar';
import { connectionsOptions } from '../../kit/connections/data';
import { SignInRedirect } from '../../kit/identity/common';
import { ApiError } from '../../kit/identity/data';
import { usePermissions } from '../../kit/identity/permissions';
import { CollectionBulkActions } from '../adaptive/bulk-actions';
import { CollectionSummaryBand } from '../adaptive/summary-band';
import { recordReturnPath } from '../records/data';
import { SyncCoverage } from '../sync/coverage';
import {
  fulfillmentGroupLabel,
  fulfillmentPresentation,
  fulfillmentSegmentLabel,
} from './collection';
import {
  fulfillmentFilters,
  fulfillmentListOptions,
  fulfillmentListQuery,
  fulfillmentPageSize,
  type FulfillmentSearch,
} from './data';
import { orderLabel, viewDescriptions } from './presentation';
import { FulfillmentPreview } from './preview';
import { fulfillmentGroups, FulfillmentResults } from './results';

/** The list commands the Fulfillment page handles, for shortcut help. */
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

// Views that list problems; a non-zero count is highlighted.
const warningViews = new Set<string>(['attention', 'held', 'delayed']);

const emptyViewTitles: Record<FulfillmentSegment, () => string> = {
  attention: m.fulfillment_empty_attention_title,
  held: m.fulfillment_empty_held_title,
  delayed: m.fulfillment_empty_delayed_title,
  open: m.fulfillment_empty_open_title,
  in_transit: m.fulfillment_empty_in_transit_title,
  all: m.fulfillment_empty_all_title,
};

/** Explains an empty list for the current view and filters. */
export function FulfillmentEmpty({
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
  const view = (
    segment in emptyViewTitles ? segment : 'all'
  ) as FulfillmentSegment;
  const calm =
    !filtered &&
    (view === 'attention' || view === 'held' || view === 'delayed');

  return (
    <Empty>
      {calm ? (
        <CircleCheck size={30} aria-hidden="true" />
      ) : (
        <Truck size={30} aria-hidden="true" />
      )}
      <h2>
        {filtered
          ? m.fulfillment_empty_filtered_title()
          : emptyViewTitles[view]()}
      </h2>
      <p>
        {calm
          ? m.fulfillment_empty_problems_body()
          : filtered
            ? m.fulfillment_empty_filtered_body()
            : view === 'all'
              ? m.fulfillment_empty_all_body()
              : viewDescriptions[view]}
      </p>
      {filtered ? (
        <Button onClick={clear} variant="outline">
          {m.common_clear_filters()}
        </Button>
      ) : view === 'all' ? (
        <Link to="/app/$organizationId/sync" params={{ organizationId }}>
          {m.fulfillment_open_data_sync()}
        </Link>
      ) : null}
    </Empty>
  );
}

/**
 * The Fulfillment list: the member's view with its conditions, sort, grouping and layout from
 * the URL and remembered state, built-in views with their counts, the shared toolbar and view
 * bar, list keys, an optional preview pane and keyset paging. A filter change keeps the previous
 * rows until the new ones arrive.
 */
export function FulfillmentPage() {
  const { organizationId } = useParams({
    from: '/app/$organizationId/fulfillment/',
  });
  const search = useSearch({ from: '/app/$organizationId/fulfillment/' });
  const navigate = useNavigate({ from: '/app/$organizationId/fulfillment/' });
  const timeZone = useContext(WorkspaceTimezone);
  const permissions = usePermissions(organizationId);
  const can = permissions.can;
  const online = useOnline();
  const go = (next: FulfillmentSearch) =>
    void navigate({ search: next, resetScroll: false });
  // Clearing conditions also clears search text; other view changes keep it.
  const keepQuery = useRef(true);
  const view = useCollectionView({
    catalog: fulfillmentCatalog,
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
  const query = fulfillmentListQuery(state, search, timeZone);
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
    catalog: fulfillmentCatalog,
    view,
    permissions,
    cursor: search.cursor,
    list: fulfillmentListOptions(organizationId, query),
    resetKey: JSON.stringify([organizationId, query]),
    groupPage: (key, cursor) =>
      fulfillmentListOptions(
        organizationId,
        fulfillmentListQuery(state, search, timeZone, { key, cursor }),
      ),
    gatedFields: true,
  });
  const data = list.data;
  const options = {
    connections:
      connections.data?.map((item) => ({
        value: item.id,
        label: item.label,
      })) ??
      data?.sources.map((source) => ({
        value: source.connectionId,
        label: source.label,
      })) ??
      [],
    locations: [
      ...new Map(
        [
          ...(data?.locations ?? []).map((location) => ({
            value: location.id,
            label: location.name ?? m.fulfillment_unnamed_location(),
          })),
          ...(data?.items ?? []).flatMap((item) =>
            item.location?.id
              ? [
                  {
                    value: item.location.id,
                    label:
                      item.location.name ?? m.fulfillment_unnamed_location(),
                  },
                ]
              : [],
          ),
        ].map((option) => [option.value, option]),
      ).values(),
    ],
  };
  const controls = useCollectionControls({
    view,
    catalog: fulfillmentCatalog,
    presentation: fulfillmentPresentation,
    can,
    options,
    required: ['order'],
    title: 'order',
    preview: true,
    serverIssues: serverIssue ? [serverIssue] : [],
  });
  const groups =
    data && grouping && data.groups
      ? fulfillmentGroups(data, grouping, more)
      : [];
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
  const previewOn = state.preview && state.layout !== 'board';
  const open = previewOn ? search.item : undefined;
  const setOpen = (item: string | undefined) => go({ ...search, item });
  const detailSearch = { ...search, item: undefined };
  const openFulfillment = (fulfillmentId: string) =>
    void navigate({
      to: '/app/$organizationId/fulfillment/$fulfillmentId',
      params: { organizationId, fulfillmentId },
      search: detailSearch,
    });
  const keyboard = useListKeyboard({
    rows,
    count: keys.length,
    keys,
    preview: previewOn ? { open, onOpenChange: setOpen } : undefined,
    onOpen: (index) => {
      const key = keys[index];
      if (key) openFulfillment(key);
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

  const link = (item: FulfillmentItem) => (
    <Link
      id={`fulfillment-${item.id}`}
      to="/app/$organizationId/fulfillment/$fulfillmentId"
      params={{ organizationId, fulfillmentId: item.id }}
      search={detailSearch}
      onClick={(event) => {
        if (!previewOn || event.metaKey || event.ctrlKey || event.shiftKey)
          return;
        event.preventDefault();
        setOpen(item.id);
      }}
    />
  );
  const filterValue = (
    field: string,
    value: CellFilterValue,
    exclude: boolean,
  ) => {
    const definition = collectionField(fulfillmentCatalog, field);
    if (!definition?.filter) return;
    const where = whereWithCellValue(
      state.where as ConditionWhere,
      { id: field, type: definition.type, operators: definition.filter },
      value,
      exclude,
    );
    if (where) view.change({ ...state, where: where as typeof state.where });
  };
  const segment = state.segment ?? 'attention';
  const filtered = !!search.q || state.where.conditions.length > 0;
  const viewName = view.saved?.name ?? fulfillmentSegmentLabel(segment);
  const sortLabel = state.sort
    ? (fulfillmentPresentation[state.sort.field]?.label() ?? state.sort.field)
    : '';
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
      <FulfillmentResults
        list={data}
        layout={state.layout}
        density={state.density}
        grouping={grouping}
        caption={m.fulfillment_list_caption_sorted({
          view: viewName,
          sort: sortLabel,
        })}
        link={link}
        empty={
          <FulfillmentEmpty
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
        properties={controls.properties}
        focusedKey={keyboard.focusedKey}
        current={open}
        selection={{ selected, onChange: setSelected }}
        groupLabel={(key) =>
          fulfillmentGroupLabel(
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
    <FulfillmentView
      back={recordReturnPath(organizationId, search.from)}
      toolbar={
        <CollectionToolbar
          views={
            <>
              <CollectionViewBar
                organizationId={organizationId}
                view={view}
                path="fulfillment"
                segmentLabel={fulfillmentSegmentLabel}
                segments={fulfillmentViews(data?.counts)}
                exportColumns={controls.columns.map((id) => ({
                  id,
                  label: fulfillmentPresentation[id]?.label() ?? id,
                }))}
              />
            </>
          }
          search={{
            value: search.q,
            onChange: (q) =>
              go({
                ...fulfillmentFilters(search),
                q: q || undefined,
                ...(search.from ? { from: search.from } : {}),
                ...(search.item ? { item: search.item } : {}),
              }),
            label: m.fulfillment_list_search_label(),
            placeholder: m.fulfillment_list_search_placeholder(),
            inputRef: searchInput,
          }}
          filters={controls.filters}
          conditions={controls.conditions}
          actions={
            <DescribedFilter
              organizationId={organizationId}
              domain="fulfillment"
              listName={m.fulfillment_page_title()}
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
          }}
          refreshing={list.isFetching}
          refreshLabel={m.fulfillment_list_refresh()}
        />
      }
      coverage={<SyncCoverage organizationId={organizationId} type="orders" />}
      note={m.fulfillment_list_note({ hours: data?.stalledAfterHours ?? 48 })}
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
              totalCount={data.counts[query.view ?? 'attention']}
              page={paging.page}
              pageSize={fulfillmentPageSize}
              hasNext={!!paging.next}
              onPrevious={paging.previous}
              onNext={() => paging.next?.()}
              formatTotal={(count) =>
                m.fulfillment_list_pagination_total({ count })
              }
              label={m.fulfillment_list_pagination_label()}
            />
            {paging.first && !paging.previous ? (
              <Button variant="ghost" onClick={paging.first}>
                {m.fulfillment_go_first_page()}
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
              title: shownItem ? orderLabel(shownItem) : undefined,
              actions: open ? (
                <Link
                  to="/app/$organizationId/fulfillment/$fulfillmentId"
                  params={{ organizationId, fulfillmentId: open }}
                  search={detailSearch}
                  className={buttonVariants({ variant: 'ghost', size: 'icon' })}
                  aria-label={m.fulfillment_preview_open()}
                  title={m.fulfillment_preview_open()}
                >
                  <Maximize2 aria-hidden="true" />
                </Link>
              ) : null,
              content: open ? (
                <FulfillmentPreview
                  key={open}
                  organizationId={organizationId}
                  fulfillmentId={open}
                  item={shownItem}
                  sources={data?.sources ?? []}
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

/** The built-in views with their counts under the current search and conditions. */
export function fulfillmentViews(
  counts?: FulfillmentList['counts'] | undefined,
): CollectionView<string>[] {
  return fulfillmentCatalog.segments.map((segment) => ({
    value: segment,
    label: fulfillmentSegmentLabel(segment),
    description: (viewDescriptions as Record<string, string>)[segment],
    count: counts?.[segment as FulfillmentSegment],
    attention: warningViews.has(segment),
  }));
}

/**
 * Lays out the Fulfillment page in the shared list order: title, toolbar, coverage, notices,
 * then the results with pagination, beside an optional preview pane.
 */
export function FulfillmentView({
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
  /** How the list defines delayed work. */
  note?: ReactNode;
  /** A saved view's metrics and charts. */
  summary?: ReactNode;
  notices?: ReactNode;
  /** Actions for the selected fulfillments, shown above the results. */
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
    <div ref={rowsRef} className="fulfillment-results">
      {actions}
      {results ?? (loading ? <CollectionLoading /> : null)}
      {pagination}
    </div>
  );

  return (
    <main className="fulfillment-page">
      {back ? <Link to={back}>← {m.fulfillment_back_to_context()}</Link> : null}
      <PageTitle title={m.fulfillment_page_title()} />
      {toolbar}
      {coverage}
      {note ? <p className="fulfillment-note">{note}</p> : null}
      {summary}
      {notices}
      {preview ? (
        <CollectionPreview
          className="fulfillment-preview"
          open={preview.open}
          list={body}
          preview={preview.content}
          label={m.fulfillment_preview_label()}
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

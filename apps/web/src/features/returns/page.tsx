import './returns.css';

import {
  collectionField,
  type CollectionGroup,
  collectionWhereIssues,
  type ReturnList,
  type ReturnListItem,
  returnsCatalog,
  type ReturnStage,
  type ReturnView,
} from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
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
import { StateDot } from '@luma/ui/components/primitives/state';
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
import { CircleCheck, Maximize2, Search, Undo2 } from 'lucide-react';
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
import { usePrivateSearch } from '../../kit/collections/private-search';
import { repairedState } from '../../kit/collections/repair';
import {
  builtinState,
  type CollectionSearch,
  groupOf,
  stateChanges,
  viewParam,
} from '../../kit/collections/state';
import {
  type CollectionView,
  useCollectionView,
} from '../../kit/collections/use-collection-view';
import { CollectionViewBar } from '../../kit/collections/view-bar';
import { SignInRedirect } from '../../kit/identity/common';
import { ApiError } from '../../kit/identity/data';
import { usePermissions } from '../../kit/identity/permissions';
import { CollectionBulkActions } from '../adaptive/bulk-actions';
import { CollectionSummaryBand } from '../adaptive/summary-band';
import { recordReturnPath } from '../records/data';
import { SyncCoverage } from '../sync/coverage';
import {
  chosenStage,
  returnGroupLabel,
  returnSegmentLabel,
  returnsPresentation,
  segmentSort,
  withStage,
} from './collection';
import {
  returnFilters,
  returnListQuery,
  returnPageSize,
  returnsOptions,
  type ReturnsSearch,
  viewConditionIndex,
} from './data';
import { ReturnDeadlines } from './deadlines';
import { returnSourceLabel } from './fields';
import {
  accessMessage,
  returnLabel,
  stageDescriptions,
  stageLabels,
  stageStates,
  workStages,
} from './presentation';
import { ReturnPreview } from './preview';
import { returnGroups, ReturnResults } from './results';

/** The list commands the Returns page handles, for shortcut help. */
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

const stageHints: Partial<Record<ReturnStage, () => string>> = {
  requested: m.returns_stage_hint_requested,
  awaiting_items: m.returns_stage_hint_awaiting_items,
  awaiting_refund: m.returns_stage_hint_awaiting_refund,
  refund_pending: m.returns_stage_hint_refund_pending,
  refund_failed: m.returns_stage_hint_refund_failed,
  ready_to_close: m.returns_stage_hint_ready_to_close,
};

/** The view each pending stage belongs to, so a stage card can tell when it leaves the view. */
const stageViews: Partial<Record<ReturnStage, ReturnView>> = {
  requested: 'action',
  awaiting_items: 'waiting',
  awaiting_refund: 'action',
  refund_pending: 'waiting',
  refund_failed: 'action',
  ready_to_close: 'action',
};

const emptyViewTitles: Record<ReturnView, () => string> = {
  action: m.returns_empty_view_action_title,
  waiting: m.returns_empty_view_waiting_title,
  done: m.returns_empty_view_done_title,
  all: m.returns_empty_view_all_title,
};

const views = new Set<string>(['action', 'waiting', 'done', 'all']);

const sameSort = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);

/**
 * The view as the Sort menu and table headers see it: a view without its own sort shows its
 * segment's. Choosing that same sort again keeps the view unchanged rather than marking it
 * Modified.
 */
function withSegmentSort(view: CollectionView): CollectionView {
  const fallback = segmentSort(view.state.segment);

  return {
    ...view,
    state: { ...view.state, sort: view.state.sort ?? fallback },
    change: (next) =>
      view.change(
        !view.base.sort && sameSort(next.sort, segmentSort(next.segment))
          ? { ...next, sort: null }
          : next,
      ),
  };
}

/**
 * The Returns list: the member's view with its conditions, sort, grouping and layout from the
 * URL and remembered state, stage cards for pending work, the shared toolbar and view bar, list
 * keys, an optional preview pane and keyset paging. Search can match customer names and email
 * addresses, so its text stays in page state; a link's `?q=` is adopted and removed from the
 * address.
 */
export function ReturnsPage() {
  const { organizationId } = useParams({
    from: '/app/$organizationId/returns/',
  });
  const search = useSearch({ from: '/app/$organizationId/returns/' });
  const navigate = useNavigate({ from: '/app/$organizationId/returns/' });
  const queryClient = useQueryClient();
  const timeZone = useContext(WorkspaceTimezone);
  const permissions = usePermissions(organizationId);
  const can = permissions.can;
  const online = useOnline();
  const go = (next: ReturnsSearch) =>
    void navigate({ search: next, resetScroll: false });
  const context = {
    ...(search.from ? { from: search.from } : {}),
    ...(search.item ? { item: search.item } : {}),
  };
  const view = useCollectionView({
    catalog: returnsCatalog,
    organizationId,
    search,
    navigate: (next: Partial<CollectionSearch>) => go({ ...context, ...next }),
  });
  const sorted = withSegmentSort(view);
  const state = sorted.state;
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

  const ready = permissions.ready;
  const clientIssues = ready
    ? collectionWhereIssues(returnsCatalog, state.where)
    : [];
  const query = returnListQuery(state, { q, cursor: search.cursor }, timeZone);
  const list = useQuery({
    ...returnsOptions(organizationId, query),
    enabled: ready && !clientIssues.length,
  });
  // With a page cursor, a refused request means the page link is stale, not the view.
  const sentIssue = search.cursor
    ? undefined
    : collectionServerIssue(list.error);
  const serverIssue = sentIssue && {
    ...sentIssue,
    index: viewConditionIndex(state, sentIssue.index),
  };
  const data = list.data;
  const sources = data?.sources ?? [];
  const sourceLabel = returnSourceLabel(sources);
  const options = {
    // Sources that share returns, or still hold imported ones, can be chosen.
    connections: sources
      .filter((source) => source.access === 'granted' || source.records > 0)
      .map((source) => ({ value: source.connectionId, label: source.label })),
  };
  const currencies = [
    ...new Set(
      (data?.items ?? []).flatMap((item) => [
        ...(item.value ? [item.value.currency] : []),
        ...(item.refund.currency ? [item.refund.currency] : []),
      ]),
    ),
  ];
  const controls = useCollectionControls({
    view: sorted,
    catalog: returnsCatalog,
    presentation: returnsPresentation,
    can,
    options,
    currencies,
    required: ['name'],
    title: 'name',
    preview: true,
    serverIssues: serverIssue ? [serverIssue] : [],
  });
  const issues = [...clientIssues, ...(serverIssue ? [serverIssue] : [])];
  const repair = issues.length
    ? () => view.change(repairedState(returnsCatalog, view.state, issues, can))
    : undefined;
  const error: CollectionError | undefined = clientIssues.length
    ? { kind: 'invalid', message: m.collections_needs_repair() }
    : collectionError(list.error, search.cursor);

  const segment = (
    state.segment && views.has(state.segment) ? state.segment : 'all'
  ) as ReturnView;
  const stage = chosenStage(state.where);
  // A stage card opens All returns when its stage is outside the current view.
  const chooseStage = (next: ReturnStage | undefined) => {
    const where = withStage(view.state.where, next);
    const owner = next ? stageViews[next] : undefined;
    if (!owner || segment === 'all' || segment === owner) {
      view.change({ ...view.state, where });

      return;
    }
    go({
      ...context,
      view: 'all',
      ...stateChanges(builtinState(returnsCatalog, 'all'), {
        ...view.state,
        segment: 'all',
        where,
      }),
    });
  };

  const grouping = state.group;
  const groupPrefix = `${groupOf(state) ?? ''}=`;
  const collapsed = view.display.collapsedGroups
    .filter((id) => id.startsWith(groupPrefix))
    .map((id) => id.slice(groupPrefix.length));
  const more = useGroupPages<ReturnListItem>({
    resetKey: JSON.stringify([organizationId, query]),
    load: (key: CollectionGroup['key'], cursor: string) =>
      queryClient
        .fetchQuery(
          returnsOptions(
            organizationId,
            returnListQuery(state, { q, cursor: search.cursor }, timeZone, {
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
    data && grouping && data.groups ? returnGroups(data, grouping, more) : [];
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
    // Search text never enters browser storage; a new search starts on the first page.
    key: JSON.stringify([
      organizationId,
      view.key,
      query.view,
      query.stage,
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
  // The return page's breadcrumb returns to this list, page and view.
  const detailSearch: ReturnsSearch = { ...search, item: undefined };
  const openReturn = (returnId: string) =>
    void navigate({
      to: '/app/$organizationId/returns/$returnId',
      params: { organizationId, returnId },
      search: detailSearch,
    });
  const keyboard = useListKeyboard({
    rows,
    count: keys.length,
    keys,
    preview: previewOn ? { open, onOpenChange: setOpen } : undefined,
    onOpen: (index) => {
      const key = keys[index];
      if (key) openReturn(key);
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

  const rowLink = (item: ReturnListItem) => (
    <Link
      id={`return-${item.id}`}
      to="/app/$organizationId/returns/$returnId"
      params={{ organizationId, returnId: item.id }}
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
    const definition = collectionField(returnsCatalog, field);
    if (!definition?.filter) return;
    const where = whereWithCellValue(
      view.state.where as ConditionWhere,
      { id: field, type: definition.type, operators: definition.filter },
      value,
      exclude,
    );
    if (where)
      view.change({ ...view.state, where: where as typeof state.where });
  };
  const filtered = !!q.trim() || state.where.conditions.length > 0;
  const viewName = view.saved?.name ?? returnSegmentLabel(segment);
  const sortLabel = state.sort
    ? (returnsPresentation[state.sort.field]?.label() ?? state.sort.field)
    : '';
  const shownReturn = open ? rowsById.get(open) : undefined;
  const hasRows = !!data && (data.items.length > 0 || groups.length > 0);
  const listError = error && error.kind !== 'invalid' ? error : undefined;
  // Counts follow the search and conditions; one chosen stage counts within this view.
  const total = !data
    ? undefined
    : stage
      ? segment === 'all' || stageViews[stage] === segment
        ? (data.counts.stages[stage] ?? 0)
        : 0
      : (data.counts.views[segment] ?? 0);
  const from = recordReturnPath(organizationId, search.from);
  const system = (connectionId: string) =>
    sources.find((source) => source.connectionId === connectionId)?.system ??
    null;

  const results =
    data && error?.kind !== 'access' && error?.kind !== 'invalid' ? (
      <ReturnResults
        list={data}
        layout={state.layout}
        density={state.density}
        grouping={grouping}
        caption={m.returns_list_caption({
          view: stage ? stageLabels[stage] : viewName,
          sort: sortLabel,
        })}
        link={rowLink}
        empty={
          <ReturnsEmpty
            organizationId={organizationId}
            list={data}
            view={segment}
            filtered={filtered}
            clear={() => {
              setQ('');
              view.reset();
            }}
            showAll={() => view.open('builtin:all')}
          />
        }
        sort={
          state.sort
            ? { key: state.sort.field, direction: state.sort.direction }
            : undefined
        }
        onSortChange={(next) =>
          sorted.change({
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
          returnGroupLabel(
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
    <ReturnsView
      back={
        from ? <Link to={from}>← {m.returns_back_to_context()}</Link> : null
      }
      stages={
        data ? (
          <StageStrip list={data} selected={stage} choose={chooseStage} />
        ) : null
      }
      toolbar={
        <CollectionToolbar
          views={
            <CollectionViewBar
              organizationId={organizationId}
              view={view}
              path="returns"
              segmentLabel={returnSegmentLabel}
              exportColumns={controls.columns.map((id) => ({
                id,
                label: returnsPresentation[id]?.label() ?? id,
              }))}
            />
          }
          search={{
            value: q || undefined,
            onChange: (text) => {
              setQ(text ?? '');
              go({ ...returnFilters(search), ...context });
            },
            label: m.returns_list_search_label(),
            placeholder: m.returns_list_search_placeholder(),
            inputRef: searchInput,
          }}
          filters={controls.filters}
          conditions={controls.conditions}
          actions={
            <DescribedFilter
              organizationId={organizationId}
              domain="returns"
              listName={m.returns_page_title()}
              fields={controls.conditions.fields}
              apply={(conditions) =>
                view.change({
                  ...view.state,
                  where: {
                    match: view.state.where.match,
                    conditions: [...view.state.where.conditions, ...conditions],
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
          refreshLabel={m.returns_list_refresh()}
        />
      }
      coverage={
        <>
          <ReturnDeadlines organizationId={organizationId} />
          <SyncCoverage organizationId={organizationId} type="returns" />
        </>
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
          {sources
            .filter((source) => source.access !== 'granted')
            .map((source) => (
              <Alert key={source.connectionId} tone="info">
                <p>{accessMessage(source)}</p>
                <Link
                  to="/app/$organizationId/connections"
                  params={{ organizationId }}
                >
                  {m.returns_review_connections()}
                </Link>
              </Alert>
            ))}
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
              totalCount={total}
              page={paging.page}
              pageSize={returnPageSize}
              hasNext={!!paging.next}
              onPrevious={paging.previous}
              onNext={() => paging.next?.()}
              formatTotal={(count) =>
                m.returns_list_pagination_total({ count })
              }
              label={m.returns_list_pagination_label()}
            />
            {paging.first && !paging.previous ? (
              <Button variant="ghost" onClick={paging.first}>
                {m.returns_go_first_page()}
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
              title: shownReturn ? returnLabel(shownReturn) : undefined,
              actions: open ? (
                <Link
                  to="/app/$organizationId/returns/$returnId"
                  params={{ organizationId, returnId: open }}
                  search={detailSearch}
                  className={buttonVariants({ variant: 'ghost', size: 'icon' })}
                  aria-label={m.returns_preview_open()}
                  title={m.returns_preview_open()}
                >
                  <Maximize2 aria-hidden="true" />
                </Link>
              ) : null,
              content: open ? (
                <ReturnPreview
                  key={open}
                  organizationId={organizationId}
                  returnId={open}
                  item={shownReturn}
                  sourceLabel={sourceLabel}
                  sourceSystem={system}
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

/** Shows pending work by stage; choosing a stage narrows the list to it. */
export function StageStrip({
  list,
  selected,
  choose,
}: {
  list: ReturnList;
  selected: ReturnStage | undefined;
  choose: (stage: ReturnStage | undefined) => void;
}) {
  return (
    <section className="returns-stages" aria-label={m.returns_stages_label()}>
      {workStages.map((stage) => {
        const count = list.counts.stages[stage] ?? 0;
        const active = selected === stage;

        return (
          <button
            key={stage}
            type="button"
            className="returns-stage"
            aria-pressed={active}
            data-empty={count === 0 || undefined}
            title={stageDescriptions[stage]}
            onClick={() => choose(active ? undefined : stage)}
          >
            <span className="returns-stage-head">
              <StateDot state={count ? stageStates[stage] : 'idle'} />
              <span>{stageLabels[stage]}</span>
            </span>
            <strong>{formatNumber(count)}</strong>
            <small>{stageHints[stage]?.()}</small>
          </button>
        );
      })}
    </section>
  );
}

/**
 * Lays out the Returns page in the shared list order: title, stage cards, toolbar, coverage,
 * summary, notices, then the results with pagination, beside an optional preview pane.
 */
export function ReturnsView({
  back,
  stages,
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
  /** The link back to the record the list was opened from. */
  back?: ReactNode;
  /** Pending work by stage. */
  stages?: ReactNode;
  toolbar: ReactNode;
  /** Deadlines and which sources the list covers. */
  coverage?: ReactNode;
  /** A saved view's metrics and charts. */
  summary?: ReactNode;
  notices?: ReactNode;
  /** Actions for the selected returns, shown above the results. */
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
    <div ref={rowsRef} className="returns-results">
      {actions}
      {results ?? (loading ? <CollectionLoading /> : null)}
      {pagination}
    </div>
  );

  return (
    <main className="returns-page">
      {back}
      <PageTitle title={m.returns_page_title()} />
      {stages}
      {toolbar}
      {coverage}
      <p className="returns-note">{m.returns_list_note()}</p>
      {summary}
      {notices}
      {preview ? (
        <CollectionPreview
          className="returns-preview"
          open={preview.open}
          list={body}
          preview={preview.content}
          label={m.returns_preview_label()}
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

/** Explains an empty list: nothing shared yet, nothing pending, or no match. */
export function ReturnsEmpty({
  organizationId,
  list,
  view,
  filtered,
  clear,
  showAll,
}: {
  organizationId: string;
  list: ReturnList;
  view: ReturnView;
  filtered: boolean;
  clear: () => void;
  showAll: () => void;
}) {
  if (filtered)
    return (
      <Empty>
        <Search size={30} aria-hidden="true" />
        <h2>{m.returns_empty_filtered_title()}</h2>
        <p>{m.returns_empty_filtered_body()}</p>
        <Button onClick={clear} variant="outline">
          {m.common_clear_filters()}
        </Button>
      </Empty>
    );
  if (!list.counts.views.all) {
    const sharing = list.sources.some((source) => source.access === 'granted');
    const importing = list.sources.some((source) => source.importing);

    return (
      <Empty>
        <Undo2 size={30} aria-hidden="true" />
        <h2>
          {sharing
            ? importing
              ? m.returns_empty_importing_title()
              : m.returns_empty_none_title()
            : m.returns_empty_not_shared_title()}
        </h2>
        <p>
          {sharing
            ? importing
              ? m.returns_empty_importing_body()
              : m.returns_empty_none_body()
            : m.returns_empty_not_shared_body()}
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
            ? m.returns_open_data_sync()
            : m.returns_review_connections()}
        </Link>
      </Empty>
    );
  }

  return (
    <Empty>
      <CircleCheck size={30} aria-hidden="true" />
      <h2>{emptyViewTitles[view]()}</h2>
      <p>
        {view !== 'action'
          ? m.returns_empty_view_other_body()
          : list.counts.views.waiting
            ? m.returns_empty_view_action_body_waiting({
                count: list.counts.views.waiting,
              })
            : m.returns_empty_view_action_body()}
      </p>
      <Button onClick={showAll} variant="outline">
        {m.returns_show_all()}
      </Button>
    </Empty>
  );
}

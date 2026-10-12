import './returns.css';

import {
  type ReturnList,
  type ReturnListItem,
  type ReturnStage,
  returnStageSchema,
  type ReturnView,
} from '@luma/api-contract';
import { formatNumber, formatRelativeTime } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import {
  CollectionToolbar,
  CollectionViews,
} from '@luma/ui/components/primitives/collection-toolbar';
import {
  DataTable,
  type DataTableColumn,
  DataTableRowLink,
} from '@luma/ui/components/primitives/data-table';
import { Empty } from '@luma/ui/components/primitives/empty';
import { StateDot, StatePill } from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { PageTitle } from '@luma/ui/components/workspace/page-header';
import { onlineManager, useQuery } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { CircleCheck, CircleDot, Plug, Search, Undo2 } from 'lucide-react';
import { type ReactNode, useState, useSyncExternalStore } from 'react';

import { SignInRedirect } from '../../kit/identity/common';
import { IdentityError } from '../../kit/identity/data';
import { recordReturnPath } from '../records/data';
import { SyncCoverage } from '../sync/coverage';
import {
  defaultSort,
  defaultView,
  returnFilters,
  returnsOptions,
  type ReturnSort,
  type ReturnsSearch,
} from './data';
import { ReturnDeadlines } from './deadlines';
import {
  accessMessage,
  nextStep,
  refundSummary,
  returnLabel,
  stageDescriptions,
  stageLabels,
  stageStates,
  units,
  viewDescriptions,
  viewLabels,
  workStages,
} from './presentation';

const subscribe = (changed: () => void) => onlineManager.subscribe(changed);
const onlineSnapshot = () => onlineManager.isOnline();
const serverSnapshot = () => true;

const stageHints: Partial<Record<ReturnStage, () => string>> = {
  requested: m.returns_stage_hint_requested,
  awaiting_items: m.returns_stage_hint_awaiting_items,
  awaiting_refund: m.returns_stage_hint_awaiting_refund,
  refund_pending: m.returns_stage_hint_refund_pending,
  refund_failed: m.returns_stage_hint_refund_failed,
  ready_to_close: m.returns_stage_hint_ready_to_close,
};

const sorts: readonly ReturnSort[] = ['oldest', 'newest', 'activity'];

const sortLabels: Record<ReturnSort, () => string> = {
  oldest: m.returns_sort_oldest,
  newest: m.returns_sort_newest,
  activity: m.returns_sort_activity,
};

const emptyViewTitles: Record<ReturnView, () => string> = {
  action: m.returns_empty_view_action_title,
  waiting: m.returns_empty_view_waiting_title,
  done: m.returns_empty_view_done_title,
  all: m.returns_empty_view_all_title,
};

/** Connects the returns list to workspace-scoped queries and shareable URL filters. */
export function ReturnsPage() {
  const { organizationId } = useParams({
    from: '/app/$organizationId/returns/',
  });
  const search = useSearch({ from: '/app/$organizationId/returns/' });
  const navigate = useNavigate({ from: '/app/$organizationId/returns/' });
  const query = useQuery(returnsOptions(organizationId, search));
  const online = useSyncExternalStore(
    subscribe,
    onlineSnapshot,
    serverSnapshot,
  );
  const [trails, setTrails] = useState<Record<string, (string | undefined)[]>>(
    {},
  );
  const filterKey = JSON.stringify(returnFilters(search));
  const trail = trails[filterKey] ?? [undefined];
  const index = trail.indexOf(search.cursor);
  if (query.error instanceof IdentityError && query.error.status === 401)
    return <SignInRedirect />;
  const change = (next: ReturnsSearch) =>
    void navigate({ search: next, resetScroll: false });

  return (
    <ReturnsView
      organizationId={organizationId}
      coverage={
        <>
          <ReturnDeadlines organizationId={organizationId} />
          <SyncCoverage organizationId={organizationId} type="returns" />
        </>
      }
      search={search}
      list={query.isError ? undefined : query.data}
      stale={query.isError ? query.data : undefined}
      loading={query.isPending}
      error={query.error?.message}
      offline={!online}
      refreshing={query.isFetching}
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
              change({ ...search, cursor });
            }
          : undefined
      }
      previous={
        index > 0
          ? () => change({ ...search, cursor: trail[index - 1] })
          : undefined
      }
      refresh={() => void query.refetch()}
    />
  );
}

/** Shows pending work by stage; choosing a stage filters the list to it. */
function StageStrip({
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

function returnColumns(
  organizationId: string,
  search: ReturnsSearch,
  list: ReturnList,
): DataTableColumn<ReturnListItem>[] {
  const source = (connectionId: string) =>
    list.sources.find((item) => item.connectionId === connectionId);
  const sourceLabel = (connectionId: string) =>
    source(connectionId)?.label ?? m.returns_source_fallback();
  const now = Date.parse(list.asOf);

  return [
    {
      key: 'return',
      header: m.returns_column_return(),
      cell: (item) => (
        <div className="returns-cell">
          <DataTableRowLink
            render={
              <Link
                to="/app/$organizationId/returns/$returnId"
                params={{ organizationId, returnId: item.id }}
                search={search}
              />
            }
          >
            {returnLabel(item)}
          </DataTableRowLink>
          <small>
            {item.kind === 'refund'
              ? m.returns_row_refund_context({
                  source: sourceLabel(item.connectionId),
                })
              : m.returns_row_order_context({
                  order: item.order.displayNumber ?? item.order.id.slice(0, 8),
                  source: sourceLabel(item.connectionId),
                })}
          </small>
        </div>
      ),
    },
    {
      key: 'stage',
      header: m.returns_column_stage(),
      cell: (item) => (
        <div className="returns-cell">
          <StatePill state={stageStates[item.stage]}>
            {stageLabels[item.stage]}
          </StatePill>
          <small>
            {nextStep(item, source(item.connectionId)?.system ?? null)}
          </small>
        </div>
      ),
    },
    {
      key: 'items',
      header: m.returns_column_items(),
      hideOnNarrow: true,
      cell: (item) =>
        item.kind === 'refund' ? (
          <span className="returns-muted">
            {item.refundedUnits
              ? m.returns_row_units_refunded({
                  units: units(item.refundedUnits),
                })
              : m.returns_row_no_items()}
          </span>
        ) : (
          <div className="returns-cell">
            <span>
              {item.received === null
                ? m.returns_row_units_requested({ units: units(item.quantity) })
                : m.returns_row_units_received({
                    received: units(item.received),
                    quantity: units(item.quantity),
                  })}
            </span>
            <small>
              {item.reasons.length
                ? item.reasons.slice(0, 2).join(', ')
                : m.returns_row_no_reason()}
              {item.reasons.length > 2
                ? ` +${formatNumber(item.reasons.length - 2)}`
                : ''}
            </small>
          </div>
        ),
    },
    {
      key: 'refund',
      header: m.returns_column_refund(),
      cell: (item) => (
        <div className="returns-cell">
          <span
            className={
              item.refund.state === 'refunded' ||
              item.refund.state === 'partial'
                ? 'returns-money'
                : undefined
            }
          >
            {refundSummary(item)}
          </span>
          {item.refund.failedAttempts && item.refund.state !== 'failed' ? (
            <small>
              <Badge tone="danger">
                {m.returns_row_failed_payments({
                  count: item.refund.failedAttempts,
                })}
              </Badge>
            </small>
          ) : null}
        </div>
      ),
    },
    {
      key: 'requested',
      header: m.returns_column_requested(),
      hideOnNarrow: true,
      cell: (item) =>
        item.requestedAt ? (
          <div className="returns-cell">
            <WorkspaceDate value={item.requestedAt} />
            <small>{formatRelativeTime(item.requestedAt, now)}</small>
          </div>
        ) : (
          <span className="returns-muted">{m.common_not_reported()}</span>
        ),
    },
    {
      key: 'activity',
      header: m.returns_column_activity(),
      hideOnNarrow: true,
      cell: (item) => <WorkspaceDate value={item.activityAt} />,
    },
  ];
}

/** Presents returns and refunds by stage with views, filters, source access and paging. */
export function ReturnsView({
  organizationId,
  search,
  list,
  stale,
  loading = false,
  error,
  offline = false,
  refreshing = false,
  change,
  refresh,
  next,
  previous,
  coverage,
}: {
  organizationId: string;
  search: ReturnsSearch;
  list?: ReturnList | undefined;
  /** The last loaded page, shown read-only after a failed refresh. */
  stale?: ReturnList | undefined;
  loading?: boolean;
  error?: string | undefined;
  offline?: boolean;
  refreshing?: boolean;
  change: (search: ReturnsSearch) => void;
  refresh: () => void;
  next?: (() => void) | undefined;
  previous?: (() => void) | undefined;
  /** Which sources and dates the list covers. */
  coverage?: ReactNode;
}) {
  const update = (patch: Partial<ReturnsSearch>) =>
    change({ ...returnFilters(search), from: search.from, ...patch });
  const clear = () => change({ from: search.from });
  // A stage spans views, so choosing one shows it across all returns.
  const chooseStage = (stage: ReturnStage | undefined) =>
    update(stage ? { stage, view: 'all' } : { stage: undefined });
  const from = recordReturnPath(organizationId, search.from);
  const view = search.view ?? defaultView;
  const sort = search.sort ?? defaultSort(view);
  const shownList = list ?? stale;
  const sources = shownList?.sources ?? [];
  const sharing = sources.filter((source) => source.access === 'granted');
  const missingAccess = sources.filter((source) => source.access !== 'granted');
  const sourceLabel = (id: string | undefined) =>
    sources.find((source) => source.connectionId === id)?.label ??
    m.returns_filter_selected_source();
  // Only sources that share returns are offered; a linked source stays readable as a chip.
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
      label: sourceLabel(search.connectionId),
    });
  const filtered = !!(search.q || search.connectionId || search.stage);
  const views: ReturnView[] = ['action', 'waiting', 'done', 'all'];
  const total = shownList?.counts.views[view] ?? 0;
  const matching = search.stage
    ? (shownList?.counts.stages[search.stage] ?? 0)
    : total;

  return (
    <main className="returns-page">
      {from ? <Link to={from}>← {m.returns_back_to_context()}</Link> : null}
      <PageTitle title={m.returns_page_title()} />
      {shownList ? (
        <StageStrip
          list={shownList}
          selected={search.stage}
          choose={chooseStage}
        />
      ) : null}
      <CollectionToolbar
        refreshLabel={m.returns_list_refresh()}
        refreshing={refreshing}
        onRefresh={refresh}
        views={
          <CollectionViews
            label={m.returns_list_views_label()}
            value={view}
            views={views.map((option) => ({
              value: option,
              label: viewLabels[option],
              description: viewDescriptions[option],
              count: shownList?.counts.views[option],
              attention: option === 'action',
            }))}
            onChange={(option) => update({ view: option, sort: undefined })}
          />
        }
        search={{
          value: search.q,
          onChange: (q) => update({ q }),
          label: m.returns_list_search_label(),
          placeholder: m.returns_list_search_placeholder(),
        }}
        filters={[
          {
            kind: 'choice',
            key: 'stage',
            label: m.returns_filter_stage(),
            icon: CircleDot,
            value: search.stage,
            options: returnStageSchema.options.map((value) => ({
              value,
              label: stageLabels[value],
            })),
            onChange: (value) =>
              chooseStage(
                returnStageSchema.options.find((item) => item === value),
              ),
          },
          {
            kind: 'choice',
            key: 'connectionId',
            label: m.returns_filter_source(),
            icon: Plug,
            value: search.connectionId,
            options: sourceOptions,
            onChange: (connectionId) => update({ connectionId }),
          },
        ]}
        sort={{
          value: sort,
          options: sorts.map((value) => ({
            value,
            label: sortLabels[value](),
          })),
          onChange: (value) => {
            const next = sorts.find((item) => item === value);
            update({ sort: next === defaultSort(view) ? undefined : next });
          },
        }}
        onClear={() =>
          change({ from: search.from, view: search.view, sort: search.sort })
        }
      />
      {coverage}
      <p className="returns-note">{m.returns_list_note()}</p>
      {missingAccess.map((source) => (
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
      {offline ? <Alert role="status">{m.returns_list_offline()}</Alert> : null}
      {error ? (
        <Alert tone="danger" role="alert">
          {stale
            ? m.returns_list_refresh_failed()
            : `${m.returns_list_load_failed()} ${error}`}{' '}
          <Button variant="outline" onClick={refresh}>
            {m.common_retry()}
          </Button>
          {search.cursor ? (
            <Button variant="ghost" onClick={() => update({})}>
              {m.returns_go_first_page()}
            </Button>
          ) : null}
        </Alert>
      ) : null}
      {shownList ? (
        <>
          <DataTable
            className="returns-list-table"
            caption={m.returns_list_caption({
              view: search.stage ? stageLabels[search.stage] : viewLabels[view],
            })}
            columns={returnColumns(organizationId, search, shownList)}
            rows={shownList.items}
            rowKey={(item) => item.id}
            empty={
              <ReturnsEmpty
                organizationId={organizationId}
                list={shownList}
                view={view}
                filtered={filtered}
                clear={clear}
                showAll={() => update({ view: 'all' })}
              />
            }
          />
          {shownList.items.length ? (
            <div className="returns-pagination">
              <span>
                {search.cursor
                  ? m.returns_list_page_count_paged({
                      shown: shownList.items.length,
                      total: matching,
                    })
                  : m.returns_list_page_count({
                      shown: shownList.items.length,
                      total: matching,
                    })}
              </span>
              <div>
                {previous ? (
                  <Button variant="outline" onClick={previous}>
                    {m.returns_previous_page()}
                  </Button>
                ) : null}
                {search.cursor ? (
                  <Button variant="ghost" onClick={() => update({})}>
                    {m.returns_first_page()}
                  </Button>
                ) : null}
                <Button variant="outline" disabled={!next} onClick={next}>
                  {m.returns_next_page()}
                </Button>
              </div>
            </div>
          ) : null}
        </>
      ) : loading && !error ? (
        <div className="returns-loading" role="status">
          <span className="sr-only">{m.returns_list_loading()}</span>
          {Array.from({ length: 5 }, (_, i) => (
            <span className="lu-skeleton" key={i} />
          ))}
        </div>
      ) : null}
    </main>
  );
}

/** Explains an empty list: nothing shared yet, nothing pending, or no match. */
function ReturnsEmpty({
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

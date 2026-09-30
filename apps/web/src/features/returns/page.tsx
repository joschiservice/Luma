import './returns.css';

import type {
  ReturnList,
  ReturnListItem,
  ReturnStage,
  ReturnView,
} from '@luma/api-contract';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { CollectionToolbar } from '@luma/ui/components/primitives/collection-toolbar';
import {
  DataTable,
  type DataTableColumn,
  DataTableRowLink,
} from '@luma/ui/components/primitives/data-table';
import { DomainIcon } from '@luma/ui/components/primitives/domain-icon';
import { Empty } from '@luma/ui/components/primitives/empty';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { StateDot, StatePill } from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { PageHeader } from '@luma/ui/components/workspace/page-header';
import { onlineManager, useQuery } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { CircleCheck, Search, Undo2 } from 'lucide-react';
import { type ReactNode, useState, useSyncExternalStore } from 'react';

import { SignInRedirect } from '../identity/common';
import { IdentityError } from '../identity/data';
import { recordReturnPath } from '../records/data';
import { ago } from '../sync/presentation';
import {
  defaultSort,
  defaultView,
  returnFilters,
  returnsOptions,
  type ReturnSort,
  type ReturnsSearch,
} from './data';
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

const stageHints: Partial<Record<ReturnStage, string>> = {
  requested: 'Approve or decline',
  awaiting_items: 'With the customer',
  awaiting_refund: 'Issue the refund',
  refund_pending: 'With the payment provider',
  refund_failed: 'Retry the refund',
  ready_to_close: 'Close the return',
};

const sortLabels: Record<ReturnSort, string> = {
  oldest: 'Oldest request first',
  newest: 'Newest request first',
  activity: 'Latest activity first',
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
    <section className="returns-stages" aria-label="Pending work by stage">
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
            onClick={() => choose(active ? undefined : stage)}
          >
            <span className="returns-stage-head">
              <StateDot state={count ? stageStates[stage] : 'idle'} />
              <span>{stageLabels[stage]}</span>
            </span>
            <strong>{count.toLocaleString()}</strong>
            <small>{stageHints[stage]}</small>
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
  const now = Date.parse(list.asOf);

  return [
    {
      key: 'return',
      header: 'Return',
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
              ? 'Refund without a return'
              : `Order ${item.order.displayNumber ?? item.order.id.slice(0, 8)}`}
            {' · '}
            {source(item.connectionId)?.label ?? 'Connected source'}
          </small>
        </div>
      ),
    },
    {
      key: 'stage',
      header: 'Stage',
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
      header: 'Items',
      hideOnNarrow: true,
      cell: (item) =>
        item.kind === 'refund' ? (
          <span className="returns-muted">
            {item.refundedUnits
              ? `${units(item.refundedUnits)} refunded`
              : 'No items'}
          </span>
        ) : (
          <div className="returns-cell">
            <span>
              {item.received === null
                ? `${units(item.quantity)} requested`
                : `${units(item.received)} of ${units(item.quantity)} received`}
            </span>
            <small>
              {item.reasons.length
                ? item.reasons.slice(0, 2).join(', ')
                : 'No reason given'}
              {item.reasons.length > 2 ? ` +${item.reasons.length - 2}` : ''}
            </small>
          </div>
        ),
    },
    {
      key: 'refund',
      header: 'Refund',
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
                {item.refund.failedAttempts} failed{' '}
                {item.refund.failedAttempts === 1 ? 'payment' : 'payments'}
              </Badge>
            </small>
          ) : null}
        </div>
      ),
    },
    {
      key: 'requested',
      header: 'Requested',
      hideOnNarrow: true,
      cell: (item) =>
        item.requestedAt ? (
          <div className="returns-cell">
            <WorkspaceDate value={item.requestedAt} />
            <small>{ago(item.requestedAt, now)}</small>
          </div>
        ) : (
          <span className="returns-muted">Not reported</span>
        ),
    },
    {
      key: 'activity',
      header: 'Last activity',
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
  const [draft, setDraft] = useState(search.q ?? '');
  const [shown, setShown] = useState(search.q);
  if (shown !== search.q) {
    setShown(search.q);
    setDraft(search.q ?? '');
  }
  const update = (patch: Partial<ReturnsSearch>) =>
    change({ ...returnFilters(search), from: search.from, ...patch });
  const clear = () => {
    setDraft('');
    change({ from: search.from });
  };
  const from = recordReturnPath(organizationId, search.from);
  const view = search.view ?? defaultView;
  const sort = search.sort ?? defaultSort(view);
  const shownList = list ?? stale;
  const sources = shownList?.sources ?? [];
  const sharing = sources.filter((source) => source.access === 'granted');
  const missingAccess = sources.filter((source) => source.access !== 'granted');
  const sourceLabel = (id: string | undefined) =>
    sources.find((source) => source.connectionId === id)?.label ??
    'Selected source';
  const filtered = !!(search.q || search.connectionId || search.stage);
  const views: ReturnView[] = ['action', 'waiting', 'done', 'all'];
  const total = shownList?.counts.views[view] ?? 0;
  const matching = search.stage
    ? (shownList?.counts.stages[search.stage] ?? 0)
    : total;

  return (
    <main className="returns-page">
      {from ? <Link to={from}>← Back to context</Link> : null}
      <PageHeader
        title="Returns"
        icon={<DomainIcon domain="returns" size="md" />}
        description="Follow every return from request to refund, with its order and evidence. Only successful refund payments count as money returned."
      />
      {shownList ? (
        <StageStrip
          list={shownList}
          selected={search.stage}
          choose={(stage) =>
            update(stage ? { stage, view: 'all' } : { stage: undefined })
          }
        />
      ) : null}
      <CollectionToolbar
        refreshLabel="Refresh returns"
        refreshing={refreshing}
        onRefresh={refresh}
        views={
          <div className="returns-views" role="group" aria-label="Views">
            {views.map((option) => (
              <Button
                key={option}
                variant="ghost"
                aria-pressed={view === option}
                onClick={() => update({ view: option, sort: undefined })}
              >
                {viewLabels[option]}
                {shownList ? (
                  <Badge
                    tone={
                      option === 'action' && shownList.counts.views.action
                        ? 'warning'
                        : 'neutral'
                    }
                  >
                    {shownList.counts.views[option]}
                  </Badge>
                ) : null}
              </Button>
            ))}
          </div>
        }
        filters={[
          ...(search.q
            ? [
                {
                  key: 'q',
                  label: `Search: ${search.q}`,
                  onRemove: () => update({ q: undefined }),
                },
              ]
            : []),
          ...(search.stage
            ? [
                {
                  key: 'stage',
                  label: `Stage: ${stageLabels[search.stage]}`,
                  onRemove: () => update({ stage: undefined }),
                },
              ]
            : []),
          ...(search.connectionId
            ? [
                {
                  key: 'connectionId',
                  label: `From ${sourceLabel(search.connectionId)}`,
                  onRemove: () => update({ connectionId: undefined }),
                },
              ]
            : []),
        ]}
        onClear={clear}
      >
        <form
          className="returns-search"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            update({ q: draft.trim() || undefined });
          }}
        >
          <Search size={16} aria-hidden="true" />
          <Input
            aria-label="Search returns"
            placeholder="Return, order number, reason or source ID…"
            maxLength={120}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button variant="outline" type="submit">
            Search
          </Button>
        </form>
        {sharing.length > 1 ? (
          <Select
            aria-label="Source"
            value={search.connectionId ?? ''}
            options={[
              { value: '', label: 'All sources' },
              ...sharing.map((source) => ({
                value: source.connectionId,
                label: source.label,
              })),
            ]}
            onValueChange={(value) =>
              update({ connectionId: value || undefined })
            }
          />
        ) : null}
        <Select
          aria-label="Sort"
          value={sort}
          options={(['oldest', 'newest', 'activity'] as const).map((value) => ({
            value,
            label: sortLabels[value],
          }))}
          onValueChange={(value) => update({ sort: value as ReturnSort })}
        />
      </CollectionToolbar>
      <p className="returns-note">
        {search.stage
          ? stageDescriptions[search.stage]
          : viewDescriptions[view]}{' '}
        Luma reads returns from your store and never approves, receives or
        refunds them.
      </p>
      {missingAccess.map((source) => (
        <Alert key={source.connectionId} tone="info">
          <p>{accessMessage(source)}</p>
          <Link
            to="/app/$organizationId/connections"
            params={{ organizationId }}
          >
            Review connections
          </Link>
        </Alert>
      ))}
      {coverage}
      {offline ? (
        <Alert role="status">
          You are offline. Reconnect to refresh returns.
        </Alert>
      ) : null}
      {error ? (
        <Alert tone="danger" role="alert">
          {stale
            ? 'Returns could not be refreshed. The list below may be out of date.'
            : error}{' '}
          <Button variant="outline" onClick={refresh}>
            Retry
          </Button>
          {search.cursor ? (
            <Button variant="ghost" onClick={() => update({})}>
              Go to first page
            </Button>
          ) : null}
        </Alert>
      ) : null}
      {shownList ? (
        <>
          <DataTable
            className="returns-list-table"
            caption={`${search.stage ? stageLabels[search.stage] : viewLabels[view]} returns and refunds`}
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
                {shownList.items.length} of {matching.toLocaleString()}
                {search.cursor ? ' on this page' : ''}
              </span>
              <div>
                {previous ? (
                  <Button
                    variant="outline"
                    disabled={refreshing}
                    onClick={previous}
                  >
                    Previous page
                  </Button>
                ) : null}
                {search.cursor ? (
                  <Button variant="ghost" onClick={() => update({})}>
                    First page
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  disabled={!next || refreshing}
                  onClick={next}
                >
                  Next page
                </Button>
              </div>
            </div>
          ) : null}
        </>
      ) : loading && !error ? (
        <div className="returns-loading" role="status">
          <span className="sr-only">Loading returns…</span>
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
        <h2>No returns match</h2>
        <p>Try another return name, order number, reason or source.</p>
        <Button onClick={clear} variant="outline">
          Clear filters
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
              ? 'Importing returns'
              : 'No returns yet'
            : 'Returns are not shared yet'}
        </h2>
        <p>
          {sharing
            ? importing
              ? 'Luma is reading return history from your store. Returns appear here as they are imported.'
              : 'No connected store has reported a return or refund. New returns appear here after the next sync.'
            : 'Returns appear here once a connected store shares returns and refunds with Luma.'}
        </p>
        <Link
          to={
            sharing
              ? '/app/$organizationId/sync'
              : '/app/$organizationId/connections'
          }
          params={{ organizationId }}
        >
          {sharing ? 'Open Data sync' : 'Review connections'}
        </Link>
      </Empty>
    );
  }

  return (
    <Empty>
      <CircleCheck size={30} aria-hidden="true" />
      <h2>
        {view === 'action'
          ? 'Nothing needs action'
          : `No ${viewLabels[view].toLowerCase()} returns`}
      </h2>
      <p>
        {view === 'action'
          ? `Every return is waiting on the customer or payment provider, or is done. ${
              list.counts.views.waiting
                ? `${list.counts.views.waiting.toLocaleString()} waiting.`
                : ''
            }`
          : 'Other views have returns.'}
      </p>
      <Button onClick={showAll} variant="outline">
        Show all returns
      </Button>
    </Empty>
  );
}

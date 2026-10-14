import './activity.css';

import {
  activityCatalog,
  type ActivityEvent,
  activityOutcomes,
  type ActivityPage as Page,
  activityTypes,
  type CollectionViewState,
} from '@luma/api-contract';
import { formatList } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { CollectionFilterPanel } from '@luma/ui/components/primitives/collection-filters';
import {
  type CollectionFilter,
  CollectionToolbar,
} from '@luma/ui/components/primitives/collection-toolbar';
import { Empty } from '@luma/ui/components/primitives/empty';
import { StateDot, StatePill } from '@luma/ui/components/primitives/state';
import {
  formatWorkspaceDateTime,
  WorkspaceDate,
  WorkspaceTimezone,
} from '@luma/ui/components/primitives/workspace-date';
import { PageTitle } from '@luma/ui/components/workspace/page-header';
import { actorLabel } from '@luma/ui/lib/actor';
import { calendarPresets } from '@luma/ui/lib/date-range';
import { workspaceDateValue } from '@luma/ui/lib/timezone';
import { onlineManager, useQuery } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import {
  CalendarDays,
  ChevronDown,
  CircleDot,
  Plug,
  Server,
  Tag,
  UserRound,
} from 'lucide-react';
import {
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from 'react';

import type { CollectionSearch } from '../../kit/collections/state';
import { useCollectionView } from '../../kit/collections/use-collection-view';
import { CollectionViewBar } from '../../kit/collections/view-bar';
import { connectionsOptions } from '../../kit/connections/data';
import { SignInRedirect } from '../../kit/identity/common';
import { IdentityError } from '../../kit/identity/data';
import { membersOptions } from '../../kit/settings/data';
import { providerName } from '../sync/presentation';
import {
  activityConditions,
  type ActivityFilters,
  activityFiltersOf,
  activityOptions,
  activityRange,
  type ActivitySearch,
} from './data';
import {
  activityChangeLabel,
  activityConnectionOptions,
  activityLabel,
  type ActivitySource,
  activityState,
  activitySystemOptions,
} from './presentation';

const label = activityLabel;

type Label = () => string;

// Recorded detail values that Luma knows; other values are shown as recorded.
const changeStates: Record<string, Label> = {
  unknown: m.activity_state_unknown,
  prepared: m.activity_state_prepared,
  failed: m.activity_state_failed,
};
const checkStages: Record<string, Label> = {
  pending: m.activity_phase_pending,
};
const requestStates: Record<string, Label> = {
  dispatched: m.activity_request_dispatched,
  accepted: m.activity_request_accepted,
};
const checkResults: Record<string, Label> = {
  passed: m.activity_check_passed,
  failed: m.activity_check_failed,
  inconclusive: m.activity_check_inconclusive,
};

/** Reads a recorded detail value through `labels`, or "Not recorded" when it is missing. */
const detail = (
  labels: Record<string, Label>,
  value: string | null | undefined,
) => (value ? (labels[value]?.() ?? value) : m.activity_not_recorded());

/** Formats a recorded instant in workspace time with seconds, as audit detail needs them. */
const instant = (value: string, timeZone: string) =>
  formatWorkspaceDateTime(value, timeZone, 'second');
const subscribe = (changed: () => void) => onlineManager.subscribe(changed);
const snapshot = () => onlineManager.isOnline();
const serverSnapshot = () => true;

/**
 * Connects workspace history to the member's view: filters live in the view's conditions, so
 * combinations can be saved, shared and remembered, while search text, the page position and
 * the open event stay in the URL. Every read runs with the reader's own visibility, so a shared
 * view never shows events the reader couldn't see otherwise.
 */
export function ActivityPage() {
  const { organizationId } = useParams({ from: '/app/$organizationId' });
  const search = useSearch({ from: '/app/$organizationId/activity' });
  const navigate = useNavigate({ from: '/app/$organizationId/activity' });
  const timeZone = useContext(WorkspaceTimezone);
  // A filter change carries the search text of the filters it came with; other view changes
  // keep the current search.
  const changing = useRef<{ q: string | undefined } | null>(null);
  const go = (next: ActivitySearch) =>
    void navigate({ search: next, resetScroll: false });
  const view = useCollectionView({
    catalog: activityCatalog,
    organizationId,
    search,
    navigate: (next: Partial<CollectionSearch>) => {
      const q = changing.current ? changing.current.q : search.q;
      go({ ...(q ? { q } : {}), ...next } as ActivitySearch);
    },
  });
  const today = workspaceDateValue(new Date(), timeZone);
  const { filters: conditions, issues } = activityFiltersOf(
    view.state.where,
    today,
  );
  const filters: ActivityFilters = {
    ...conditions,
    q: search.q,
    cursor: search.cursor,
    event: search.event,
    latest: search.latest,
  };
  const invalid = issues.length > 0;
  const page = useQuery({
    ...activityOptions(organizationId, filters, false, timeZone),
    enabled: !invalid,
  });
  const head = useQuery({
    ...activityOptions(organizationId, filters, true, timeZone),
    enabled: !invalid,
  });
  const connections = useQuery(connectionsOptions(organizationId));
  const members = useQuery(membersOptions(organizationId));
  const refreshPage = page.refetch;
  const visibilityChanged =
    !!page.data && !!head.data && page.data.visibility !== head.data.visibility;
  useEffect(() => {
    if (visibilityChanged) {
      void navigate({
        search: {
          ...search,
          cursor: undefined,
          latest: undefined,
          event: undefined,
        },
        replace: true,
        resetScroll: false,
      });
      if (!search.cursor) void refreshPage();
    }
  }, [visibilityChanged, search, navigate, refreshPage]);
  const online = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const error = page.error ?? head.error;
  const accessLost =
    error instanceof IdentityError && [401, 403, 404].includes(error.status);
  // The API rejects a page cursor that no longer matches the filters and explains why.
  const staleMessage =
    page.error instanceof IdentityError &&
    page.error.code === 'VALIDATION_ERROR' &&
    search.cursor
      ? page.error.message
      : undefined;
  if (error instanceof IdentityError && error.status === 401)
    return <SignInRedirect />;
  const newEvents =
    !!page.data &&
    !!head.data?.items.length &&
    head.data.items[0]!.id !== (search.latest ?? page.data.items[0]?.id);
  // The URL's view keys, kept when only the search, page or open event changes.
  const viewKeys: ActivitySearch = { ...search };
  delete viewKeys.q;
  delete viewKeys.cursor;
  delete viewKeys.latest;
  delete viewKeys.event;
  // Removes what Activity can't apply; "match any" of several filters narrows to all of them.
  const repair = () => {
    const broken = new Set(issues.map((issue) => issue.index));
    view.change({
      ...view.state,
      where: {
        match: 'all',
        conditions: view.state.where.conditions.filter(
          (_, index) => !broken.has(index),
        ),
      },
    } satisfies CollectionViewState);
  };

  return (
    <ActivityView
      organizationId={organizationId}
      filters={filters}
      sources={connections.data?.map((connection) => ({
        id: connection.id,
        label: connection.label,
        system: connection.target.kind,
      }))}
      people={members.data?.map((member) => ({
        id: member.userId,
        label: member.name || member.email || m.activity_actor_unknown_person(),
      }))}
      views={
        <CollectionViewBar
          organizationId={organizationId}
          view={view}
          path="activity"
          segmentLabel={() => m.activity_view_all()}
        />
      }
      page={accessLost || visibilityChanged || invalid ? undefined : page.data}
      loading={page.isPending && !invalid}
      refreshing={page.isFetching || head.isFetching}
      offline={!online}
      newEvents={newEvents && !invalid}
      error={
        invalid
          ? m.collections_needs_repair()
          : accessLost
            ? m.activity_error_access_lost()
            : (staleMessage ??
              (error ? m.activity_error_unavailable() : undefined))
      }
      repair={invalid ? repair : undefined}
      stalePage={!!staleMessage}
      change={(next) => {
        const where = activityConditions(next);
        const position = {
          ...(next.q ? { q: next.q } : {}),
          ...(next.cursor ? { cursor: next.cursor } : {}),
          ...(next.latest ? { latest: next.latest } : {}),
          ...(next.event ? { event: next.event } : {}),
        };
        if (
          JSON.stringify(where) ===
          JSON.stringify(activityConditions(conditions))
        )
          return go({ ...viewKeys, ...position });
        changing.current = { q: next.q };
        view.change({
          ...view.state,
          where: { match: 'all', conditions: where },
        });
        changing.current = null;
      }}
      refresh={() => {
        if (search.cursor) {
          void head.refetch();
          if (page.isError) void page.refetch();
        } else {
          void page.refetch();
          void head.refetch();
        }
      }}
    />
  );
}

/** Presents searchable history and bounded provenance, including unavailable and offline states. */
export function ActivityView({
  organizationId,
  filters,
  sources = [],
  people = [],
  views,
  page,
  loading,
  refreshing,
  offline,
  newEvents,
  error,
  repair,
  stalePage = false,
  change,
  refresh,
}: {
  organizationId: string;
  /**
   * The view's filters with search and page position. Dates are set only when chosen;
   * otherwise the last 30 days apply.
   */
  filters: ActivityFilters;
  /** Workspace connections offered as connection and system filters. */
  sources?: readonly ActivitySource[] | undefined;
  /** Workspace members offered in the actor filter after Me, Luma and Workflows. */
  people?: readonly { id: string; label: string }[] | undefined;
  /** The view menu, shown before Refresh. */
  views?: ReactNode;
  /** Removes the view's filters Activity can't apply; offered with the error. */
  repair?: (() => void) | undefined;
  page?: Page | undefined;
  loading?: boolean;
  refreshing?: boolean;
  offline?: boolean;
  newEvents?: boolean;
  error?: string | undefined;
  /** The error is a page link that no longer matches the filters; offers the latest events. */
  stalePage?: boolean;
  change: (filters: ActivityFilters) => void;
  refresh: () => void;
}) {
  const timeZone = useContext(WorkspaceTimezone);
  const today = workspaceDateValue(new Date(), timeZone);
  // Any filter change returns to the latest events and closes the open event.
  const update = (patch: Partial<ActivityFilters>) =>
    change({
      ...filters,
      ...patch,
      cursor: undefined,
      latest: undefined,
      event: undefined,
    });
  // A relative period shows as the range it covers today, so its preset stays selected.
  const shown = filters.last
    ? activityRange(filters, new Date(), timeZone)
    : filters;
  const toolbarFilters: CollectionFilter[] = [
    {
      kind: 'date-range',
      key: 'recorded',
      label: m.activity_filter_recorded(),
      icon: CalendarDays,
      from: shown.from,
      to: shown.to,
      today,
      maxDays: 366,
      fallback: m.activity_filter_last_30_days(),
      // Presets that end today stay relative, so a saved view keeps showing recent events.
      onChange: (range) => {
        const preset = calendarPresets(today).find(
          (item) => item.from === range.from && item.to === range.to,
        );
        update(
          preset
            ? {
                from: undefined,
                to: undefined,
                last: {
                  amount: Math.round(
                    (Date.parse(preset.to) - Date.parse(preset.from)) /
                      86400000,
                  ),
                  unit: 'day',
                },
              }
            : { from: range.from, to: range.to, last: undefined },
        );
      },
    },
    {
      kind: 'multi-choice',
      key: 'actor',
      label: m.activity_filter_actor(),
      icon: UserRound,
      value: filters.actor,
      options: [
        { value: 'me', label: m.activity_actor_me() },
        { value: 'luma', label: m.activity_actor_luma() },
        { value: 'workflow', label: m.activity_actor_workflows() },
        ...people.map((person) => ({ value: person.id, label: person.label })),
        ...(filters.actor ?? [])
          .filter(
            (value) =>
              !['me', 'luma', 'workflow'].includes(value) &&
              !people.some((person) => person.id === value),
          )
          .map((value) => ({
            value,
            label: m.activity_actor_unknown_person(),
          })),
      ],
      onChange: (actor) => update({ actor: actor?.length ? actor : undefined }),
    },
    {
      kind: 'choice',
      key: 'connectionId',
      label: m.activity_filter_connection(),
      icon: Plug,
      value: filters.connectionId,
      options: activityConnectionOptions(sources, filters.connectionId),
      onChange: (connectionId) => update({ connectionId }),
    },
    {
      kind: 'choice',
      key: 'system',
      label: m.activity_filter_system(),
      icon: Server,
      value: filters.system,
      options: activitySystemOptions(sources, filters.system),
      onChange: (system) => update({ system }),
    },
    {
      kind: 'choice',
      key: 'type',
      label: m.activity_filter_type(),
      icon: Tag,
      value: filters.type,
      options: activityTypes.map((value) => ({ value, label: label(value) })),
      onChange: (value) =>
        update({ type: activityTypes.find((item) => item === value) }),
    },
    {
      kind: 'choice',
      key: 'outcome',
      label: m.activity_filter_outcome(),
      icon: CircleDot,
      value: filters.outcome,
      options: activityOutcomes.map((value) => ({
        value,
        label: label(value),
      })),
      onChange: (value) =>
        update({ outcome: activityOutcomes.find((item) => item === value) }),
    },
  ];
  // Paging and the open event aren't filters; an empty page without filters gets its own copy.
  const filtered = Object.entries(filters).some(
    ([key, value]) =>
      (Array.isArray(value) ? value.length > 0 : !!value) &&
      !['cursor', 'event', 'latest'].includes(key),
  );

  return (
    <div className="activity-page">
      <PageTitle title={m.activity_page_title()} />
      <CollectionFilterPanel filters={toolbarFilters}>
        <CollectionToolbar
          panel
          views={views}
          search={{
            value: filters.q,
            onChange: (q) => update({ q }),
            label: m.activity_search_label(),
            placeholder: m.activity_search_placeholder(),
            maxLength: 200,
          }}
          filters={toolbarFilters}
          onClear={() => change({})}
          onRefresh={refresh}
          refreshing={refreshing}
          refreshLabel={m.activity_refresh()}
        />
        <p className="activity-coverage">
          {page ? `${page.coverage} ` : null}
          {m.activity_search_help()}
        </p>
        {offline ? (
          <Alert role="status" className="activity-notice">
            {m.common_offline()}
          </Alert>
        ) : null}
        {error ? (
          <Alert tone="danger" role="alert" className="activity-notice">
            {error}{' '}
            {repair ? (
              <Button variant="outline" onClick={repair}>
                {m.collections_remove_unsupported()}
              </Button>
            ) : stalePage ? (
              <Button
                variant="outline"
                onClick={() =>
                  change({
                    ...filters,
                    cursor: undefined,
                    latest: undefined,
                    event: undefined,
                  })
                }
              >
                {m.activity_latest_events()}
              </Button>
            ) : (
              <Button variant="outline" onClick={refresh}>
                {m.common_retry()}
              </Button>
            )}
          </Alert>
        ) : null}
        {newEvents ? (
          <Button
            variant="outline"
            onClick={() => {
              change({
                ...filters,
                cursor: undefined,
                latest: undefined,
                event: undefined,
              });
              refresh();
            }}
          >
            {m.activity_new_events()}
          </Button>
        ) : null}
        {page ? (
          <>
            {!page.items.length ? (
              filtered ? (
                <Empty className="activity-empty">
                  <h2>{m.activity_empty_filtered_title()}</h2>
                  <p>{m.activity_empty_filtered_description()}</p>
                  <Button variant="outline" onClick={() => change({})}>
                    {m.common_clear_filters()}
                  </Button>
                </Empty>
              ) : (
                <Empty className="activity-empty">
                  <h2>{m.activity_empty_title()}</h2>
                  <p>{m.activity_empty_description()}</p>
                </Empty>
              )
            ) : (
              <ol className="activity-list">
                {Array.from(
                  new Map(page.items.map((item) => [item.id, item])).values(),
                ).map((item, index, items) => (
                  <ActivityRow
                    key={item.id}
                    item={item}
                    related={
                      Boolean(item.attemptId ?? item.proposalId) &&
                      (item.attemptId ?? item.proposalId) ===
                        (items[index - 1]?.attemptId ??
                          items[index - 1]?.proposalId)
                    }
                    organizationId={organizationId}
                    expanded={filters.event === item.id}
                    expand={() =>
                      change({
                        ...filters,
                        event: filters.event === item.id ? undefined : item.id,
                      })
                    }
                  />
                ))}
              </ol>
            )}
            <div className="activity-pagination">
              {filters.cursor ? (
                <Button
                  variant="outline"
                  onClick={() =>
                    change({
                      ...filters,
                      cursor: undefined,
                      latest: undefined,
                      event: undefined,
                    })
                  }
                >
                  {m.activity_latest_events()}
                </Button>
              ) : null}
              <span role="status">
                {page.items.length
                  ? m.activity_page_count({ count: page.items.length })
                  : m.activity_page_count_none()}
              </span>
              {page.nextCursor ? (
                <Button
                  variant="outline"
                  onClick={() =>
                    change({
                      ...filters,
                      cursor: page.nextCursor!,
                      latest: filters.latest ?? page.items[0]?.id,
                      event: undefined,
                    })
                  }
                >
                  {m.activity_older_events()}
                </Button>
              ) : null}
            </div>
          </>
        ) : loading && !error ? (
          <p role="status">{m.activity_loading()}</p>
        ) : null}
      </CollectionFilterPanel>
    </div>
  );
}

function ActivityRow({
  item,
  related,
  organizationId,
  expanded,
  expand,
}: {
  item: ActivityEvent;
  related: boolean;
  organizationId: string;
  expanded: boolean;
  expand: () => void;
}) {
  const timeZone = useContext(WorkspaceTimezone);
  const group = item.attemptId ?? item.proposalId;

  return (
    <li
      className={`activity-event${item.attemptId || item.proposalId ? ' activity-grouped' : ''}${related ? ' activity-related' : ''}`}
    >
      <button
        type="button"
        className="activity-event-toggle"
        aria-expanded={expanded}
        aria-controls={`event-${item.id}`}
        onClick={expand}
      >
        <time dateTime={item.recordedAt}>
          <WorkspaceDate value={item.recordedAt} />
        </time>
        <StateDot state={activityState(item.outcome)} />
        <span className="activity-event-copy">
          <strong>{activityLabel(item.action)}</strong>
          {!related && group ? (
            <small>
              {item.type === 'procurement'
                ? m.activity_row_group_purchase_order({ id: group })
                : m.activity_row_group_attempt({ id: group })}
            </small>
          ) : null}
          <small>
            {m.activity_row_actor_system({
              actor: actorLabel(item.actor),
              system: item.system
                ? providerName(item.system)
                : m.activity_row_system_not_recorded(),
            })}
          </small>
          <small>
            {item.resource ??
              item.exceptionId ??
              item.connectionId ??
              m.activity_row_workspace()}
          </small>
        </span>
        <span className="activity-outcome">
          <StatePill state={activityState(item.outcome)}>
            {label(item.outcome, item.system)}
          </StatePill>
          {item.mode !== 'unrecorded' ? (
            <small>{label(item.mode)}</small>
          ) : null}
        </span>
        <ChevronDown
          className="activity-event-chevron"
          size={15}
          aria-hidden="true"
        />
      </button>
      {expanded ? (
        <div id={`event-${item.id}`} className="activity-evidence">
          <dl>
            <dt>{m.activity_detail_event_id()}</dt>
            <dd>{item.id}</dd>
            <dt>{m.activity_detail_actor()}</dt>
            <dd>{actorLabel(item.actor, { email: true })}</dd>
            <dt>{m.activity_detail_occurred()}</dt>
            <dd>
              {item.occurredAt ? (
                <time dateTime={item.occurredAt}>
                  {instant(item.occurredAt, timeZone)}
                </time>
              ) : (
                m.activity_not_recorded()
              )}
            </dd>
            <dt>{m.activity_detail_recorded()}</dt>
            <dd>
              <time dateTime={item.recordedAt}>
                {instant(item.recordedAt, timeZone)}
              </time>
            </dd>
            {item.type === 'procurement' ? (
              <>
                <dt>{m.activity_detail_reason()}</dt>
                <dd>{item.summary ?? m.activity_not_recorded()}</dd>
                <dt>{m.activity_detail_purchase_order()}</dt>
                <dd>{item.proposalId ?? m.common_none()}</dd>
              </>
            ) : (
              <>
                <dt>{m.activity_detail_proposed_change()}</dt>
                <dd>
                  {item.summary
                    ? activityChangeLabel(item.summary)
                    : m.activity_not_recorded()}
                </dd>
                <dt>{m.activity_detail_proposal()}</dt>
                <dd>{item.proposalId ?? m.common_none()}</dd>
              </>
            )}
            <dt>{m.activity_detail_attempt()}</dt>
            <dd>{item.attemptId ?? m.common_none()}</dd>
            <dt>{m.activity_detail_change_state()}</dt>
            <dd>{detail(changeStates, item.executionState)}</dd>
            <dt>{m.activity_detail_check_stage()}</dt>
            <dd>{detail(checkStages, item.verificationPhase)}</dd>
            <dt>{m.activity_detail_error_code()}</dt>
            <dd>{item.failureCode ?? m.activity_detail_error_code_none()}</dd>
            <dt>{m.activity_detail_connections()}</dt>
            <dd>
              {item.connections.length
                ? formatList(
                    item.connections.map((c) =>
                      m.activity_detail_connection_value({
                        system: c.system
                          ? providerName(c.system)
                          : m.activity_detail_unknown_system(),
                        id: c.id,
                      }),
                    ),
                  )
                : m.activity_not_recorded()}
            </dd>
            <dt>{m.activity_detail_request()}</dt>
            <dd>{detail(requestStates, item.dispatch)}</dd>
            <dt>{m.activity_detail_check_result()}</dt>
            <dd>{detail(checkResults, item.verification)}</dd>
            <dt>{m.activity_detail_mode()}</dt>
            <dd>
              {item.mode === 'unrecorded'
                ? m.activity_not_recorded()
                : label(item.mode)}
            </dd>
            <dt>{m.activity_detail_evidence()}</dt>
            <dd>
              {item.evidenceRefs.length ? (
                <ul>
                  {item.evidenceRefs.map((ref, i) => (
                    <li key={`${i}:${ref}`}>{ref}</li>
                  ))}
                </ul>
              ) : (
                m.activity_detail_evidence_none()
              )}
            </dd>
          </dl>
          <div className="activity-links">
            {item.type === 'procurement' && item.proposalId ? (
              <Link
                to="/app/$organizationId/procurement/$purchaseOrderId"
                params={{ organizationId, purchaseOrderId: item.proposalId }}
              >
                {m.activity_link_purchase_order()}
              </Link>
            ) : null}
            {item.exceptionId ? (
              <Link
                to="/app/$organizationId/exceptions/$exceptionId"
                params={{ organizationId, exceptionId: item.exceptionId }}
              >
                {m.activity_link_issue()}
              </Link>
            ) : null}
            {item.playbookId ? (
              <Link
                to="/app/$organizationId/workflows/$definitionId"
                params={{ organizationId, definitionId: item.playbookId }}
              >
                {m.activity_link_workflow()}
              </Link>
            ) : null}
            {item.connectionId ? (
              <Link to="/app/$organizationId/apps" params={{ organizationId }}>
                {m.activity_link_apps()}
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

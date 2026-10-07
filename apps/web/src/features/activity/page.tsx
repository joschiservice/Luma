import './activity.css';

import {
  type ActivityEvent,
  activityOutcomes,
  type ActivityPage as Page,
  activityTypes,
} from '@luma/api-contract';
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
  WorkspaceDate,
  WorkspaceTimezone,
} from '@luma/ui/components/primitives/workspace-date';
import { PageTitle } from '@luma/ui/components/workspace/page-header';
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
} from 'lucide-react';
import { useContext, useEffect, useSyncExternalStore } from 'react';

import { connectionsOptions } from '../connections/data';
import { SignInRedirect } from '../identity/common';
import { IdentityError } from '../identity/data';
import { type ActivityFilters, activityOptions } from './data';
import {
  activityConnectionOptions,
  activityLabel,
  type ActivitySource,
  activityState,
  activitySystemOptions,
} from './presentation';

const label = activityLabel;
const subscribe = (changed: () => void) => onlineManager.subscribe(changed);
const snapshot = () => onlineManager.isOnline();
const serverSnapshot = () => true;

/** Connects workspace history to validated URL filters and private tenant-scoped reads. */
export function ActivityPage() {
  const { organizationId } = useParams({ from: '/app/$organizationId' });
  const filters = useSearch({ from: '/app/$organizationId/activity' });
  const navigate = useNavigate({ from: '/app/$organizationId/activity' });
  const timeZone = useContext(WorkspaceTimezone);
  const page = useQuery(
    activityOptions(organizationId, filters, false, timeZone),
  );
  const head = useQuery(
    activityOptions(organizationId, filters, true, timeZone),
  );
  const connections = useQuery(connectionsOptions(organizationId));
  const refreshPage = page.refetch;
  const visibilityChanged =
    !!page.data && !!head.data && page.data.visibility !== head.data.visibility;
  useEffect(() => {
    if (visibilityChanged) {
      void navigate({
        search: {
          ...filters,
          cursor: undefined,
          latest: undefined,
          event: undefined,
        },
        replace: true,
        resetScroll: false,
      });
      if (!filters.cursor) void refreshPage();
    }
  }, [visibilityChanged, filters, navigate, refreshPage]);
  const online = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const error = page.error ?? head.error;
  const accessLost =
    error instanceof IdentityError && [401, 403, 404].includes(error.status);
  // The API rejects a page cursor that no longer matches the filters and explains why.
  const staleMessage =
    page.error instanceof IdentityError &&
    page.error.code === 'VALIDATION_ERROR' &&
    filters.cursor
      ? page.error.message
      : undefined;
  if (error instanceof IdentityError && error.status === 401)
    return <SignInRedirect />;
  const newEvents =
    !!page.data &&
    !!head.data?.items.length &&
    head.data.items[0]!.id !== (filters.latest ?? page.data.items[0]?.id);

  return (
    <ActivityView
      organizationId={organizationId}
      filters={filters}
      sources={connections.data?.map((connection) => ({
        id: connection.id,
        label: connection.label,
        system: connection.target.kind,
      }))}
      page={accessLost || visibilityChanged ? undefined : page.data}
      loading={page.isPending}
      refreshing={page.isFetching || head.isFetching}
      offline={!online}
      newEvents={newEvents}
      error={
        accessLost
          ? 'Workspace access changed. Activity is no longer available.'
          : (staleMessage ??
            (error
              ? 'Activity could not be updated. Previously loaded events may be outdated.'
              : undefined))
      }
      stalePage={!!staleMessage}
      change={(next) => void navigate({ search: next, resetScroll: false })}
      refresh={() => {
        if (filters.cursor) {
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
  page,
  loading,
  refreshing,
  offline,
  newEvents,
  error,
  stalePage = false,
  change,
  refresh,
}: {
  organizationId: string;
  /** The URL filters. Dates are set only when chosen; otherwise the last 30 days apply. */
  filters: ActivityFilters;
  /** Workspace connections offered as connection and system filters. */
  sources?: readonly ActivitySource[] | undefined;
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
  // Any filter change returns to the latest events and closes the open event.
  const update = (patch: Partial<ActivityFilters>) =>
    change({
      ...filters,
      ...patch,
      cursor: undefined,
      latest: undefined,
      event: undefined,
    });
  const toolbarFilters: CollectionFilter[] = [
    {
      kind: 'date-range',
      key: 'recorded',
      label: 'Recorded',
      icon: CalendarDays,
      from: filters.from,
      to: filters.to,
      today: workspaceDateValue(new Date(), timeZone),
      maxDays: 366,
      fallback: 'Last 30 days',
      onChange: (range) => update({ from: range.from, to: range.to }),
    },
    {
      kind: 'choice',
      key: 'connectionId',
      label: 'Connection',
      icon: Plug,
      value: filters.connectionId,
      options: activityConnectionOptions(sources, filters.connectionId),
      onChange: (connectionId) => update({ connectionId }),
    },
    {
      kind: 'choice',
      key: 'system',
      label: 'System',
      icon: Server,
      value: filters.system,
      options: activitySystemOptions(sources, filters.system),
      onChange: (system) => update({ system }),
    },
    {
      kind: 'choice',
      key: 'type',
      label: 'Event type',
      icon: Tag,
      value: filters.type,
      options: activityTypes.map((value) => ({ value, label: label(value) })),
      onChange: (value) =>
        update({ type: activityTypes.find((item) => item === value) }),
    },
    {
      kind: 'choice',
      key: 'outcome',
      label: 'Outcome',
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

  return (
    <div className="activity-page">
      <PageTitle title="Activity" />
      <CollectionFilterPanel filters={toolbarFilters}>
        <CollectionToolbar
          panel
          search={{
            value: filters.q,
            onChange: (q) => update({ q }),
            label: 'Search activity',
            placeholder: 'Issue, resource, action, actor or run ID…',
            maxLength: 200,
          }}
          filters={toolbarFilters}
          onClear={() => change({})}
          onRefresh={refresh}
          refreshing={refreshing}
          refreshLabel="Refresh activity"
        />
        <p className="activity-coverage">
          {page ? `${page.coverage} ` : null}Search matches issue IDs, resource
          references, action labels, actor IDs and workflow run IDs. Dates use
          recorded workspace time, up to 366 days.
        </p>
        {offline ? (
          <Alert role="status" className="activity-notice">
            You are offline. Loaded activity may be outdated. Reconnect to
            refresh.
          </Alert>
        ) : null}
        {error ? (
          <Alert tone="danger" role="alert" className="activity-notice">
            {error}{' '}
            {stalePage ? (
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
                Latest events
              </Button>
            ) : (
              <Button variant="outline" onClick={refresh}>
                Retry
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
            New events available — view latest
          </Button>
        ) : null}
        {page ? (
          <>
            {!page.items.length ? (
              <Empty className="activity-empty">
                <h2>No matching recorded activity</h2>
                <p>
                  Try another date range or clear the filters. Unrecorded
                  changes do not appear here.
                </p>
                <Button variant="outline" onClick={() => change({})}>
                  Clear filters
                </Button>
              </Empty>
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
                  Latest events
                </Button>
              ) : null}
              <span role="status">
                {page.items.length} recorded events on this page
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
                  Older events
                </Button>
              ) : null}
            </div>
          </>
        ) : loading && !error ? (
          <p role="status">Loading activity…</p>
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
          {!related && (item.attemptId || item.proposalId) ? (
            <small>
              {item.type === 'procurement' ? 'Purchase order' : 'Attempt group'}{' '}
              · {item.attemptId ?? item.proposalId}
            </small>
          ) : null}
          <small>
            {item.actorId ?? 'Actor not recorded'} ·{' '}
            {item.system ?? 'System not recorded'}
          </small>
          <small>
            {item.resource ??
              item.exceptionId ??
              item.connectionId ??
              'Workspace'}
          </small>
        </span>
        <span className="activity-outcome">
          <StatePill state={activityState(item.outcome)}>
            {label(item.outcome)}
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
            <dt>Event ID</dt>
            <dd>{item.id}</dd>
            <dt>Actor</dt>
            <dd>
              {item.actorKind ?? 'Unknown'} · {item.actorId ?? 'Not recorded'}
            </dd>
            <dt>Occurred</dt>
            <dd>{item.occurredAt ?? 'Not recorded'}</dd>
            <dt>Recorded</dt>
            <dd>{item.recordedAt}</dd>
            <dt>
              {item.type === 'procurement' ? 'Reason' : 'Proposed change'}
            </dt>
            <dd>{item.summary ?? 'Not recorded'}</dd>
            <dt>
              {item.type === 'procurement'
                ? 'Purchase order / attempt'
                : 'Proposal / attempt'}
            </dt>
            <dd>
              {item.proposalId ?? 'None'} / {item.attemptId ?? 'None'}
            </dd>
            <dt>Execution state</dt>
            <dd>{item.executionState ?? 'Not recorded'}</dd>
            <dt>Verification phase</dt>
            <dd>{item.verificationPhase ?? 'Not recorded'}</dd>
            <dt>Failure code</dt>
            <dd>{item.failureCode ?? 'None recorded'}</dd>
            <dt>Connections</dt>
            <dd>
              {item.connections
                .map((c) => `${c.system ?? 'Unknown system'} · ${c.id}`)
                .join(', ') || 'Not recorded'}
            </dd>
            <dt>Dispatch</dt>
            <dd>{item.dispatch ?? 'Not recorded'}</dd>
            <dt>Verification</dt>
            <dd>{item.verification ?? 'Not recorded'}</dd>
            <dt>Execution mode</dt>
            <dd>
              {item.mode === 'unrecorded' ? 'Not recorded' : label(item.mode)}
            </dd>
            <dt>Evidence references</dt>
            <dd>
              {item.evidenceRefs.length ? (
                <ul>
                  {item.evidenceRefs.map((ref, i) => (
                    <li key={`${i}:${ref}`}>{ref}</li>
                  ))}
                </ul>
              ) : (
                'No references recorded'
              )}
            </dd>
          </dl>
          <div className="activity-links">
            {item.type === 'procurement' && item.proposalId ? (
              <Link
                to="/app/$organizationId/procurement/$purchaseOrderId"
                params={{ organizationId, purchaseOrderId: item.proposalId }}
              >
                Open purchase order
              </Link>
            ) : null}
            {item.exceptionId ? (
              <Link
                to="/app/$organizationId/exceptions/$exceptionId"
                params={{ organizationId, exceptionId: item.exceptionId }}
              >
                Open issue and evidence
              </Link>
            ) : null}
            {item.playbookId ? (
              <Link
                to="/app/$organizationId/workflows/$definitionId"
                params={{ organizationId, definitionId: item.playbookId }}
              >
                Open workflow
              </Link>
            ) : null}
            {item.connectionId ? (
              <Link to="/app/$organizationId/apps" params={{ organizationId }}>
                Open connections
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

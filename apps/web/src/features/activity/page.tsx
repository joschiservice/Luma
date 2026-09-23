import {
  type ActivityEvent,
  activityOutcomes,
  type ActivityPage as Page,
  activityTypes,
} from '@luma/api-contract';
import { Button } from '@luma/ui/button';
import { onlineManager, useQuery } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { Activity } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { SignInRedirect } from '../identity/common';
import { IdentityError } from '../identity/data';
import { type ActivityFilters, activityOptions, activityRange } from './data';

const labels: Record<string, string> = {
  provider_accepted: 'Provider accepted',
  manually_disposed: 'Manually disposed',
  uncertain: 'Uncertain',
};
const label = (v: string) =>
  labels[v] ?? v.charAt(0).toUpperCase() + v.slice(1).replaceAll('_', ' ');
const subscribe = (changed: () => void) => onlineManager.subscribe(changed);
const snapshot = () => onlineManager.isOnline();
const serverSnapshot = () => true;

/** Connects workspace history to validated URL filters and private tenant-scoped reads. */
export function ActivityPage() {
  const { organizationId } = useParams({ from: '/app/$organizationId' });
  const filters = useSearch({ from: '/app/$organizationId/activity' });
  const navigate = useNavigate({ from: '/app/$organizationId/activity' });
  const page = useQuery(activityOptions(organizationId, filters));
  const head = useQuery(activityOptions(organizationId, filters, true));
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
  if (error instanceof IdentityError && error.status === 401)
    return <SignInRedirect />;
  const newEvents =
    !!page.data &&
    !!head.data?.items.length &&
    head.data.items[0]!.id !== (filters.latest ?? page.data.items[0]?.id);

  return (
    <ActivityView
      organizationId={organizationId}
      filters={{ ...filters, ...activityRange(filters) }}
      page={accessLost || visibilityChanged ? undefined : page.data}
      loading={page.isPending}
      refreshing={page.isFetching || head.isFetching}
      offline={!online}
      newEvents={newEvents}
      error={
        accessLost
          ? 'Workspace access changed. Activity is no longer available.'
          : error
            ? 'Activity could not be updated. Previously loaded events may be outdated.'
            : undefined
      }
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
  page,
  loading,
  refreshing,
  offline,
  newEvents,
  error,
  change,
  refresh,
}: {
  organizationId: string;
  filters: ActivityFilters;
  page?: Page | undefined;
  loading?: boolean;
  refreshing?: boolean;
  offline?: boolean;
  newEvents?: boolean;
  error?: string | undefined;
  change: (filters: ActivityFilters) => void;
  refresh: () => void;
}) {
  const update = (key: keyof ActivityFilters, value: string) =>
    change({
      ...filters,
      [key]: value || undefined,
      cursor: undefined,
      latest: undefined,
      event: undefined,
    });

  return (
    <div className="playbooks-page activity-page">
      <div className="playbooks-heading">
        <div>
          <p className="playbooks-kicker">
            <Activity size={15} aria-hidden="true" /> Workspace history
          </p>
          <h1>Activity</h1>
          <p className="desk-intro">
            Actions, decisions and results, newest recorded first.
          </p>
        </div>
        <Button
          variant="outline"
          disabled={refreshing || offline}
          onClick={refresh}
        >
          {refreshing ? 'Refreshing…' : 'Refresh activity'}
        </Button>
      </div>
      <div className="playbook-filters activity-filters">
        <label>
          Search activity
          <input
            type="search"
            value={filters.q ?? ''}
            placeholder="Issue, resource, action or actor ID"
            onChange={(e) => update('q', e.target.value)}
            aria-describedby="activity-search-help"
          />
        </label>
        <ActivityDates
          key={`${filters.from}:${filters.to}`}
          from={filters.from ?? ''}
          to={filters.to ?? ''}
          apply={(from, to) =>
            change({
              ...filters,
              from,
              to,
              cursor: undefined,
              latest: undefined,
              event: undefined,
            })
          }
        />
        <label>
          System
          <select
            aria-label="System"
            value={filters.system ?? ''}
            onChange={(e) => update('system', e.target.value)}
          >
            <option value="">All systems</option>
            <option value="jtl-cloud">JTL Cloud</option>
            <option value="jtl-onprem">JTL On-Prem</option>
            <option value="shopify">Shopify</option>
          </select>
        </label>
        <label>
          Connection ID
          <input
            key={filters.connectionId ?? ''}
            defaultValue={filters.connectionId ?? ''}
            placeholder="Connection UUID"
            onBlur={(e) => update('connectionId', e.target.value)}
          />
        </label>
        <label>
          Event type
          <select
            aria-label="Event type"
            value={filters.type ?? ''}
            onChange={(e) => update('type', e.target.value)}
          >
            <option value="">All event types</option>
            {activityTypes.map((v) => (
              <option key={v} value={v}>
                {label(v)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Outcome
          <select
            aria-label="Outcome"
            value={filters.outcome ?? ''}
            onChange={(e) => update('outcome', e.target.value)}
          >
            <option value="">All outcomes</option>
            {activityOutcomes.map((v) => (
              <option key={v} value={v}>
                {label(v)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p id="activity-search-help" className="desk-intro">
        Search issue IDs, persisted resource references, action labels and actor
        IDs. Dates use recorded time; select up to 366 days.
      </p>
      {offline ? (
        <p role="status" className="playbook-notice">
          You are offline. Loaded activity may be outdated. Reconnect to
          refresh.
        </p>
      ) : null}
      {error ? (
        <div role="alert" className="playbook-notice">
          {error}{' '}
          <Button variant="outline" onClick={refresh}>
            Retry
          </Button>
        </div>
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
          <p className="activity-coverage">{page.coverage}</p>
          {!page.items.length ? (
            <section className="playbook-empty">
              <h2>No matching recorded activity</h2>
              <p>
                Try another date range or clear the filters. Unrecorded changes
                do not appear here.
              </p>
              <Button variant="outline" onClick={() => change({})}>
                Clear filters
              </Button>
            </section>
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
          {new Date(item.recordedAt).toLocaleString()}
        </time>
        <span>
          <strong>{item.action}</strong>
          {!related && (item.attemptId || item.proposalId) ? (
            <small>Attempt group · {item.attemptId ?? item.proposalId}</small>
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
          {label(item.outcome)}
          {item.mode !== 'unrecorded' ? (
            <small>{label(item.mode)}</small>
          ) : null}
        </span>
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
            <dt>Proposed change</dt>
            <dd>{item.summary ?? 'Not recorded'}</dd>
            <dt>Proposal / attempt</dt>
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
                to="/app/$organizationId/playbooks/$definitionId"
                params={{ organizationId, definitionId: item.playbookId }}
              >
                Open playbook
              </Link>
            ) : null}
            {item.connectionId ? (
              <Link
                to="/app/$organizationId/connections"
                params={{ organizationId }}
              >
                Open connections
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

function ActivityDates({
  from,
  to,
  apply,
}: {
  from: string;
  to: string;
  apply: (from: string, to: string) => void;
}) {
  const [start, setStart] = useState(from);
  const [end, setEnd] = useState(to);
  const [error, setError] = useState(false);

  return (
    <form
      className="activity-dates"
      onSubmit={(event) => {
        event.preventDefault();
        const span = Date.parse(end) - Date.parse(start);
        if (!Number.isFinite(span) || span < 0 || span >= 366 * 86400000) {
          setError(true);

          return;
        }
        setError(false);
        apply(start, end);
      }}
    >
      <label>
        From (UTC)
        <input
          type="date"
          required
          value={start}
          onChange={(event) => setStart(event.target.value)}
        />
      </label>
      <label>
        Through (UTC)
        <input
          type="date"
          required
          value={end}
          onChange={(event) => setEnd(event.target.value)}
        />
      </label>
      <Button variant="outline" type="submit">
        Apply dates
      </Button>
      {error ? (
        <p role="alert">
          Choose an end date on or after the start, within 366 days.
        </p>
      ) : null}
    </form>
  );
}

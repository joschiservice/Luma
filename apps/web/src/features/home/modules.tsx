import type { OperationsOverview } from '@luma/api-contract';
import {
  elapsed,
  issueKind,
  issueStatus,
} from '@luma/ui/components/issues/case-presentation';
import { buttonVariants } from '@luma/ui/components/primitives/button';
import { DomainIcon } from '@luma/ui/components/primitives/domain-icon';
import {
  type OperationalState,
  StateDot,
  StatePill,
} from '@luma/ui/components/primitives/state';
import { WorkspaceTimezone } from '@luma/ui/components/primitives/workspace-date';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowRight, Plus } from 'lucide-react';
import { useContext } from 'react';

import { activityOptions } from '../activity/data';
import { activityLabel, activityState } from '../activity/presentation';
import { casesOptions } from '../exceptions/data';

type Connection = OperationsOverview['connections'][number];

function LinkLabel({ children }: { children: string }) {
  return (
    <>
      {children}
      <ArrowRight size={14} aria-hidden="true" />
    </>
  );
}

function ModuleSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="home-skeleton" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <span key={index} className="lu-skeleton" />
      ))}
    </div>
  );
}

/** Lists the decisions waiting for the reader, most urgent first. */
export function AttentionModule({
  organizationId,
  overview,
}: {
  organizationId: string;
  overview: OperationsOverview;
}) {
  const decisions = overview.prioritizedDecisions;

  return (
    <>
      {decisions.length ? (
        <ol className="home-rows operations-decisions">
          {decisions.map((item) => {
            const kind = issueKind(item);
            const status = issueStatus(item);

            return (
              <li key={item.id}>
                <Link
                  className="home-row"
                  to="/app/$organizationId/exceptions/$exceptionId"
                  params={{ organizationId, exceptionId: item.id }}
                  search={{ view: 'needs_you' }}
                >
                  <DomainIcon domain={kind.domain} size="sm" />
                  <span className="home-row-main">
                    <strong>{item.summary.replace(/\.+$/, '')}</strong>
                    <span>{item.attention.explanation}</span>
                  </span>
                  <span className="home-row-meta">
                    <StatePill state={status.state}>{status.label}</StatePill>
                    <span
                      className="home-row-age"
                      title={item.attention.requestedAt ?? item.detectedAt}
                    >
                      {elapsed(item.attention.requestedAt ?? item.detectedAt)}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="home-empty">
          <StateDot state="verified" />
          <div>
            <strong>No issues need your review.</strong>
            <p>
              {overview.activeCount
                ? `${overview.activeCount} ${overview.activeCount === 1 ? 'issue is' : 'issues are'} still in progress. Luma will ask when it needs you.`
                : 'Luma will ask here when a decision needs you.'}
            </p>
          </div>
        </div>
      )}
      <footer className="home-module-footer">
        <span className="lu-numeric">
          {overview.attentionCount} waiting · severity, then oldest request
        </span>
        <Link
          className="home-module-link"
          to="/app/$organizationId/exceptions"
          params={{ organizationId }}
          search={{ view: 'needs_you' }}
        >
          <LinkLabel>Open inbox</LinkLabel>
        </Link>
      </footer>
    </>
  );
}

/** Shows the work Luma is doing on its own, without a person's decision. */
export function HandlingModule({
  organizationId,
  overview,
}: {
  organizationId: string;
  overview: OperationsOverview;
}) {
  const active = useQuery(casesOptions(organizationId, { view: 'active' }));
  const handling =
    active.data?.items.filter((item) => !item.attention.required) ?? [];

  return (
    <>
      <dl className="home-stats">
        <div>
          <dt>In progress</dt>
          <dd className="lu-numeric">
            {Math.max(0, overview.activeCount - overview.attentionCount)}
          </dd>
        </div>
        <div>
          <dt>Verified</dt>
          <dd className="lu-numeric">{overview.verifiedResolutions}</dd>
        </div>
        <div>
          <dt>Without help</dt>
          <dd className="lu-numeric">
            {overview.automaticallyResolved ?? '—'}
          </dd>
        </div>
      </dl>
      {active.isPending ? (
        <ModuleSkeleton />
      ) : handling.length ? (
        <ul className="home-rows home-rows-compact">
          {handling.slice(0, 5).map((item) => {
            const status = issueStatus(item);

            return (
              <li key={item.id}>
                <Link
                  className="home-row"
                  to="/app/$organizationId/exceptions/$exceptionId"
                  params={{ organizationId, exceptionId: item.id }}
                  search={{ view: 'active' }}
                >
                  <StateDot state={status.state} />
                  <span className="home-row-main">
                    <strong>{item.summary.replace(/\.+$/, '')}</strong>
                  </span>
                  <span className="home-row-status">{status.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="home-note">
          Luma isn’t working on any issues on its own right now.
        </p>
      )}
      <footer className="home-module-footer">
        <span>Counts cover the selected window</span>
        <Link
          className="home-module-link"
          to="/app/$organizationId/exceptions"
          params={{ organizationId }}
          search={{ view: 'active' }}
        >
          <LinkLabel>All open issues</LinkLabel>
        </Link>
      </footer>
    </>
  );
}

function connectionState(connection: Connection): {
  state: OperationalState;
  label: string;
} {
  if (connection.status === 'disconnected' || connection.status === 'revoked')
    return { state: 'error', label: 'Disconnected' };
  if (connection.status === 'pending')
    return { state: 'waiting', label: 'Awaiting validation' };
  if (connection.status === 'degraded')
    return { state: 'attention', label: 'Degraded' };
  if (connection.freshness === 'stale')
    return { state: 'attention', label: 'Data is stale' };
  if (connection.freshness === 'unobserved')
    return { state: 'waiting', label: 'No data yet' };

  return { state: 'verified', label: 'Recent data' };
}

/** Shows whether each connected system is sending recent observations. */
export function ConnectionsModule({
  organizationId,
  overview,
}: {
  organizationId: string;
  overview: OperationsOverview;
}) {
  return (
    <>
      {overview.connections.length ? (
        <ul className="home-rows home-rows-compact">
          {overview.connections.map((connection) => {
            const health = connectionState(connection);

            return (
              <li key={connection.id} className="home-row">
                <StateDot state={health.state} />
                <span className="home-row-main">
                  <strong>{connection.label}</strong>
                </span>
                <span className="home-row-status">
                  {health.label}
                  {connection.lastObservedAt ? (
                    <span
                      className="home-row-age"
                      title={connection.lastObservedAt}
                    >
                      {' '}
                      · {elapsed(connection.lastObservedAt)}
                    </span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="home-empty">
          <span className="home-empty-icon" aria-hidden="true">
            <Plus size={16} />
          </span>
          <div>
            <strong>No connected systems yet</strong>
            <p>Connect Shopify or JTL so Luma can observe your operations.</p>
            <Link
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
              to="/app/$organizationId/apps"
              params={{ organizationId }}
            >
              Connect a system
            </Link>
          </div>
        </div>
      )}
      <footer className="home-module-footer">
        <span>
          Recent means observed within {overview.freshnessThresholdHours} hours
        </span>
        <span className="home-module-links">
          <Link
            className="home-module-link"
            to="/app/$organizationId/sync"
            params={{ organizationId }}
          >
            <LinkLabel>Data sync</LinkLabel>
          </Link>
          <Link
            className="home-module-link"
            to="/app/$organizationId/apps"
            params={{ organizationId }}
          >
            <LinkLabel>Manage apps</LinkLabel>
          </Link>
        </span>
      </footer>
    </>
  );
}

/** Lists the latest recorded decisions, actions and verifications. */
export function ActivityModule({ organizationId }: { organizationId: string }) {
  const timeZone = useContext(WorkspaceTimezone);
  const activity = useQuery(
    activityOptions(organizationId, {}, true, timeZone),
  );
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <>
      {activity.isPending ? (
        <ModuleSkeleton rows={4} />
      ) : activity.isError ? (
        <p className="home-note">
          Activity couldn’t be loaded. Try again shortly.
        </p>
      ) : activity.data.items.length ? (
        <ol className="home-timeline">
          {activity.data.items.slice(0, 6).map((event) => (
            <li key={event.id}>
              <time dateTime={event.recordedAt} title={event.recordedAt}>
                {time.format(new Date(event.recordedAt))}
              </time>
              <StateDot state={activityState(event.outcome)} />
              <span className="home-timeline-text">
                {event.summary ?? activityLabel(event.action)}
                <small>
                  {activityLabel(event.outcome)}
                  {event.system ? ` · ${event.system}` : ''}
                </small>
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="home-note">
          Nothing recorded in the last 30 days. Decisions and actions appear
          here as they happen.
        </p>
      )}
      <footer className="home-module-footer">
        <span>Last 30 days</span>
        <Link
          className="home-module-link"
          to="/app/$organizationId/activity"
          params={{ organizationId }}
        >
          <LinkLabel>View all activity</LinkLabel>
        </Link>
      </footer>
    </>
  );
}

/** Summarizes verified resolutions and how much Luma resolved without help. */
export function OutcomesModule({ overview }: { overview: OperationsOverview }) {
  const rate =
    overview.automation && overview.automation.denominator > 0
      ? Math.round(
          (overview.automation.numerator / overview.automation.denominator) *
            100,
        )
      : null;

  return (
    <div className="home-outcomes operations-metrics">
      <div>
        <span>Verified resolutions</span>
        <strong className="lu-numeric">{overview.verifiedResolutions}</strong>
        <p>Outcomes confirmed in the source systems.</p>
      </div>
      <div>
        <span>Resolved automatically</span>
        <strong
          className="lu-numeric"
          data-text={overview.automaticallyResolved === null ? '' : undefined}
        >
          {overview.automaticallyResolved ?? 'Unavailable'}
        </strong>
        <p>
          {overview.automaticallyResolved === null
            ? 'Human-work attribution is not available.'
            : 'Verified without a person’s work.'}
        </p>
      </div>
      <div>
        <span>Eligible automation rate</span>
        <strong
          className="lu-numeric"
          data-text={rate === null ? '' : undefined}
        >
          {rate !== null
            ? `${rate}%`
            : overview.automation
              ? '—'
              : 'Unavailable'}
        </strong>
        {rate !== null ? (
          <span className="home-meter" aria-hidden="true">
            <span style={{ width: `${rate}%` }} />
          </span>
        ) : null}
        <p>
          {overview.automation
            ? `${overview.automation.numerator} of ${overview.automation.denominator} eligible issues resolved correctly without help.`
            : 'Eligibility data is not available.'}
        </p>
      </div>
    </div>
  );
}

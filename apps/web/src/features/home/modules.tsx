import type { OperationsOverview } from '@luma/api-contract';
import {
  formatList,
  formatNumber,
  formatPercent,
  formatTime,
} from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import {
  elapsed,
  issueStatus,
} from '@luma/ui/components/issues/case-presentation';
import { buttonVariants } from '@luma/ui/components/primitives/button';
import { DomainIcon } from '@luma/ui/components/primitives/domain-icon';
import {
  type OperationalState,
  StateDot,
  StatePill,
} from '@luma/ui/components/primitives/state';
import {
  formatWorkspaceInstant,
  WorkspaceTimezone,
} from '@luma/ui/components/primitives/workspace-date';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowRight, Plus } from 'lucide-react';
import { useContext } from 'react';

import { activityOptions } from '../activity/data';
import { activityLabel, activityState } from '../activity/presentation';
import { decisionsOptions } from '../decisions/data';
import { useNow } from '../decisions/live';
import {
  decisionStatus,
  domainIcons,
  timeLeft,
} from '../decisions/presentation';
import { casesOptions } from '../exceptions/data';
import { fulfillmentsOptions } from '../fulfillment/data';
import { viewLabels as fulfillmentViewLabels } from '../fulfillment/presentation';
import { productSummaryOptions } from '../products/data';
import { viewLabels } from '../products/presentation';
import { returnSummaryOptions } from '../returns/data';
import { stageLabels, stageStates, workStages } from '../returns/presentation';

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

/**
 * Lists the most urgent decisions waiting on a person across issues, workflows and apps, from
 * the same queue and ranking as Needs you.
 */
export function AttentionModule({
  organizationId,
  overview,
}: {
  organizationId: string;
  overview: OperationsOverview;
}) {
  const timeZone = useContext(WorkspaceTimezone);
  const decisions = useQuery(decisionsOptions(organizationId, {}, 5));
  const now = useNow();
  if (decisions.isPending) return <ModuleSkeleton />;
  if (decisions.isError)
    return <p className="home-note">{m.home_attention_failed()}</p>;
  const { items, counts, sources } = decisions.data;
  const missing = sources.filter((source) => source.state === 'unavailable');

  return (
    <>
      {missing.length ? (
        <p className="home-note">
          {m.home_attention_sources_missing({
            sources: formatList(missing.map((source) => source.label)),
          })}
        </p>
      ) : null}
      {items.length ? (
        <ol className="home-rows home-rows-aligned operations-decisions">
          {items.map((item) => {
            const status = decisionStatus(item);
            const deadline =
              item.urgency === 'expiring' ? item.deadline : undefined;

            return (
              <li key={item.id}>
                <Link
                  className="home-row"
                  to="/app/$organizationId/needs-you"
                  params={{ organizationId }}
                  search={{ item: item.id }}
                >
                  <DomainIcon domain={domainIcons[item.domain]} size="sm" />
                  <span className="home-row-main">
                    <strong>{item.title}</strong>
                    <span>{item.subject.label}</span>
                  </span>
                  <span className="home-row-meta">
                    <StatePill state={status.state}>{status.label}</StatePill>
                    <span
                      className="home-row-age"
                      title={formatWorkspaceInstant(
                        deadline ?? item.requestedAt,
                        timeZone,
                      )}
                    >
                      {deadline
                        ? timeLeft(deadline, now)
                        : elapsed(item.requestedAt, now)}
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
            <strong>{m.home_attention_empty_title()}</strong>
            <p>
              {overview.activeCount
                ? m.home_attention_empty_active({ count: overview.activeCount })
                : m.home_attention_empty_idle()}
            </p>
          </div>
        </div>
      )}
      <footer className="home-module-footer">
        <span className="lu-numeric">
          {m.home_attention_footer({ count: counts.views.all ?? 0 })}
        </span>
        <Link
          className="home-module-link"
          to="/app/$organizationId/needs-you"
          params={{ organizationId }}
        >
          <LinkLabel>{m.home_attention_link()}</LinkLabel>
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
          <dt>{m.home_handling_in_progress()}</dt>
          <dd className="lu-numeric">
            {formatNumber(
              Math.max(0, overview.activeCount - overview.attentionCount),
            )}
          </dd>
        </div>
        <div>
          <dt>{m.home_handling_verified()}</dt>
          <dd className="lu-numeric">
            {formatNumber(overview.verifiedResolutions)}
          </dd>
        </div>
        <div>
          <dt>{m.home_handling_without_help()}</dt>
          <dd className="lu-numeric">
            {overview.automaticallyResolved === null
              ? m.common_empty_value()
              : formatNumber(overview.automaticallyResolved)}
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
        <p className="home-note">{m.home_handling_empty()}</p>
      )}
      <footer className="home-module-footer">
        <span>{m.home_handling_footer()}</span>
        <Link
          className="home-module-link"
          to="/app/$organizationId/exceptions"
          params={{ organizationId }}
          search={{ view: 'active' }}
        >
          <LinkLabel>{m.home_handling_link()}</LinkLabel>
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
    return { state: 'error', label: m.home_connection_disconnected() };
  if (connection.status === 'pending')
    return { state: 'waiting', label: m.home_connection_pending() };
  if (connection.status === 'degraded')
    return { state: 'attention', label: m.home_connection_degraded() };
  if (connection.freshness === 'stale')
    return { state: 'attention', label: m.home_connection_stale() };
  if (connection.freshness === 'unobserved')
    return { state: 'waiting', label: m.home_connection_unobserved() };

  return { state: 'verified', label: m.home_connection_recent() };
}

/** Shows whether each connected system is sending recent observations. */
export function ConnectionsModule({
  organizationId,
  overview,
}: {
  organizationId: string;
  overview: OperationsOverview;
}) {
  const timeZone = useContext(WorkspaceTimezone);
  const now = useNow();

  return (
    <>
      {overview.connections.length ? (
        <ul className="home-rows home-rows-compact home-rows-aligned">
          {overview.connections.map((connection) => {
            const health = connectionState(connection);

            return (
              <li key={connection.id} className="home-row">
                <StateDot state={health.state} />
                <span className="home-row-main">
                  <strong>{connection.label}</strong>
                </span>
                <span className="home-row-status">{health.label}</span>
                <span
                  className="home-row-age"
                  title={
                    connection.lastObservedAt
                      ? formatWorkspaceInstant(
                          connection.lastObservedAt,
                          timeZone,
                        )
                      : undefined
                  }
                >
                  {connection.lastObservedAt
                    ? m.home_connection_age({
                        age: elapsed(connection.lastObservedAt, now),
                      })
                    : null}
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
            <strong>{m.home_connections_empty_title()}</strong>
            <p>{m.home_connections_empty_description()}</p>
            <Link
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
              to="/app/$organizationId/apps"
              params={{ organizationId }}
            >
              {m.home_connections_connect()}
            </Link>
          </div>
        </div>
      )}
      <footer className="home-module-footer">
        <span>
          {m.home_connections_footer({
            hours: overview.freshnessThresholdHours,
          })}
        </span>
        <span className="home-module-links">
          <Link
            className="home-module-link"
            to="/app/$organizationId/sync"
            params={{ organizationId }}
          >
            <LinkLabel>{m.home_connections_sync_link()}</LinkLabel>
          </Link>
          <Link
            className="home-module-link"
            to="/app/$organizationId/apps"
            params={{ organizationId }}
          >
            <LinkLabel>{m.home_connections_apps_link()}</LinkLabel>
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

  return (
    <>
      {activity.isPending ? (
        <ModuleSkeleton rows={4} />
      ) : activity.isError ? (
        <p className="home-note">{m.home_activity_failed()}</p>
      ) : activity.data.items.length ? (
        <ol className="home-timeline">
          {activity.data.items.slice(0, 6).map((event) => (
            <li key={event.id}>
              <time
                dateTime={event.recordedAt}
                title={formatWorkspaceInstant(event.recordedAt, timeZone)}
              >
                {formatTime(event.recordedAt, { timeZone, timeStyle: 'short' })}
              </time>
              <StateDot state={activityState(event.outcome)} />
              <span className="home-timeline-text">
                {event.summary ?? activityLabel(event.action)}
                <small>
                  {event.system
                    ? m.home_activity_outcome_system({
                        outcome: activityLabel(event.outcome),
                        system: event.system,
                      })
                    : activityLabel(event.outcome)}
                </small>
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="home-note">{m.home_activity_empty()}</p>
      )}
      <footer className="home-module-footer">
        <span>{m.home_activity_footer()}</span>
        <Link
          className="home-module-link"
          to="/app/$organizationId/activity"
          params={{ organizationId }}
        >
          <LinkLabel>{m.home_activity_link()}</LinkLabel>
        </Link>
      </footer>
    </>
  );
}

const coverageMessages = {
  complete: m.home_outcomes_coverage_complete,
  partial: m.home_outcomes_coverage_partial,
  unavailable: m.home_outcomes_coverage_unavailable,
} satisfies Record<
  NonNullable<OperationsOverview['measurement']>['coverage'],
  () => string
>;

/** Summarizes verified resolutions and how much Luma resolved without help. */
export function OutcomesModule({
  overview,
  organizationId,
}: {
  overview: OperationsOverview;
  organizationId?: string;
}) {
  const rate =
    overview.automation && overview.automation.denominator > 0
      ? overview.automation.numerator / overview.automation.denominator
      : null;

  return (
    <>
      <div className="home-outcomes operations-metrics">
        <div>
          <span>{m.home_outcomes_verified_label()}</span>
          <strong className="lu-numeric">
            {formatNumber(
              overview.measurement?.verified ?? overview.verifiedResolutions,
            )}
          </strong>
          <p>
            {overview.measurement
              ? m.home_outcomes_verified_measured()
              : m.home_outcomes_verified_basic()}
          </p>
        </div>
        <div>
          <span>{m.home_outcomes_automatic_label()}</span>
          <strong
            className="lu-numeric"
            data-text={overview.automaticallyResolved === null ? '' : undefined}
          >
            {overview.automaticallyResolved === null
              ? m.home_outcomes_unavailable()
              : formatNumber(overview.automaticallyResolved)}
          </strong>
          <p>
            {overview.automaticallyResolved === null
              ? overview.measurement
                ? m.home_outcomes_automatic_unknown({
                    unknown: overview.measurement.unknownAttribution,
                    human: overview.measurement.human,
                  })
                : m.home_outcomes_automatic_no_data()
              : m.home_outcomes_automatic_verified()}
          </p>
        </div>
        <div>
          <span>{m.home_outcomes_rate_label()}</span>
          <strong
            className="lu-numeric"
            data-text={rate === null ? '' : undefined}
          >
            {rate !== null
              ? formatPercent(rate)
              : overview.automation
                ? m.common_empty_value()
                : m.home_outcomes_unavailable()}
          </strong>
          {rate !== null ? (
            <span className="home-meter" aria-hidden="true">
              <span style={{ width: `${Math.round(rate * 100)}%` }} />
            </span>
          ) : null}
          <p>
            {overview.automation
              ? m.home_outcomes_rate_detail({
                  resolved: overview.automation.numerator,
                  eligible: overview.automation.denominator,
                })
              : overview.measurement
                ? m.home_outcomes_rate_incomplete({
                    eligibility: overview.measurement.unknownEligibility,
                    environment: overview.measurement.unknownEnvironment,
                  })
                : m.home_outcomes_rate_no_data()}
          </p>
        </div>
      </div>
      <footer className="home-module-footer">
        {overview.measurement ? (
          <span>{coverageMessages[overview.measurement.coverage]()}</span>
        ) : null}
        {organizationId ? (
          <Link
            className="home-module-link"
            to="/app/$organizationId/insights"
            params={{ organizationId }}
          >
            <LinkLabel>{m.home_outcomes_link()}</LinkLabel>
          </Link>
        ) : null}
      </footer>
    </>
  );
}

/** Counts SKUs whose listings differ, are missing from a source or have an unlinked match. */
export function CatalogModule({ organizationId }: { organizationId: string }) {
  const catalog = useQuery(productSummaryOptions(organizationId));
  if (catalog.isPending) return <ModuleSkeleton />;
  if (catalog.isError)
    return <p className="home-note">{m.home_catalog_failed()}</p>;
  const { counts, sources } = catalog.data;
  const views = [
    ['differs', 'attention'],
    ['missing', 'waiting'],
    ['unlinked', 'waiting'],
  ] as const;

  return (
    <>
      {counts.all ? (
        <ul className="home-rows home-rows-compact">
          {views.map(([view, state]) => (
            <li key={view}>
              <Link
                className="home-row"
                to="/app/$organizationId/products"
                params={{ organizationId }}
                search={{ view }}
              >
                <StateDot state={counts[view] ? state : 'idle'} />
                <span className="home-row-main">
                  <strong>{viewLabels[view]}</strong>
                </span>
                <span className="home-row-status">
                  {m.home_catalog_skus({ count: counts[view] ?? 0 })}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="home-empty">
          <span className="home-empty-icon" aria-hidden="true">
            <Plus size={16} />
          </span>
          <div>
            <strong>{m.home_catalog_empty_title()}</strong>
            <p>{m.home_catalog_empty_description()}</p>
            <Link
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
              to="/app/$organizationId/sync"
              params={{ organizationId }}
            >
              {m.home_open_sync()}
            </Link>
          </div>
        </div>
      )}
      <footer className="home-module-footer">
        <span>
          {m.home_catalog_footer({
            skus: counts.all ?? 0,
            sources: sources.length,
          })}
        </span>
        <span className="home-module-links">
          <Link
            className="home-module-link"
            to="/app/$organizationId/products"
            params={{ organizationId }}
          >
            <LinkLabel>{m.home_catalog_link()}</LinkLabel>
          </Link>
        </span>
      </footer>
    </>
  );
}

/** Counts fulfillment that is held, delayed or failed, and shipments in transit. */
export function FulfillmentModule({
  organizationId,
}: {
  organizationId: string;
}) {
  const fulfillment = useQuery(
    fulfillmentsOptions(organizationId, { view: 'all' }, 1),
  );
  if (fulfillment.isPending) return <ModuleSkeleton />;
  if (fulfillment.isError)
    return <p className="home-note">{m.home_fulfillment_failed()}</p>;
  const { counts } = fulfillment.data;
  const views = [
    ['held', 'attention'],
    ['delayed', 'attention'],
    ['in_transit', 'running'],
  ] as const;

  return (
    <>
      {counts.all ? (
        <ul className="home-rows home-rows-compact">
          {views.map(([view, state]) => (
            <li key={view}>
              <Link
                className="home-row"
                to="/app/$organizationId/fulfillment"
                params={{ organizationId }}
                search={{ view }}
              >
                <StateDot state={counts[view] ? state : 'idle'} />
                <span className="home-row-main">
                  <strong>{fulfillmentViewLabels[view]}</strong>
                </span>
                <span className="home-row-status">
                  {m.home_fulfillment_count({ count: counts[view] ?? 0 })}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="home-empty">
          <span className="home-empty-icon" aria-hidden="true">
            <Plus size={16} />
          </span>
          <div>
            <strong>{m.home_fulfillment_empty_title()}</strong>
            <p>{m.home_fulfillment_empty_description()}</p>
            <Link
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
              to="/app/$organizationId/sync"
              params={{ organizationId }}
            >
              {m.home_open_sync()}
            </Link>
          </div>
        </div>
      )}
      <footer className="home-module-footer">
        <span>
          {m.home_fulfillment_footer({
            attention: counts.attention ?? 0,
            open: counts.open ?? 0,
          })}
        </span>
        <span className="home-module-links">
          <Link
            className="home-module-link"
            to="/app/$organizationId/fulfillment"
            params={{ organizationId }}
          >
            <LinkLabel>{m.home_fulfillment_link()}</LinkLabel>
          </Link>
        </span>
      </footer>
    </>
  );
}

/** Counts returns by pending stage; each row opens the returns list filtered to that stage. */
export function ReturnsModule({ organizationId }: { organizationId: string }) {
  const returns = useQuery(returnSummaryOptions(organizationId));
  if (returns.isPending) return <ModuleSkeleton />;
  if (returns.isError)
    return <p className="home-note">{m.home_returns_failed()}</p>;
  const { counts, sources } = returns.data;
  const sharing = sources.filter((source) => source.access === 'granted');

  return (
    <>
      {counts.views.all ? (
        <ul className="home-rows home-rows-compact">
          {workStages.map((stage) => {
            const count = counts.stages[stage] ?? 0;

            return (
              <li key={stage}>
                <Link
                  className="home-row"
                  to="/app/$organizationId/returns"
                  params={{ organizationId }}
                  search={{ view: 'all', stage }}
                >
                  <StateDot state={count ? stageStates[stage] : 'idle'} />
                  <span className="home-row-main">
                    <strong>{stageLabels[stage]}</strong>
                  </span>
                  <span className="home-row-status">
                    {m.home_returns_count({ count })}
                  </span>
                </Link>
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
            <strong>
              {sharing.length
                ? m.home_returns_empty_title()
                : m.home_returns_not_shared_title()}
            </strong>
            <p>
              {sharing.length
                ? m.home_returns_empty_description()
                : m.home_returns_not_shared_description()}
            </p>
            <Link
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
              to={
                sharing.length
                  ? '/app/$organizationId/sync'
                  : '/app/$organizationId/connections'
              }
              params={{ organizationId }}
            >
              {sharing.length
                ? m.home_open_sync()
                : m.home_returns_review_connections()}
            </Link>
          </div>
        </div>
      )}
      <footer className="home-module-footer">
        <span>
          {m.home_returns_footer({
            action: counts.views.action ?? 0,
            waiting: counts.views.waiting ?? 0,
          })}
        </span>
        <span className="home-module-links">
          <Link
            className="home-module-link"
            to="/app/$organizationId/returns"
            params={{ organizationId }}
          >
            <LinkLabel>{m.home_returns_link()}</LinkLabel>
          </Link>
        </span>
      </footer>
    </>
  );
}

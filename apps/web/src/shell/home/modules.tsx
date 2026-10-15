import type { HomeModuleId, OperationsOverview } from '@luma/api-contract';
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
import { Tooltip } from '@luma/ui/components/primitives/tooltip';
import {
  formatWorkspaceInstant,
  WorkspaceTimezone,
} from '@luma/ui/components/primitives/workspace-date';
import { connectionHealthLabel } from '@luma/ui/lib/connection-health';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  ArrowRight,
  CircleCheck,
  CircleDashed,
  Percent,
  Plus,
  Sparkles,
} from 'lucide-react';
import { useContext } from 'react';

import { activityOptions } from '../../features/activity/data';
import {
  activityHref,
  activityLabel,
  activityState,
  activityTitle,
} from '../../features/activity/presentation';
import { decisionsOptions } from '../../features/decisions/data';
import {
  decisionStatus,
  domainIcons,
  timeLeft,
} from '../../features/decisions/presentation';
import { casesOptions } from '../../features/exceptions/data';
import { fulfillmentsOptions } from '../../features/fulfillment/data';
import { viewLabels as fulfillmentViewLabels } from '../../features/fulfillment/presentation';
import { productSummaryOptions } from '../../features/products/data';
import { viewLabels } from '../../features/products/presentation';
import { returnSummaryOptions } from '../../features/returns/data';
import {
  stageLabels,
  stageStates,
  workStages,
} from '../../features/returns/presentation';
import { homeModules } from '../../kit/home/preferences';
import { useNow } from '../../kit/live/now';

type Connection = OperationsOverview['connections'][number];

function LinkLabel({ children }: { children: string }) {
  return (
    <>
      {children}
      <ArrowRight size={14} aria-hidden="true" />
    </>
  );
}

/**
 * Links a Home module to the page with everything it summarizes. Shown in the module header;
 * the accessible name includes the module so several "View all" links stay distinct.
 */
export function ModuleLink({
  module,
  organizationId,
}: {
  module: HomeModuleId;
  organizationId: string;
}) {
  const props = {
    className: 'home-module-link',
    'aria-label': m.home_view_all_label({ module: homeModules[module].title }),
    children: <LinkLabel>{m.home_view_all()}</LinkLabel>,
  };
  const params = { organizationId };
  switch (module) {
    case 'attention':
      return (
        <Link {...props} to="/app/$organizationId/needs-you" params={params} />
      );
    case 'handling':
      return (
        <Link
          {...props}
          to="/app/$organizationId/exceptions"
          params={params}
          search={{ view: 'active' }}
        />
      );
    case 'connections':
      return <Link {...props} to="/app/$organizationId/sync" params={params} />;
    case 'activity':
      return (
        <Link {...props} to="/app/$organizationId/activity" params={params} />
      );
    case 'outcomes':
      return (
        <Link {...props} to="/app/$organizationId/insights" params={params} />
      );
    case 'catalog':
      return (
        <Link {...props} to="/app/$organizationId/products" params={params} />
      );
    case 'fulfillment':
      return (
        <Link
          {...props}
          to="/app/$organizationId/fulfillment"
          params={params}
        />
      );
    case 'returns':
      return (
        <Link {...props} to="/app/$organizationId/returns" params={params} />
      );
    default:
      return null;
  }
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
  const { items, sources } = decisions.data;
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
          <dt>
            <CircleDashed aria-hidden="true" />
            {m.home_handling_in_progress()}
          </dt>
          <dd className="lu-numeric">
            {formatNumber(
              Math.max(0, overview.activeCount - overview.attentionCount),
            )}
          </dd>
        </div>
        <div>
          <dt>
            <CircleCheck aria-hidden="true" />
            {m.home_handling_verified()}
          </dt>
          <dd className="lu-numeric">
            {formatNumber(overview.verifiedResolutions)}
          </dd>
        </div>
        <div>
          <dt>
            <Sparkles aria-hidden="true" />
            {m.home_handling_without_help()}
          </dt>
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
    </>
  );
}

function connectionState(connection: Connection): {
  state: OperationalState;
  label: string;
} {
  if (connection.health) return connectionHealthLabel(connection.health);
  if (connection.status === 'disconnected' || connection.status === 'revoked')
    return { state: 'error', label: m.home_connection_disconnected() };
  if (connection.status === 'pending')
    return { state: 'waiting', label: m.home_connection_pending() };
  if (connection.status === 'degraded')
    return { state: 'attention', label: m.home_connection_degraded() };
  if (connection.freshness === 'stale')
    return { state: 'attention', label: m.home_connection_stale() };
  if (connection.freshness === 'unobserved' && connection.lastObservedAt)
    return connectionHealthLabel('importing');
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
                {health.state === 'verified' ? (
                  <Tooltip
                    content={m.home_connections_recent_hint({
                      hours: overview.freshnessThresholdHours,
                    })}
                  >
                    {/* Focusable so keyboard users can read the definition too. */}
                    <span className="home-row-status" tabIndex={0}>
                      {health.label}
                    </span>
                  </Tooltip>
                ) : (
                  <span className="home-row-status">{health.label}</span>
                )}
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
                <a href={activityHref(event, organizationId)}>
                  {activityTitle(event)}
                </a>
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
export function OutcomesModule({ overview }: { overview: OperationsOverview }) {
  const rate =
    overview.automation && overview.automation.denominator > 0
      ? overview.automation.numerator / overview.automation.denominator
      : null;

  return (
    <>
      <div className="home-outcomes operations-metrics">
        <div>
          <span className="home-tile-label">
            <CircleCheck aria-hidden="true" />
            {m.home_outcomes_verified_label()}
          </span>
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
          <span className="home-tile-label">
            <Sparkles aria-hidden="true" />
            {m.home_outcomes_automatic_label()}
          </span>
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
          <span className="home-tile-label">
            <Percent aria-hidden="true" />
            {m.home_outcomes_rate_label()}
          </span>
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
      {overview.measurement && overview.measurement.coverage !== 'complete' ? (
        <p className="home-note">
          {coverageMessages[overview.measurement.coverage]()}
        </p>
      ) : null}
    </>
  );
}

/** Counts SKUs whose listings differ, are missing from a source or have an unlinked match. */
export function CatalogModule({ organizationId }: { organizationId: string }) {
  const catalog = useQuery(productSummaryOptions(organizationId));
  if (catalog.isPending) return <ModuleSkeleton />;
  if (catalog.isError)
    return <p className="home-note">{m.home_catalog_failed()}</p>;
  const { counts } = catalog.data;
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
    </>
  );
}

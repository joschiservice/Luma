import './readiness.css';

import type { ReadinessRepair, WorkflowReadiness } from '@luma/api-contract';
import { formatList } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { buttonVariants } from '@luma/ui/components/primitives/button';
import {
  type OperationalState,
  StateDot,
  StatePill,
} from '@luma/ui/components/primitives/state';
import { Link, useLocation } from '@tanstack/react-router';
import { ArrowRight, TriangleAlert } from 'lucide-react';
import { useId } from 'react';

import { workflowStatus } from './presentation';

type RecentOutcome = NonNullable<
  WorkflowReadiness['outcomes']
>['recent'][number];

const recentStates = {
  verified: 'verified',
  unresolved: 'attention',
  in_progress: 'waiting',
  ended: 'idle',
} satisfies Record<RecentOutcome['state'], OperationalState>;

/**
 * Shows how the latest runs ended as a row of state marks, oldest first, named by their counts
 * for assistive technology and on hover. Only an independent verification shows as verified.
 */
export function RecentRuns({ recent }: { recent: readonly RecentOutcome[] }) {
  const parts = [
    { state: 'verified', label: m.workflows_outcomes_verified },
    { state: 'unresolved', label: m.workflows_outcomes_unresolved },
    { state: 'in_progress', label: m.workflows_outcomes_in_progress },
    { state: 'ended', label: m.workflows_outcomes_ended },
  ] as const;
  const results = formatList(
    parts.flatMap(({ state, label }) => {
      const count = recent.filter((run) => run.state === state).length;

      return count ? [label({ count })] : [];
    }),
  );
  const label = m.workflows_recent_runs_label({
    count: recent.length,
    results,
  });

  return (
    <span
      className="workflow-recent-runs"
      role="img"
      aria-label={label}
      title={label}
    >
      {[...recent].reverse().map((run, index) => (
        <StateDot key={`${run.at}:${index}`} state={recentStates[run.state]} />
      ))}
    </span>
  );
}

/** One sentence that combines enablement and readiness, such as "Can’t run right now". */
export function readinessHeadline(readiness: WorkflowReadiness) {
  if (readiness.state === 'blocked') return m.workflows_headline_blocked();
  if (readiness.state === 'degraded') return m.workflows_headline_degraded();
  if (readiness.enablement === 'enabled') return m.workflows_headline_running();
  if (readiness.enablement === 'paused') return m.workflows_headline_paused();

  return m.workflows_headline_ready();
}

/**
 * Shows a workflow's status in one label, such as "On" or "Needs setup", followed by decisions
 * waiting for a person and a latest run that needs review.
 */
export function ReadinessPills({
  readiness,
}: {
  readiness: WorkflowReadiness;
}) {
  const status = workflowStatus(readiness);

  return (
    <span className="workflow-readiness-pills">
      <StatePill state={status.state}>{status.label}</StatePill>
      {(readiness.waiting.count ?? 0) > 0 ? (
        <StatePill state="approval">
          {m.workflows_waiting_count({ count: readiness.waiting.count ?? 0 })}
        </StatePill>
      ) : null}
      {readiness.outcomes?.latest?.state === 'unresolved' ? (
        <StatePill state="attention">
          {m.workflows_latest_unresolved()}
        </StatePill>
      ) : null}
    </span>
  );
}

/**
 * Links to the place that repairs an issue. Record links carry the current page so their Back
 * link returns here. Server-side repairs have no product page and render as text.
 */
export function RepairLink({
  organizationId,
  definitionId,
  repair,
  className = 'workflow-repair-link',
  label = repair.label,
}: {
  organizationId: string;
  /** The workflow that owns rule and activity destinations. */
  definitionId: string;
  repair: ReadinessRepair;
  className?: string;
  label?: string;
}) {
  const here = useLocation({ select: (location) => location.href });
  const content = (
    <>
      {label}
      <ArrowRight size={13} aria-hidden="true" />
    </>
  );

  switch (repair.destination) {
    case 'server':
      return <span className="workflow-repair-note">{label}</span>;
    case 'connections':
      return (
        <Link
          className={className}
          to="/app/$organizationId/apps"
          params={{ organizationId }}
          {...(repair.recordId
            ? { hash: `connection-${repair.recordId}` }
            : {})}
        >
          {content}
        </Link>
      );
    case 'suppliers':
      return (
        <Link
          className={className}
          to="/app/$organizationId/procurement"
          params={{ organizationId }}
          search={{ tab: 'suppliers' }}
        >
          {content}
        </Link>
      );
    case 'inventory':
      return (
        <Link
          className={className}
          to="/app/$organizationId/inventory"
          params={{ organizationId }}
          search={{}}
        >
          {content}
        </Link>
      );
    case 'inventory_position':
      return repair.recordId ? (
        <Link
          className={className}
          to="/app/$organizationId/inventory/$positionId"
          params={{ organizationId, positionId: repair.recordId }}
          search={{ from: here }}
        >
          {content}
        </Link>
      ) : null;
    case 'purchase_order':
      return repair.recordId ? (
        <Link
          className={className}
          to="/app/$organizationId/procurement/$purchaseOrderId"
          params={{ organizationId, purchaseOrderId: repair.recordId }}
        >
          {content}
        </Link>
      ) : null;
    case 'needs_you':
      return (
        <Link
          className={className}
          to="/app/$organizationId/needs-you"
          params={{ organizationId }}
          search={repair.recordId ? { item: repair.recordId } : {}}
        >
          {content}
        </Link>
      );
    case 'workflow_rules':
      return (
        <Link
          className={className}
          to="/app/$organizationId/workflows/$definitionId"
          params={{ organizationId, definitionId }}
          search={repair.recordId ? { setup: repair.recordId } : {}}
          hash="rules"
        >
          {content}
        </Link>
      );
    case 'workflow_activity':
      return (
        <Link
          className={className}
          to="/app/$organizationId/workflows/$definitionId"
          params={{ organizationId, definitionId }}
          search={{}}
          hash={repair.recordId ? `run-${repair.recordId}` : 'activity'}
        >
          {content}
        </Link>
      );
  }
}

// The server names coverage units in English; known units get localized plurals.
const unitCounts: Record<string, (inputs: { count: number }) => string> = {
  'open inventory mismatch case': m.workflows_unit_inventory_cases,
  'open stuck fulfillment case': m.workflows_unit_fulfillment_cases,
  'open sync failure case': m.workflows_unit_sync_cases,
  'open order quantity mismatch case': m.workflows_unit_quantity_cases,
  'open overdue supplier order': m.workflows_unit_open_supplier_orders,
  'open return waiting for a refund': m.workflows_unit_refund_cases,
  'open order with a pending payment': m.workflows_unit_payment_cases,
  'stock position': m.workflows_unit_stock_positions,
  order: m.workflows_unit_orders,
  run: m.workflows_unit_runs,
  'overdue supplier order': m.workflows_unit_overdue_supplier_orders,
};

/** Counts coverage in its unit, such as “2 stock positions”, in the active language. */
export function unitCount(count: number, unit: string) {
  const known = Object.hasOwn(unitCounts, unit) ? unitCounts[unit] : undefined;

  return known ? known({ count }) : m.workflows_unit_other({ count, unit });
}

/** Writes coverage so that unknown never reads as zero. */
export function coverageLabel(coverage: WorkflowReadiness['coverage']) {
  if (coverage.covered === null) return m.common_unknown();
  if (coverage.covered === 0) return m.workflows_coverage_none();

  return coverage.ready === null || coverage.ready === coverage.covered
    ? unitCount(coverage.covered, coverage.unit)
    : m.workflows_coverage_ready_of({
        ready: coverage.ready,
        covered: unitCount(coverage.covered, coverage.unit),
      });
}

/** Whether readiness asks for something: a repair, an issue, or setup before the workflow runs. */
export function hasNextStep(readiness: WorkflowReadiness) {
  return (
    !!readiness.nextAction.repair ||
    readiness.issues.length > 0 ||
    readiness.state !== 'ready'
  );
}

/**
 * Puts the one next thing to do first, with its repair, then the other issues behind it. When the
 * page header already offers setup, such as Turn on, a plain setup step names it without a second
 * control; a setup step for a specific record keeps its link.
 */
export function WorkflowNextStep({
  organizationId,
  definitionId,
  readiness,
  setupInHeader = false,
}: {
  organizationId: string;
  definitionId: string;
  readiness: WorkflowReadiness;
  /** Whether the page header holds the control that sets the workflow up or turns it on. */
  setupInHeader?: boolean;
}) {
  const title = useId();
  const { nextAction, issues } = readiness;
  const repair =
    setupInHeader &&
    nextAction.repair?.destination === 'workflow_rules' &&
    !nextAction.repair.recordId
      ? null
      : nextAction.repair;
  // The next action already states the first issue; list the rest below it.
  const others = issues.filter(
    (issue) =>
      (issue.scope ? `${issue.scope}: ${issue.message}` : issue.message) !==
      nextAction.description,
  );

  return (
    <section
      className="workflow-next-step"
      data-state={readiness.state}
      data-enablement={readiness.enablement}
      aria-labelledby={title}
    >
      <div className="workflow-next-step-main">
        <span className="workflow-next-step-icon" aria-hidden="true">
          {readiness.state === 'ready' ? (
            <ArrowRight size={15} />
          ) : (
            <TriangleAlert size={15} />
          )}
        </span>
        <div>
          <p className="workflow-next-step-eyebrow">{m.workflows_next()}</p>
          <h2 id={title}>{nextAction.label}</h2>
          <p>{nextAction.description}</p>
        </div>
        {repair ? (
          <RepairLink
            organizationId={organizationId}
            definitionId={definitionId}
            repair={repair}
            className={buttonVariants({
              variant: readiness.state === 'blocked' ? 'default' : 'outline',
              size: 'sm',
            })}
          />
        ) : null}
      </div>
      {others.length ? (
        <ul
          className="workflow-issues"
          aria-label={m.workflows_readiness_issues_label()}
        >
          {others.map((issue) => (
            <li
              key={`${issue.code}:${issue.scope ?? ''}`}
              data-severity={issue.severity}
            >
              <span className="workflow-issue-dot" aria-hidden="true" />
              <div>
                <p>
                  <span className="sr-only">
                    {issue.severity === 'blocking'
                      ? m.workflows_readiness_issue_blocking()
                      : m.workflows_readiness_issue_partial()}{' '}
                  </span>
                  {issue.scope ? <strong>{issue.scope}: </strong> : null}
                  {issue.message}
                </p>
                {issue.repair ? (
                  <RepairLink
                    organizationId={organizationId}
                    definitionId={definitionId}
                    repair={issue.repair}
                  />
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

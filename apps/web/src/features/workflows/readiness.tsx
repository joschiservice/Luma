import './readiness.css';

import type { ReadinessRepair, WorkflowReadiness } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
import { Badge } from '@luma/ui/components/primitives/badge';
import { buttonVariants } from '@luma/ui/components/primitives/button';
import { Card } from '@luma/ui/components/primitives/card';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import {
  type OperationalState,
  StatePill,
} from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { Link, useLocation } from '@tanstack/react-router';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import { useId } from 'react';

const enablementLabels = {
  enabled: m.workflows_enablement_enabled,
  paused: m.workflows_enablement_paused,
  not_enabled: m.workflows_enablement_not_enabled,
} satisfies Record<WorkflowReadiness['enablement'], () => string>;

const readinessLabels = {
  ready: m.workflows_readiness_ready,
  degraded: m.workflows_readiness_degraded,
  blocked: m.workflows_readiness_blocked,
} satisfies Record<WorkflowReadiness['state'], () => string>;

const approvalModes = {
  every_action: m.workflows_readiness_approval_every,
  risk_based: m.workflows_readiness_approval_risk,
  no_actions: m.workflows_readiness_approval_none,
} satisfies Record<WorkflowReadiness['approval']['mode'], () => string>;

const pillStates: Record<WorkflowReadiness['state'], OperationalState> = {
  ready: 'running',
  degraded: 'attention',
  blocked: 'error',
};

/** One sentence that combines enablement and readiness, such as "Can’t run right now". */
export function readinessHeadline(readiness: WorkflowReadiness) {
  if (readiness.state === 'blocked') return m.workflows_headline_blocked();
  if (readiness.state === 'degraded') return m.workflows_headline_degraded();
  if (readiness.enablement === 'enabled') return m.workflows_headline_running();
  if (readiness.enablement === 'paused') return m.workflows_headline_paused();

  return m.workflows_headline_ready();
}

/** Whether a workflow belongs in the "Needs attention" view. */
export function needsAttention(readiness: WorkflowReadiness) {
  return (
    readiness.state !== 'ready' ||
    (readiness.waiting.count ?? 0) > 0 ||
    readiness.outcomes?.latest?.state === 'unresolved'
  );
}

/** Shows whether a workflow is turned on and whether it can run, as two separate labels. */
export function ReadinessPills({
  readiness,
}: {
  readiness: WorkflowReadiness;
}) {
  return (
    <span className="workflow-readiness-pills">
      <Badge tone={readiness.enablement === 'enabled' ? 'info' : 'neutral'}>
        {enablementLabels[readiness.enablement]()}
      </Badge>
      <StatePill
        state={
          readiness.state === 'ready' && readiness.enablement !== 'enabled'
            ? 'idle'
            : pillStates[readiness.state]
        }
      >
        {readinessLabels[readiness.state]()}
      </StatePill>
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
          search={{ view: 'suppliers', q: '', status: '' }}
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

function waitingLabel(waiting: WorkflowReadiness['waiting']) {
  if (waiting.count === null) return m.workflows_waiting_in_needs_you();
  if (waiting.count === 0) return m.workflows_waiting_none();

  return m.workflows_waiting_count({ count: waiting.count });
}

function outcomeLabel(outcomes: WorkflowReadiness['outcomes']) {
  if (!outcomes) return m.workflows_outcomes_not_tracked();
  if (!outcomes.runs) return m.workflows_outcomes_no_runs();

  return [
    m.workflows_outcomes_verified({ count: outcomes.verified }),
    ...(outcomes.unresolved
      ? [m.workflows_outcomes_unresolved({ count: outcomes.unresolved })]
      : []),
    ...(outcomes.inProgress
      ? [m.workflows_outcomes_in_progress({ count: outcomes.inProgress })]
      : []),
  ].join(' · ');
}

/**
 * Puts the next action first, then the issues behind it and what the workflow covers, who
 * approves, what waits and what recent runs established.
 */
export function WorkflowReadinessPanel({
  organizationId,
  definitionId,
  readiness,
}: {
  organizationId: string;
  definitionId: string;
  readiness: WorkflowReadiness;
}) {
  const title = useId();
  const { nextAction, issues } = readiness;
  // The next action already states the first issue; list the rest below it.
  const others = issues.filter(
    (issue) =>
      (issue.scope ? `${issue.scope}: ${issue.message}` : issue.message) !==
      nextAction.description,
  );

  return (
    <Card
      as="section"
      className="workflow-readiness"
      data-state={readiness.state}
      aria-labelledby={title}
    >
      <div className="workflow-readiness-head">
        <div>
          <p className="workflow-readiness-eyebrow">
            {m.workflows_readiness_eyebrow()}
          </p>
          <h2 id={title}>{readinessHeadline(readiness)}</h2>
        </div>
        <ReadinessPills readiness={readiness} />
      </div>
      <div className="workflow-next" data-state={readiness.state}>
        <span className="workflow-next-label">{m.workflows_next()}</span>
        <div>
          <strong>{nextAction.label}</strong>
          <p>{nextAction.description}</p>
        </div>
        {nextAction.repair ? (
          <RepairLink
            organizationId={organizationId}
            definitionId={definitionId}
            repair={nextAction.repair}
            className={buttonVariants({
              variant: readiness.state === 'ready' ? 'outline' : 'default',
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
      <dl className="workflow-readiness-facts">
        <div>
          <dt>{m.workflows_readiness_covers()}</dt>
          <dd>
            <strong>{coverageLabel(readiness.coverage)}</strong>
            <span>{readiness.coverage.explanation}</span>
          </dd>
        </div>
        <div>
          <dt>{m.workflows_readiness_approval()}</dt>
          <dd>
            <strong>{approvalModes[readiness.approval.mode]()}</strong>
            <span>{readiness.approval.summary}</span>
          </dd>
        </div>
        <div>
          <dt>{m.workflows_readiness_waiting()}</dt>
          <dd>
            <strong>{waitingLabel(readiness.waiting)}</strong>
            {readiness.waiting.repair &&
            (readiness.waiting.count === null ||
              readiness.waiting.count > 0) ? (
              <RepairLink
                organizationId={organizationId}
                definitionId={definitionId}
                repair={readiness.waiting.repair}
              />
            ) : (
              <span>{m.workflows_readiness_waiting_help()}</span>
            )}
          </dd>
        </div>
        <div>
          <dt>{m.workflows_readiness_results()}</dt>
          <dd>
            <strong>{outcomeLabel(readiness.outcomes)}</strong>
            {readiness.outcomes?.latest ? (
              <span>
                {rich(m.workflows_readiness_latest, {
                  summary: readiness.outcomes.latest.summary,
                  date: <WorkspaceDate value={readiness.outcomes.latest.at} />,
                })}
              </span>
            ) : (
              <span>{m.workflows_readiness_verified_help()}</span>
            )}
          </dd>
        </div>
      </dl>
      {readiness.approval.details.length ? (
        <Disclosure className="workflow-readiness-approval">
          <summary>
            <ShieldCheck size={14} aria-hidden="true" />{' '}
            {m.workflows_readiness_approval_details()}
          </summary>
          <ul>
            {readiness.approval.details.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
    </Card>
  );
}

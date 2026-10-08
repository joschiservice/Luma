import type { CaseProgress, CaseReview, CaseSummary } from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';

import { quantityUnit } from '../../lib/units';
import type { Domain } from '../primitives/domain-icon';
import type { OperationalState } from '../primitives/state';

type IssueKind = { label: string; domain: Domain };

type Label = () => string;

const kinds: Record<string, { label: Label; domain: Domain }> = {
  inventory_mismatch: {
    label: m.issues_kind_inventory_mismatch,
    domain: 'inventory',
  },
  sync_failure: { label: m.issues_kind_sync_failure, domain: 'apps' },
  stuck_fulfillment: {
    label: m.issues_kind_stuck_fulfillment,
    domain: 'fulfillment',
  },
  workflow_failure: {
    label: m.issues_kind_workflow_failure,
    domain: 'workflows',
  },
};

const sources: Record<string, string> = {
  shopify: 'Shopify',
  jtl: 'JTL',
  'jtl-onprem': 'JTL-Wawi',
  'jtl-cloud': 'JTL Cloud',
};

/** Converts an unrecognized underscore- or dash-separated code into a readable label. */
function humanize(value: string) {
  return value.replaceAll(/[_-]/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/** Describes what kind of problem an issue is, with its domain landmark. */
export function issueKind(item: Pick<CaseSummary, 'class'>): IssueKind {
  const kind = kinds[item.class];

  return kind
    ? { label: kind.label(), domain: kind.domain }
    : { label: m.issues_kind_other(), domain: 'issues' };
}

/** Names a source system as people know it, such as `jtl-cloud` → JTL Cloud. */
export function sourceLabel(source: string) {
  return sources[source] ?? humanize(source);
}

const states = {
  detected: m.issues_state_detected,
  diagnosed: m.issues_state_diagnosed,
  proposed: m.issues_state_proposed,
  awaiting_approval: m.issues_state_awaiting_approval,
  allowed: m.issues_state_allowed,
  executing: m.issues_state_executing,
  verifying: m.issues_state_verifying,
  resolved: m.issues_state_resolved,
  failed: m.issues_state_failed,
  escalated: m.issues_state_escalated,
} satisfies Record<CaseSummary['state'], Label>;

/** Names an issue lifecycle state, such as `awaiting_approval` → Needs approval. */
export function caseStateLabel(state: CaseSummary['state']) {
  return states[state]();
}

/** Names an issue severity on its own, such as “High”. */
export function severityLabel(severity: CaseSummary['severity']) {
  return severity === 'high'
    ? m.issues_severity_high()
    : m.issues_severity_medium();
}

/** Names an issue severity as a complete label, such as “High severity”. */
export function severityFullLabel(severity: CaseSummary['severity']) {
  return severity === 'high'
    ? m.issues_severity_high_label()
    : m.issues_severity_medium_label();
}

const recordKinds: Record<string, Label> = {
  sku: m.issues_record_sku,
  order: m.issues_record_order,
  order_line: m.issues_record_order_line,
  inventory: m.issues_record_inventory,
  inventory_position: m.issues_record_inventory_position,
  return: m.issues_record_return,
  purchase_order: m.issues_record_purchase_order,
  purchase_order_submission: m.issues_record_purchase_order,
  connection: m.issues_record_connection,
};

/** Names the kind of record an issue or change concerns, such as `inventory_position` → Stock position. */
export function recordKindLabel(kind: string) {
  return recordKinds[kind]?.() ?? humanize(kind);
}

const freshness = {
  fresh: m.issues_freshness_fresh,
  stale: m.issues_freshness_stale,
  unknown: m.common_unknown,
} satisfies Record<CaseSummary['freshness'], Label>;

/** Describes how current an issue’s evidence is. */
export function freshnessLabel(value: CaseSummary['freshness']) {
  return freshness[value]();
}

type Execution = NonNullable<CaseProgress['execution']>;

const executionStates = {
  prepared: m.issues_change_queued,
  unknown: m.issues_change_unclear,
  succeeded: m.issues_change_accepted,
  failed: m.issues_change_failed_short,
} satisfies Record<Execution['state'], Label>;

/** Says what happened to a sent change. Accepted means the connected system took it, not that it worked. */
export function executionStateLabel(state: Execution['state']) {
  return executionStates[state]();
}

const verificationOutcomes = {
  passed: m.issues_check_confirmed,
  failed: m.issues_check_not_confirmed,
  inconclusive: m.issues_check_unclear,
} satisfies Record<NonNullable<Execution['verification']>['outcome'], Label>;

/** Says what the independent outcome check found. */
export function verificationLabel(
  outcome: NonNullable<Execution['verification']>['outcome'],
) {
  return verificationOutcomes[outcome]();
}

const phases = {
  detecting: m.issues_phase_detecting,
  diagnosing: m.issues_phase_diagnosing,
  proposing: m.issues_phase_proposing,
  executing: m.issues_state_executing,
  awaiting_approval: m.issues_phase_awaiting_approval,
  reconciling: m.issues_phase_reconciling,
  verifying: m.issues_state_verifying,
  resolved: m.issues_state_resolved,
  no_incident: m.issues_phase_no_incident,
  shadow_completed: m.issues_phase_shadow_completed,
  escalated: m.issues_state_escalated,
  denied: m.issues_phase_denied,
} satisfies Record<
  NonNullable<CaseProgress['workflow']['progress']>['phase'],
  Label
>;

/** Describes the workflow’s current step for an issue. */
export function workflowStatusLabel(workflow: CaseProgress['workflow']) {
  if (workflow.availability === 'unavailable')
    return m.issues_workflow_unavailable();
  if (workflow.availability === 'not_started')
    return m.issues_workflow_not_started();

  return workflow.progress
    ? phases[workflow.progress.phase]()
    : m.issues_workflow_phase_unknown();
}

const decisions = {
  approve: m.issues_decision_approve,
  reject: m.issues_decision_reject,
  escalate: m.issues_decision_escalate,
} satisfies Record<CaseReview['permittedDecisions'][number], Label>;

/** Names a decision someone can make on an issue, such as “Escalate”. */
export function decisionLabel(kind: CaseReview['permittedDecisions'][number]) {
  return decisions[kind]();
}

const outcomes: Record<string, Label> = {
  succeeded: m.issues_outcome_succeeded,
  failed: m.issues_outcome_failed,
  passed: m.issues_check_confirmed,
  inconclusive: m.issues_check_unclear,
  approved: m.issues_outcome_approved,
  rejected: m.issues_outcome_rejected,
  escalated: m.issues_state_escalated,
};

/** Names a recorded event outcome, keeping unrecognized codes readable. */
export function eventOutcomeLabel(outcome: string) {
  return outcomes[outcome]?.() ?? humanize(outcome);
}

/** Formats a recorded decimal quantity in the active language without rounding it. */
export function quantityLabel(value: string) {
  return formatNumber(Number(value), { maximumFractionDigits: 6 });
}

/** Names a quantity unit; piece units such as `each` become “unit” or “units” in the active language. */
export function unitLabel(unit: string, quantity: string) {
  return quantityUnit(unit, quantity);
}

/**
 * Summarizes where an issue stands for lists and Home: whether it needs a person,
 * what Luma is doing, or how it ended. Verified means the outcome was observed.
 */
export function issueStatus(
  item: Pick<
    CaseSummary,
    'state' | 'attention' | 'resolution' | 'diagnosisStatus'
  >,
): { state: OperationalState; label: string } {
  if (item.state === 'resolved')
    return item.resolution === 'verified'
      ? { state: 'verified', label: m.issues_status_verified() }
      : { state: 'idle', label: m.issues_status_closed() };
  if (item.attention.required)
    return item.attention.reason === 'approval'
      ? { state: 'approval', label: m.issues_state_awaiting_approval() }
      : item.attention.reason === 'manual_intervention'
        ? { state: 'attention', label: m.issues_status_needs_action() }
        : { state: 'attention', label: m.issues_status_needs_review() };
  switch (item.state) {
    case 'failed':
      return { state: 'error', label: m.issues_state_failed() };
    case 'escalated':
      return { state: 'attention', label: m.issues_status_needs_review() };
    case 'executing':
      return { state: 'running', label: m.issues_state_executing() };
    case 'verifying':
      return { state: 'running', label: m.issues_state_verifying() };
    case 'allowed':
      return { state: 'running', label: m.issues_state_allowed() };
    case 'awaiting_approval':
      return { state: 'approval', label: m.issues_state_awaiting_approval() };
    case 'proposed':
      return { state: 'waiting', label: m.issues_state_proposed() };
    case 'diagnosed':
      return { state: 'waiting', label: m.issues_state_diagnosed() };
    default:
      return item.diagnosisStatus === 'failed'
        ? { state: 'error', label: m.issues_status_investigation_failed() }
        : item.diagnosisStatus === 'insufficient_evidence'
          ? { state: 'attention', label: m.issues_status_needs_evidence() }
          : { state: 'running', label: m.issues_status_investigating() };
  }
}

/** Formats elapsed time compactly in the active language, such as 45s, 12m, 3h or 2d. */
export function elapsed(from: string, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - Date.parse(from)) / 1000));
  const [value, unit] =
    seconds < 60
      ? [seconds, 'second']
      : seconds < 3600
        ? [Math.floor(seconds / 60), 'minute']
        : seconds < 86400
          ? [Math.floor(seconds / 3600), 'hour']
          : [Math.floor(seconds / 86400), 'day'];

  return formatNumber(value, {
    style: 'unit',
    unit,
    unitDisplay: 'narrow',
  });
}

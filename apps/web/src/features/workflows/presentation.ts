import type {
  WorkflowReadiness,
  WorkflowRunView,
  WorkflowTrigger,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { namedIssueKinds } from '@luma/ui/components/issues/case-presentation';
import type { Domain } from '@luma/ui/components/primitives/domain-icon';
import type { OperationalState } from '@luma/ui/components/primitives/state';

/** Displays provider names while preserving unknown installed system identifiers. */
export function workflowSystemLabel(system: string): string {
  return (
    (
      {
        'jtl-cloud': 'JTL Cloud',
        'jtl-onprem': 'JTL-Wawi',
        'cin7-core': 'Cin7 Core',
        shopify: 'Shopify',
        luma: 'Luma',
      } as Record<string, string>
    )[system] ?? system
  );
}

/** Names an issue or signal type the way Issues does, keeping unknown types readable. */
function issueTypeLabel(issueType: string) {
  return (
    namedIssueKinds().find((kind) => kind.class === issueType)?.label ??
    issueType.replaceAll(/[_.]/g, ' ').replace(/^./, (c) => c.toUpperCase())
  );
}

/** Gives each supported trigger an unambiguous human-readable description. */
export function workflowTriggerLabel(trigger: WorkflowTrigger): string {
  switch (trigger.kind) {
    case 'manual':
      return m.workflows_trigger_manual();
    case 'exception':
      return m.workflows_trigger_issue_detected({
        issue: issueTypeLabel(trigger.issueType),
      });
    case 'event':
      return issueTypeLabel(trigger.eventType);
    case 'schedule':
      return m.workflows_trigger_schedule();
    case 'condition':
      return trigger.field === 'belowMinimum' && trigger.equals === true
        ? m.workflows_trigger_below_minimum()
        : m.workflows_trigger_condition({
            field: trigger.field,
            value: String(trigger.equals),
          });
  }
}

/** Trigger kinds in the order the library offers them as a filter. */
export const workflowTriggerKinds = [
  'exception',
  'condition',
  'event',
  'schedule',
  'manual',
] as const satisfies readonly WorkflowTrigger['kind'][];

/** Names what kind of signal starts a workflow, such as "Issue detected", for filtering. */
export function workflowTriggerKindLabel(kind: WorkflowTrigger['kind']) {
  return {
    exception: m.workflows_trigger_kind_exception,
    condition: m.workflows_trigger_kind_condition,
    event: m.workflows_trigger_kind_event,
    schedule: m.workflows_trigger_kind_schedule,
    manual: m.workflows_trigger_kind_manual,
  }[kind]();
}

const categories: Record<string, { label: () => string; domain: Domain }> = {
  resolution: { label: m.workflows_category_resolution, domain: 'issues' },
  procurement: {
    label: m.workflows_category_procurement,
    domain: 'procurement',
  },
  connections: { label: m.workflows_category_connections, domain: 'apps' },
  inventory: { label: m.workflows_category_inventory, domain: 'inventory' },
  fulfillment: {
    label: m.workflows_category_fulfillment,
    domain: 'fulfillment',
  },
  orders: { label: m.workflows_category_orders, domain: 'orders' },
  returns: { label: m.workflows_category_returns, domain: 'returns' },
};

/** Names a workflow's operational area; resolution workflows fix detected issues. */
export function workflowCategoryLabel(category: string): string {
  return Object.hasOwn(categories, category)
    ? categories[category]!.label()
    : category.charAt(0).toUpperCase() + category.slice(1);
}

/** The domain landmark for a workflow's area, so rows read like the records they act on. */
export function workflowDomain(category: string): Domain {
  return Object.hasOwn(categories, category)
    ? categories[category]!.domain
    : 'workflows';
}

/**
 * Where a workflow stands for the people who run it, combining whether it is on with whether it
 * can run. Both facts stay visible: a workflow that is off and blocked needs setup, which is not a
 * failure, while one that is on and blocked can't run and needs attention.
 */
export type WorkflowLifecycle =
  'attention' | 'on' | 'paused' | 'available' | 'setup';

/** Lifecycle groups in the order the library shows them, most urgent first. */
export const workflowLifecycles: readonly WorkflowLifecycle[] = [
  'attention',
  'on',
  'paused',
  'available',
  'setup',
];

/** Groups a workflow by what its people need to do with it. */
export function workflowLifecycle(
  readiness: WorkflowReadiness,
): WorkflowLifecycle {
  if (needsAttention(readiness)) return 'attention';
  if (readiness.enablement === 'enabled') return 'on';
  if (readiness.enablement === 'paused') return 'paused';

  return readiness.state === 'blocked' ? 'setup' : 'available';
}

/**
 * Whether a workflow belongs in "Needs attention": it is on or paused and can't fully run, a
 * decision waits for a person, or its latest run ended unresolved. A workflow nobody turned on
 * only needs setup, so its blockers don't count here.
 */
export function needsAttention(readiness: WorkflowReadiness) {
  return (
    (readiness.enablement !== 'not_enabled' && readiness.state !== 'ready') ||
    (readiness.waiting.count ?? 0) > 0 ||
    readiness.outcomes?.latest?.state === 'unresolved'
  );
}

/** Names a lifecycle group, such as "Ready to turn on". */
export function workflowLifecycleLabel(lifecycle: WorkflowLifecycle) {
  return {
    attention: m.workflows_lifecycle_attention,
    on: m.workflows_lifecycle_on,
    paused: m.workflows_lifecycle_paused,
    available: m.workflows_lifecycle_available,
    setup: m.workflows_lifecycle_setup,
  }[lifecycle]();
}

/**
 * One short status for a workflow, such as "On", "Can't run" or "Needs setup", with the
 * operational state that colors it. Red is reserved for workflows that are on and can't run.
 */
export function workflowStatus(readiness: WorkflowReadiness): {
  label: string;
  state: OperationalState;
} {
  const { enablement, state } = readiness;
  if (enablement === 'not_enabled')
    return state === 'blocked'
      ? { label: m.workflows_status_needs_setup(), state: 'waiting' }
      : { label: m.workflows_status_off(), state: 'idle' };
  if (state === 'blocked')
    return { label: m.workflows_status_cannot_run(), state: 'error' };
  if (enablement === 'paused')
    return {
      label: m.workflows_status_paused(),
      state: state === 'degraded' ? 'attention' : 'idle',
    };

  return state === 'degraded'
    ? { label: m.workflows_status_gaps(), state: 'attention' }
    : { label: m.workflows_status_on(), state: 'running' };
}

/** How a run reads in history: needs a look, waits for a person, still active, verified or ended. */
export type RunOutcome =
  'attention' | 'waiting' | 'active' | 'verified' | 'ended';

/** Run filters in display order; `all` shows every recent run. */
export const runViews = ['all', 'attention', 'active', 'verified'] as const;

export type RunView = (typeof runViews)[number];

const processOutcomes: Record<
  NonNullable<WorkflowRunView['processState']>,
  [RunOutcome, OperationalState, () => string]
> = {
  running: ['active', 'running', m.workflows_run_state_running],
  awaiting_decision: [
    'waiting',
    'approval',
    m.workflows_run_state_awaiting_decision,
  ],
  waiting: ['active', 'waiting', m.workflows_run_state_waiting],
  verified: ['verified', 'verified', m.workflows_run_state_verified],
  ended: ['ended', 'idle', m.workflows_run_state_ended],
  not_executed: ['ended', 'idle', m.issues_observe_only_title],
  denied: ['attention', 'attention', m.workflows_run_state_denied],
  failed_verification: [
    'attention',
    'error',
    m.workflows_run_state_failed_verification,
  ],
  inconclusive_verification: [
    'attention',
    'attention',
    m.workflows_run_state_inconclusive_verification,
  ],
  escalated: ['attention', 'attention', m.workflows_run_state_escalated],
};

/**
 * Reads a run's state for history and filters. Only an independent verification reads as
 * verified; an accepted change without one stays unverified.
 */
export function runOutcome(run: WorkflowRunView): {
  outcome: RunOutcome;
  state: OperationalState;
  label: string;
} {
  if (run.triggerState === 'scheduled')
    return {
      outcome: 'active',
      state: 'waiting',
      label: m.workflows_run_state_scheduled(),
    };
  if (run.triggerState === 'awaiting_admission')
    return {
      outcome: 'active',
      state: 'waiting',
      label: m.workflows_run_state_awaiting_start(),
    };
  if (run.triggerState === 'cancelled')
    return {
      outcome: 'ended',
      state: 'idle',
      label: m.workflows_run_state_cancelled(),
    };
  if (run.triggerState === 'skipped')
    return {
      outcome: 'ended',
      state: 'idle',
      label: m.workflows_run_state_skipped(),
    };
  if (run.processState) {
    const [outcome, state, label] = processOutcomes[run.processState];

    return { outcome, state, label: label() };
  }
  if (run.verification === 'verified')
    return {
      outcome: 'verified',
      state: 'verified',
      label: m.workflows_run_state_verified(),
    };
  if (run.verification === 'failed')
    return {
      outcome: 'attention',
      state: 'error',
      label: m.workflows_run_state_failed_verification(),
    };
  if (run.verification === 'inconclusive')
    return {
      outcome: 'attention',
      state: 'attention',
      label: m.workflows_run_state_inconclusive_verification(),
    };
  if (run.execution === 'awaiting_approval')
    return {
      outcome: 'waiting',
      state: 'approval',
      label: m.workflows_run_state_awaiting_decision(),
    };
  if (run.execution === 'denied')
    return {
      outcome: 'attention',
      state: 'attention',
      label: m.workflows_run_state_denied(),
    };
  if (run.execution === 'not_executed')
    return {
      outcome: 'ended',
      state: 'idle',
      label: m.issues_observe_only_title(),
    };

  return {
    outcome: 'active',
    state: 'waiting',
    label: m.workflows_run_state_not_verified(),
  };
}

/** Whether a run belongs in a history filter. Runs waiting for a person need a look. */
export function inRunView(run: WorkflowRunView, view: RunView) {
  if (view === 'all') return true;
  const { outcome } = runOutcome(run);
  if (view === 'attention')
    return outcome === 'attention' || outcome === 'waiting';

  return outcome === view;
}

/** Names the record a run worked on, such as "Stock position", without exposing its ID. */
export function runSubjectLabel(kind: string) {
  const known: Record<string, () => string> = {
    inventory_position: m.workflows_runs_stock_position,
    order: m.workflows_subject_order,
    fulfillment: m.workflows_subject_fulfillment,
    purchase_order: m.workflows_subject_purchase_order,
    connection: m.workflows_subject_connection,
    return: m.workflows_subject_return,
    sku: m.workflows_subject_sku,
    supplier: m.workflows_subject_supplier,
  };

  return Object.hasOwn(known, kind)
    ? known[kind]!()
    : kind.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());
}

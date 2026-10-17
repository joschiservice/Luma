import {
  type ActivityEvent,
  type ActivityExportRequest,
  activityOutcomes,
  activityTypes,
} from '@luma/api-contract';
import { formatCalendarDate } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import {
  issueKind,
  namedIssueKinds,
} from '@luma/ui/components/issues/case-presentation';
import type { CollectionFilterOption } from '@luma/ui/components/primitives/collection-toolbar';
import type { OperationalState } from '@luma/ui/components/primitives/state';
import {
  operatorCodeLabel,
  operatorCodeMessages,
} from '@luma/ui/lib/operator-code';
import { workspaceDateValue } from '@luma/ui/lib/timezone';

import { providerName } from '../sync/presentation';

/** A workspace connection that activity can be filtered by. */
export interface ActivitySource {
  id: string;
  label: string;
  /** The connection's target kind, which activity records as its system. */
  system: string;
}

type Label = () => string;

/**
 * Readable names for activity codes: outcomes, event types, modes and the recorded actions
 * Luma knows. Values are message functions so each render reads the active language.
 */
const activityLabels: Record<string, Label> = {
  approved: m.activity_outcome_approved,
  rejected: m.activity_outcome_rejected,
  escalated: m.activity_outcome_escalated,
  attempted: m.activity_outcome_attempted,
  provider_accepted: m.activity_outcome_provider_accepted,
  verified: m.activity_outcome_verified,
  failed: m.activity_outcome_failed,
  uncertain: m.activity_outcome_uncertain,
  manually_disposed: m.activity_outcome_manually_disposed,
  recorded: m.activity_outcome_recorded,

  issue: m.activity_type_issue,
  decision: m.activity_type_decision,
  execution: m.activity_type_execution,
  verification: m.activity_type_verification,
  resolution: m.activity_type_resolution,
  connection: m.activity_type_connection,
  procurement: m.activity_type_procurement,
  access: m.activity_type_access,

  simulation: m.activity_mode_simulation,
  shadow: m.activity_mode_shadow,
  pilot: m.activity_mode_pilot,

  'exception.detected': m.activity_action_issue_detected,
  'exception.resolved': m.activity_action_issue_resolved,
  'case.close': m.activity_action_issue_closed,
  'exception.escalated': m.activity_action_issue_escalated,
  'case.escalated': m.activity_action_issue_escalated,
  'case.escalate': m.activity_action_issue_escalated,
  'case.updated': m.activity_action_issue_updated,
  'exception.review_required': m.activity_action_issue_review_required,
  'exception.reevaluated': m.activity_action_issue_reevaluated,
  'exception.verification_attempt': m.activity_action_issue_check_attempt,
  'exception.verification_inconclusive':
    m.activity_action_issue_check_inconclusive,
  'case.approve': m.activity_action_change_approved,
  'case.reject': m.activity_action_change_rejected,
  'execution.prepared': m.activity_action_change_prepared,
  'execution.dispatched': m.activity_action_change_sent,
  'execution.completed': m.activity_action_change_finished,
  'execution.withheld': m.activity_action_change_withheld,
  'execution.reconciled': m.activity_action_change_confirmed,
  'execution.verification_pending': m.activity_action_change_check_started,
  'execution.verification_completed': m.activity_action_change_checked,
  'policy.evaluated': m.activity_action_rules_checked,
  'policy.approved': m.activity_action_rules_approved,
  'policy.updated': m.activity_action_rules_changed,
  'approval.responded': m.activity_action_approval_answered,
  'connection.connected': m.activity_action_connection_connected,
  'connection.disconnected': m.activity_action_connection_disconnected,
  'connection.reconnected': m.activity_action_connection_reconnected,
  'connection.revoked': m.activity_action_connection_revoked,
  'connection.webhook_secret_generated':
    m.activity_action_connection_webhook_secret_generated,
  'connection.installed': m.activity_action_connection_installed,
  'connection.health_checked': m.activity_action_connection_health_checked,
  'connection.credentials_rotated':
    m.activity_action_connection_credentials_rotated,
  'connection.write_mode_changed':
    m.activity_action_connection_write_mode_changed,
  'connection.provider_access_failed':
    m.activity_action_connection_provider_access_failed,
  'connection.app_uninstalled': m.activity_action_connection_app_uninstalled,
  'connection.renamed': m.activity_action_connection_renamed,
  'purchase_order.created': m.activity_action_po_created,
  'purchase_order.status_changed': m.activity_action_po_status_changed,
  'purchase_order.submitted': m.activity_action_po_submitted,
  'purchase_order.submission_requested':
    m.activity_action_po_submission_requested,
  'purchase_order.submission_approved':
    m.activity_action_po_submission_approved,
  'purchase_order.submission_rejected':
    m.activity_action_po_submission_rejected,
  'purchase_order.follow_up': m.activity_action_po_follow_up,
  'purchase_order.commitment_recorded':
    m.activity_action_po_commitment_recorded,
  'purchase_order.commitment_reviewed':
    m.activity_action_po_commitment_reviewed,
  'purchase_order.message_recorded': m.activity_action_po_message_recorded,
  'purchase_order.message_read': m.activity_action_po_message_read,
  'purchase_order.message_removed': m.activity_action_po_message_removed,
  'purchase_order.email_submission': m.activity_action_po_email_submission,
  'messaging.reply.delivery_resolved':
    m.activity_action_email_delivery_resolved,
  'workflow.activated': m.activity_action_workflow_enabled,
  'workflow.activation_revoked': m.activity_action_workflow_disabled,
  'workflow.published': m.activity_action_workflow_published,
  'workflow.draft_created': m.activity_action_workflow_draft_created,
  'workflow.draft_discarded': m.activity_action_workflow_draft_discarded,
  'workflow.step_recorded': m.activity_action_workflow_step_recorded,
  'workflow.run': m.activity_action_workflow_run,
  'role.created': m.activity_action_role_created,
  'role.updated': m.activity_action_role_changed,
  'role.archived': m.activity_action_role_archived,
  'role.app_permissions_removed':
    m.activity_action_role_app_permissions_removed,
  'member.add': m.activity_action_member_added,
  'member.update': m.activity_action_member_changed,
  'member.remove': m.activity_action_member_removed,
  'member.suspended': m.activity_action_member_suspended,
  'member.reactivated': m.activity_action_member_reactivated,
  'support_view.started': m.activity_action_support_view_started,
  'support_view.emergency_started':
    m.activity_action_support_view_emergency_started,
  'support_view.read': m.activity_action_support_view_read,
  'support_view.ended': m.activity_action_support_view_ended,
  'support_access.allowed': m.activity_action_support_access_allowed,
  'support_access.revoked': m.activity_action_support_access_revoked,
  'support_access.requested': m.activity_action_support_access_requested,
  'support_access.request_approved':
    m.activity_action_support_access_request_approved,
  'support_access.request_declined':
    m.activity_action_support_access_request_declined,
  'support_inspection.requested':
    m.activity_action_support_inspection_requested,
  'support_inspection.approved': m.activity_action_support_inspection_approved,
  'support_inspection.declined': m.activity_action_support_inspection_declined,
  'support_inspection.expired': m.activity_action_support_inspection_expired,
  'support_inspection.revoked': m.activity_action_support_inspection_revoked,
  'support_inspection.emergency_opened':
    m.activity_action_support_inspection_emergency_opened,
  'invitation.created': m.activity_action_invitation_created,
  'invitation.accepted': m.activity_action_invitation_accepted,
  'invitation.revoked': m.activity_action_invitation_revoked,
  'workspace.updated': m.activity_action_workspace_changed,
  'collections.exported': m.activity_action_list_exported,
};

/** Readable names for the changes Luma can propose, keyed by their recorded change code. */
const changeLabels: Record<string, Label> = {
  'orders.shipping-method.write': m.activity_change_shipping_method,
  'inventory.write': m.activity_change_inventory,
  'orders.write': m.activity_change_order,
  'orders.cancel': m.activity_change_order_cancel,
  'procurement.purchase-order.create': m.activity_change_purchase_order,
  'payments.refund.create': m.activity_change_refund,
  'fulfillment.retry': m.activity_change_fulfillment_retry,
};

const humanize = (value: string) => {
  const text = value.replaceAll(/[._-]/g, ' ');

  return text.charAt(0).toUpperCase() + text.slice(1);
};

/**
 * Turns an activity code into a readable label in the active language: `execution.completed`
 * becomes "Change attempt finished". A `provider_accepted` outcome names the connected system
 * when `system` is given. Codes Luma doesn't know are shown with separators replaced by spaces.
 */
export function activityLabel(value: string, system?: string | null) {
  if (value === 'provider_accepted' && system)
    return m.activity_outcome_provider_accepted_by({
      system: providerName(system),
    });
  const known = activityLabels[value] ?? operatorCodeMessages[value];

  return known ? known() : humanize(value);
}

/**
 * Names a proposed change by its recorded change code, such as "Change the order’s shipping
 * method". Unknown codes are shown with separators replaced by spaces.
 */
export function activityChangeLabel(value: string) {
  const known = changeLabels[value] ?? operatorCodeMessages[value];

  return known ? known() : humanize(value);
}

/**
 * Maps a recorded outcome to its operational state. Only `verified` counts as a
 * confirmed result; an accepted request is still in progress.
 */
export function activityState(
  outcome: ActivityEvent['outcome'],
): OperationalState {
  switch (outcome) {
    case 'verified':
      return 'verified';
    case 'failed':
    case 'rejected':
      return 'error';
    case 'escalated':
    case 'uncertain':
      return 'attention';
    case 'attempted':
    case 'provider_accepted':
      return 'running';
    case 'approved':
      return 'approval';
    default:
      return 'idle';
  }
}

/**
 * Offers each workspace connection by label. An applied connection that is no longer listed keeps
 * an option with its shortened ID, so its filter chip stays readable.
 */
export function activityConnectionOptions(
  sources: readonly ActivitySource[],
  applied: string | undefined,
): CollectionFilterOption[] {
  const options = sources.map((source) => ({
    value: source.id,
    label: source.label,
  }));
  if (applied && !options.some((option) => option.value === applied))
    options.push({
      value: applied,
      label: m.activity_filter_connection_unlisted({ id: applied.slice(0, 8) }),
    });

  return options;
}

/**
 * Offers each distinct system the workspace connects to, named by provider where Luma knows it.
 * An applied system that no connection uses any more keeps an option with its raw value.
 */
export function activitySystemOptions(
  sources: readonly ActivitySource[],
  applied: string | undefined,
): CollectionFilterOption[] {
  const systems = new Set(sources.map((source) => source.system));
  if (applied) systems.add(applied);

  return Array.from(systems, (system) => ({
    value: system,
    label: providerName(system),
  }));
}

/**
 * The authoritative record where an event can be acted on, named for its button: the purchase
 * order, the issue with its evidence, the Workflow or Apps. Undefined when the event has none.
 */
export function activityRecordLink(
  item: ActivityEvent,
  organizationId: string,
): { href: string; label: string } | undefined {
  const base = `/app/${encodeURIComponent(organizationId)}`;
  if (item.type === 'procurement' && item.proposalId)
    return {
      href: `${base}/procurement/${encodeURIComponent(item.proposalId)}`,
      label: m.activity_link_purchase_order(),
    };
  if (item.exceptionId)
    return {
      href: `${base}/exceptions/${encodeURIComponent(item.exceptionId)}`,
      label: m.activity_link_issue(),
    };
  if (item.playbookId)
    return {
      href: `${base}/workflows/${encodeURIComponent(item.playbookId)}${item.workflowRunId ? `#run-${encodeURIComponent(item.workflowRunId)}` : ''}`,
      label: m.activity_link_workflow(),
    };
  if (item.connectionId)
    return {
      href: `${base}/apps#connection-${encodeURIComponent(item.connectionId)}`,
      label: m.activity_link_apps(),
    };

  return undefined;
}

/** Opens the event's authoritative record, or the event in Activity when it has none. */
export function activityHref(
  item: ActivityEvent,
  organizationId: string,
): string {
  return (
    activityRecordLink(item, organizationId)?.href ??
    `/app/${encodeURIComponent(organizationId)}/activity?event=${encodeURIComponent(item.id)}`
  );
}

/**
 * Names the business change without exposing storage identifiers. Procurement and access events
 * are named by their action, because their summary is a reason or the role that changed.
 */
export function activityTitle(
  item: Pick<ActivityEvent, 'type' | 'summary' | 'action'> &
    Partial<Pick<ActivityEvent, 'actor'>>,
): string {
  if (item.type === 'procurement' || item.type === 'access')
    return activityLabel(item.action);

  if (!item.summary)
    return item.actor?.workflow?.name || activityLabel(item.action);

  return /^[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)+$/.test(item.summary)
    ? activityChangeLabel(item.summary)
    : item.summary;
}

type Outcome = ActivityEvent['outcome'];

/** The built-in ways to read Activity, each a set of outcomes. */
export type ActivityQuickView = 'all' | 'attention' | 'verified';

// Attention means someone should look: a failure, an unclear result or an escalation.
const quickViews: Record<ActivityQuickView, readonly Outcome[]> = {
  all: [],
  attention: ['escalated', 'failed', 'uncertain'],
  verified: ['verified'],
};

/** The outcomes a quick view filters by; none for all activity. */
export function activityQuickViewOutcomes(view: ActivityQuickView) {
  return quickViews[view];
}

/** The quick view the outcome filter matches, or null when it names another set. */
export function activityQuickView(
  outcome: readonly Outcome[] | undefined,
): ActivityQuickView | null {
  const chosen = new Set(outcome ?? []);
  const match = (Object.keys(quickViews) as ActivityQuickView[]).find(
    (view) =>
      quickViews[view].length === chosen.size &&
      quickViews[view].every((value) => chosen.has(value)),
  );

  return match ?? null;
}

/** One workspace calendar day of the list, newest first. */
export interface ActivityDay {
  /** The workspace calendar day, such as `2026-10-15`. */
  day: string;
  items: ActivityEvent[];
}

/**
 * Splits events, newest first, into workspace calendar days by when they were recorded. Repeated
 * event IDs, which a page boundary can produce while new events arrive, are listed once.
 */
export function activityDays(
  items: readonly ActivityEvent[],
  timeZone: string,
): ActivityDay[] {
  const seen = new Set<string>();
  const days: ActivityDay[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const day = workspaceDateValue(new Date(item.recordedAt), timeZone);
    const last = days.at(-1);
    if (last?.day === day) last.items.push(item);
    else days.push({ day, items: [item] });
  }

  return days;
}

/**
 * Names a day heading: Today, Yesterday, the weekday and date within the year, or the full date
 * for earlier years.
 */
export function activityDayLabel(day: string, today: string) {
  if (day === today) return m.activity_day_today();
  const yesterday = new Date(`${today}T00:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  if (day === yesterday.toISOString().slice(0, 10))
    return m.activity_day_yesterday();

  return formatCalendarDate(
    day,
    day.slice(0, 4) === today.slice(0, 4)
      ? { weekday: 'long', day: 'numeric', month: 'long' }
      : { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' },
  );
}

const resourceKinds: Record<string, Label> = {
  order: m.activity_resource_order,
  sku: m.activity_resource_product,
  product: m.activity_resource_product,
  fulfillment: m.activity_resource_fulfillment,
  connection: m.activity_resource_connection,
  workflow_run: m.activity_resource_workflow_run,
  purchase_order: m.activity_resource_purchase_order,
};

const storageId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Names the record an event concerns, such as "Order 1042" or "Product". Storage IDs are left
 * out, because they mean nothing to the reader; the record link and the record IDs carry them.
 */
export function activityResourceLabel(
  item: Pick<ActivityEvent, 'resource' | 'resourceKind' | 'type'>,
): string | undefined {
  if (item.type === 'access' || !item.resource) return undefined;
  const kind = item.resourceKind ? resourceKinds[item.resourceKind] : undefined;
  const reference = storageId.test(item.resource) ? undefined : item.resource;
  if (!kind) return reference;
  // Some sources record the reference with its kind already, such as "Order 1042".
  if (!reference || reference.toLowerCase().startsWith(kind().toLowerCase()))
    return reference ?? kind();

  return m.activity_resource_named({ kind: kind(), reference });
}

/**
 * Says what an event is about in a few words: the kind of issue, the record, or for access and
 * procurement events the role, setting or reason that was recorded.
 */
export function activitySubject(
  item: Pick<
    ActivityEvent,
    'type' | 'summary' | 'resource' | 'resourceKind' | 'issueClass'
  >,
): string[] {
  const parts: string[] = [];
  if (item.issueClass) parts.push(issueKind({ class: item.issueClass }).label);
  if (item.type === 'access' && item.summary) parts.push(item.summary);
  if (item.type === 'procurement' && item.summary)
    parts.push(
      operatorCodeMessages[item.summary]
        ? operatorCodeLabel(item.summary)
        : item.summary,
    );
  // A record named only by its kind adds little beside the kind of issue.
  const resource = activityResourceLabel(item);
  const kindOnly = !!item.resource && storageId.test(item.resource);
  if (resource && !(kindOnly && item.issueClass)) parts.push(resource);

  return parts;
}

/**
 * Explains what an outcome does and doesn't establish, so an approval or an accepted request is
 * never read as a verified result. Recorded events need no explanation.
 */
export function activityOutcomeExplanation(
  outcome: Outcome,
  system?: string | null,
): string | undefined {
  switch (outcome) {
    case 'verified':
      return m.activity_explain_verified();
    case 'provider_accepted':
      return m.activity_explain_provider_accepted({
        system: system ? providerName(system) : m.activity_explain_system(),
      });
    case 'attempted':
      return m.activity_explain_attempted();
    case 'uncertain':
      return m.activity_explain_uncertain();
    case 'failed':
      return m.activity_explain_failed();
    case 'approved':
      return m.activity_explain_approved();
    case 'rejected':
      return m.activity_explain_rejected();
    case 'escalated':
      return m.activity_explain_escalated();
    case 'manually_disposed':
      return m.activity_explain_manually_disposed();
    default:
      return undefined;
  }
}

/** One recorded step of an event's history, oldest first. */
export interface ActivityStep {
  event: ActivityEvent;
  /** The step is the event the list shows. */
  current: boolean;
  /** A routine check or a check still waiting for its result. */
  routine: boolean;
}

/**
 * Orders an event and its earlier steps by when they were recorded, oldest first. Routine steps
 * are the rule checks and workflow step records the list never shows on their own, and checks
 * that were only started; a failed rule check is not routine.
 */
export function activitySteps(item: ActivityEvent): ActivityStep[] {
  return [...(item.steps ?? []), item]
    .map((event) => ({
      event,
      current: event === item,
      routine:
        event !== item &&
        (event.verificationPhase === 'pending' ||
          (['policy.evaluated', 'workflow.step_recorded'].includes(
            event.action,
          ) &&
            event.outcome !== 'failed')),
    }))
    .sort(
      (a, b) =>
        a.event.recordedAt.localeCompare(b.event.recordedAt) ||
        Number(a.current) - Number(b.current),
    );
}

/**
 * The state a step shows. A check that was only started reads as waiting rather than unclear,
 * because its result was recorded separately.
 */
export function activityStepState(event: ActivityEvent): OperationalState {
  return event.verificationPhase === 'pending'
    ? 'waiting'
    : activityState(event.outcome);
}

/** The outcome label a step shows; a started check reads as started. */
export function activityStepOutcome(event: ActivityEvent) {
  return event.verificationPhase === 'pending'
    ? m.activity_step_check_started()
    : activityLabel(event.outcome, event.system);
}

// Recorded detail values that Luma knows; other values are shown as recorded.
const detailLabels = {
  dispatch: {
    dispatched: m.activity_request_dispatched,
    accepted: m.activity_request_accepted,
  },
  executionState: {
    unknown: m.activity_state_unknown,
    prepared: m.activity_state_prepared,
    succeeded: m.activity_state_succeeded,
    failed: m.activity_state_failed,
  },
  verificationPhase: {
    pending: m.activity_phase_pending,
    completed: m.activity_phase_completed,
  },
  verification: {
    passed: m.activity_check_passed,
    failed: m.activity_check_failed,
    inconclusive: m.activity_check_inconclusive,
  },
} satisfies Record<string, Record<string, Label>>;

/** Names a recorded request status, change status, check stage or check result. */
export function activityDetailLabel(
  field: keyof typeof detailLabels,
  value: string,
) {
  const labels: Record<string, Label> = detailLabels[field];

  return labels[value]?.() ?? value;
}

/**
 * The issue kinds whose names, in the reader's language, contain the search text, so searching
 * "fulfillment delay" finds those issues. Text shorter than three characters names none.
 */
export function activitySearchIssueClasses(q: string): string[] {
  const text = q.trim().toLocaleLowerCase();
  if (text.length < 3) return [];

  return namedIssueKinds()
    .filter((kind) => kind.label.toLocaleLowerCase().includes(text))
    .map((kind) => kind.class);
}

const exportHeadings: Record<
  keyof ActivityExportRequest['headings'] & string,
  Label
> = {
  recordedAt: m.activity_export_recorded_at,
  occurredAt: m.activity_export_occurred_at,
  action: m.activity_export_action,
  type: m.activity_export_type,
  outcome: m.activity_export_outcome,
  actorKind: m.activity_export_actor_kind,
  actor: m.activity_export_actor,
  actorEmail: m.activity_export_actor_email,
  workflow: m.activity_export_workflow,
  issueClass: m.activity_export_issue_class,
  resourceKind: m.activity_export_resource_kind,
  resource: m.activity_export_resource,
  summary: m.activity_export_summary,
  system: m.activity_export_system,
  connections: m.activity_export_connections,
  dispatch: m.activity_export_dispatch,
  executionState: m.activity_export_execution_state,
  verificationPhase: m.activity_export_verification_phase,
  verification: m.activity_export_verification,
  failureCode: m.activity_export_failure_code,
  mode: m.activity_export_mode,
  eventId: m.activity_export_event_id,
  issueId: m.activity_export_issue_id,
  proposalId: m.activity_export_proposal_id,
  attemptId: m.activity_export_attempt_id,
  workflowRunId: m.activity_export_workflow_run_id,
  evidence: m.activity_export_evidence,
};

const actorKinds: Record<ActivityEvent['actor']['kind'], Label> = {
  member: m.activity_export_actor_member,
  former_member: m.common_actor_former_member,
  luma: m.common_actor_luma,
  support: m.common_actor_support,
  service: m.activity_export_actor_service,
  unrecorded: m.common_actor_not_recorded,
};

/**
 * The headings and code names an export writes in the reader's language: every action, outcome,
 * type and mode Luma names, actor kinds, issue kinds, record kinds, the workspace's systems,
 * recorded statuses and error codes. Codes without a name stay as recorded.
 */
export function activityExportLabels(
  sources: readonly ActivitySource[],
): Omit<ActivityExportRequest, 'query'> {
  const values: Record<string, string> = {};
  const name = (column: string, code: string, label: string) => {
    values[`${column}:${code}`] = label;
  };
  for (const code of Object.keys(activityLabels))
    if (code.includes('.')) name('action', code, activityLabel(code));
  for (const outcome of activityOutcomes)
    name('outcome', outcome, activityLabel(outcome));
  for (const type of activityTypes) name('type', type, activityLabel(type));
  for (const mode of ['simulation', 'shadow', 'pilot'])
    name('mode', mode, activityLabel(mode));
  for (const [kind, label] of Object.entries(actorKinds))
    name('actorKind', kind, label());
  for (const kind of namedIssueKinds())
    name('issueClass', kind.class, kind.label);
  for (const [kind, label] of Object.entries(resourceKinds))
    name('resourceKind', kind, label());
  for (const system of new Set(sources.map((source) => source.system)))
    name('system', system, providerName(system));
  for (const [field, labels] of Object.entries(detailLabels))
    for (const [code, label] of Object.entries(labels))
      name(field, code, label());
  for (const code of Object.keys(operatorCodeMessages))
    name('failureCode', code, operatorCodeLabel(code));

  return {
    headings: Object.fromEntries(
      Object.entries(exportHeadings).map(([column, label]) => [
        column,
        label(),
      ]),
    ),
    values,
    truncated: m.activity_export_truncated(),
  };
}

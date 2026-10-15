import type { ActivityEvent } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import type { CollectionFilterOption } from '@luma/ui/components/primitives/collection-toolbar';
import type { OperationalState } from '@luma/ui/components/primitives/state';
import { operatorCodeMessages } from '@luma/ui/lib/operator-code';

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
  'policy.evaluated': m.activity_action_rules_checked,
  'policy.approved': m.activity_action_rules_approved,
  'policy.updated': m.activity_action_rules_changed,
  'approval.responded': m.activity_action_approval_answered,
  'connection.connected': m.activity_action_connection_connected,
  'connection.disconnected': m.activity_action_connection_disconnected,
  'connection.reconnected': m.activity_action_connection_reconnected,
  'connection.revoked': m.activity_action_connection_revoked,
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
  'invitation.created': m.activity_action_invitation_created,
  'invitation.accepted': m.activity_action_invitation_accepted,
  'invitation.revoked': m.activity_action_invitation_revoked,
  'workspace.updated': m.activity_action_workspace_changed,
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

/** Opens the event's authoritative record, with retained activity as a fallback. */
export function activityHref(
  item: ActivityEvent,
  organizationId: string,
): string {
  const base = `/app/${encodeURIComponent(organizationId)}`;
  if (item.type === 'procurement' && item.proposalId)
    return `${base}/procurement/${encodeURIComponent(item.proposalId)}`;
  if (item.exceptionId)
    return `${base}/exceptions/${encodeURIComponent(item.exceptionId)}`;
  if (item.playbookId && item.workflowRunId)
    return `${base}/workflows/${encodeURIComponent(item.playbookId)}#run-${encodeURIComponent(item.workflowRunId)}`;
  if (item.playbookId)
    return `${base}/workflows/${encodeURIComponent(item.playbookId)}`;
  if (item.connectionId)
    return `${base}/apps#connection-${encodeURIComponent(item.connectionId)}`;

  return `${base}/activity?event=${encodeURIComponent(item.id)}`;
}

/** Names the business change without exposing storage identifiers. */
export function activityTitle(
  item: Pick<ActivityEvent, 'type' | 'summary' | 'action'> &
    Partial<Pick<ActivityEvent, 'actor'>>,
): string {
  if (item.type === 'procurement') return activityLabel(item.action);

  if (!item.summary)
    return item.actor?.workflow?.name || activityLabel(item.action);

  return /^[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)+$/.test(item.summary)
    ? activityChangeLabel(item.summary)
    : item.summary;
}

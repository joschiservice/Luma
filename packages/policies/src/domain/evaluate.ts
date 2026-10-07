import type { Approval, PolicyDecision, ProposedAction } from './action.js';

/** The permission checks policy needs, satisfied by a tenant context's permission set. */
export interface PolicyAccess {
  has(permission: string): boolean;
}

/**
 * The capability facts policy evaluates. `permission` is what the actor needs for this step:
 * the capability's own permission when it declares one, otherwise `actions.propose` when
 * preparing a proposal and `actions.execute` when running it.
 */
export interface PolicyCapability {
  available: boolean;
  minimumRisk: ProposedAction['risk'];
  permission: string;
}

/** Evaluates the current policy without persisting a decision or granting execution authority. */
export function evaluatePolicy(
  action: ProposedAction,
  capability: PolicyCapability,
  access: PolicyAccess,
  actorId: string,
  now: number,
  approval: Approval | null = null,
  alwaysRequireApproval = false,
): Pick<PolicyDecision, 'outcome' | 'reason'> {
  let outcome: PolicyDecision['outcome'] = 'allowed';
  let reason: PolicyDecision['reason'] = 'authorized';
  if (!access.has(capability.permission)) {
    outcome = 'denied';
    reason = 'permission_denied';
  } else if (!capability.available) {
    outcome = 'denied';
    reason = 'capability_unavailable';
  } else if (
    Date.parse(action.expiresAt) <= now ||
    Date.parse(action.preconditions.validUntil) <= now
  ) {
    outcome = 'denied';
    reason = 'stale_intent';
  } else if (approval?.outcome === 'rejected') {
    // Rejection remains binding when risk metadata or the response expiry changes.
    outcome = 'denied';
    reason = 'approval_rejected';
  } else if (
    alwaysRequireApproval ||
    action.risk !== 'low' ||
    capability.minimumRisk !== 'low'
  ) {
    const bound =
      approval &&
      approval.requesterId === actorId &&
      Date.parse(approval.expiresAt) > now;
    if (!bound || approval.outcome !== 'approved') {
      outcome = 'approval_required';
      reason = 'approval_required';
    }
  }

  return { outcome, reason };
}

/**
 * States whether every proposal for an action needs a person, before any proposal exists. It
 * applies the same rules as `evaluatePolicy`: risk below the capability's minimum never lowers it,
 * and quantity-based risk can only add approval, never remove it.
 */
export function approvalRequirement(input: {
  minimumRisk: ProposedAction['risk'];
  /** A workflow version that requires approval for every action. */
  workflowRequired?: boolean;
  workspaceRequired: boolean;
}): {
  mode: 'every_action' | 'risk_based';
  reason: 'minimum_risk' | 'workspace_policy' | 'workflow' | 'risk';
} {
  if (input.minimumRisk !== 'low')
    return { mode: 'every_action', reason: 'minimum_risk' };
  if (input.workspaceRequired)
    return { mode: 'every_action', reason: 'workspace_policy' };
  if (input.workflowRequired)
    return { mode: 'every_action', reason: 'workflow' };

  return { mode: 'risk_based', reason: 'risk' };
}

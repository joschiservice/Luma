import type { Approval, PolicyDecision, ProposedAction } from './action.js';

/** Evaluates the current policy without persisting a decision or granting execution authority. */
export function evaluatePolicy(
  action: ProposedAction,
  capability: { available: boolean; minimumRisk: ProposedAction['risk'] },
  role: string,
  actorId: string,
  now: number,
  approval: Approval | null = null,
): Pick<PolicyDecision, 'outcome' | 'reason'> {
  let outcome: PolicyDecision['outcome'] = 'allowed';
  let reason: PolicyDecision['reason'] = 'authorized';
  if (!['owner', 'admin'].includes(role)) {
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
  } else if (action.risk !== 'low' || capability.minimumRisk !== 'low') {
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

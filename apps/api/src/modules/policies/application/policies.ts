import { requireRole, requireTenant } from '../../identity/index.js';
import type { TenantContext } from '../../identity/index.js';
import type {
  Approval,
  PolicyDecision,
  ProposedAction,
  PolicyEvidence,
} from '../domain/action.js';

export interface PolicyRepository {
  pending(tenantId: string): Promise<PolicyEvidence[]>;
  delivered(tenantId: string, id: string): Promise<void>;
  saveDecision(decision: PolicyDecision): Promise<void>;
  findDecision(tenantId: string, id: string): Promise<PolicyDecision | null>;
  findApproval(
    tenantId: string,
    proposalId: string,
    hash: string,
    policyVersion: string,
  ): Promise<Approval | null>;
  /** First response wins for this intent, requester and policy version. */
  saveApproval(approval: Approval): Promise<Approval>;
}
export interface PolicyDependencies {
  repository: PolicyRepository;
  appendEvidence(event: PolicyEvidence): Promise<void>;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  now(): Date;
  id(): string;
}
export function createPolicyService(deps: PolicyDependencies) {
  const policyVersion = 'v0.1';
  async function flush(tenantId: string) {
    for (const evidence of await deps.repository.pending(tenantId)) {
      await deps.appendEvidence(evidence);
      await deps.repository.delivered(tenantId, evidence.document.id);
    }
  }
  return {
    async evaluate(
      context: TenantContext,
      action: ProposedAction,
      actionHash: string,
      capability: { available: boolean; minimumRisk: ProposedAction['risk'] },
    ) {
      requireTenant(context, action.tenantId);
      const fresh = await deps.refreshContext(context);
      requireTenant(fresh, action.tenantId);
      if (fresh.actor.id !== context.actor.id) throw new Error('Actor changed');
      const now = deps.now();
      const approval = await deps.repository.findApproval(
        context.tenantId,
        action.id,
        actionHash,
        policyVersion,
      );
      let outcome: PolicyDecision['outcome'] = 'allowed';
      let reason: PolicyDecision['reason'] = 'authorized';
      if (!['owner', 'admin'].includes(fresh.actor.role)) {
        outcome = 'denied';
        reason = 'permission_denied';
      } else if (!capability.available) {
        outcome = 'denied';
        reason = 'capability_unavailable';
      } else if (
        Date.parse(action.expiresAt) <= now.getTime() ||
        Date.parse(action.preconditions.validUntil) <= now.getTime()
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
          approval.requesterId === fresh.actor.id &&
          Date.parse(approval.expiresAt) > now.getTime();
        if (!bound || approval.outcome !== 'approved') {
          outcome = 'approval_required';
          reason = 'approval_required';
        }
      }
      const decision: PolicyDecision = {
        id: deps.id(),
        correlationId: context.requestId,
        tenantId: context.tenantId,
        proposalId: action.id,
        actionHash,
        actorId: fresh.actor.id,
        capability: action.capability,
        policyVersion,
        outcome,
        reason,
        ...(approval && reason === 'authorized'
          ? { approvalId: approval.id }
          : {}),
        evaluatedAt: now.toISOString(),
        validUntil: new Date(
          Math.min(
            Date.parse(action.expiresAt),
            Date.parse(action.preconditions.validUntil),
            now.getTime() + 30_000,
            ...(approval ? [Date.parse(approval.expiresAt)] : []),
          ),
        ).toISOString(),
      };
      await deps.repository.saveDecision(decision);
      await flush(context.tenantId);
      return decision;
    },
    async respond(
      context: TenantContext,
      decisionId: string,
      outcome: Approval['outcome'],
      expiresAt: string,
    ) {
      requireTenant(context, context.tenantId);
      const fresh = await deps.refreshContext(context);
      requireTenant(fresh, context.tenantId);
      requireRole(fresh, ['owner', 'admin']);
      const decision = await deps.repository.findDecision(
        context.tenantId,
        decisionId,
      );
      if (
        !decision ||
        decision.outcome !== 'approval_required' ||
        decision.policyVersion !== policyVersion
      )
        throw new Error('Approval request not found');
      if (fresh.actor.id === decision.actorId)
        throw new Error('A different approver is required');
      const now = deps.now();
      const expiry = Date.parse(expiresAt);
      if (
        !['approved', 'rejected'].includes(outcome) ||
        !Number.isFinite(expiry) ||
        expiry <= now.getTime() ||
        expiry > now.getTime() + 86_400_000
      )
        throw new Error('Approval must expire within 24 hours');
      const approval = await deps.repository.saveApproval({
        decisionId: decision.id,
        id: deps.id(),
        correlationId: context.requestId,
        tenantId: context.tenantId,
        proposalId: decision.proposalId,
        actionHash: decision.actionHash,
        policyVersion,
        requesterId: decision.actorId,
        approverId: fresh.actor.id,
        outcome,
        expiresAt: new Date(expiry).toISOString(),
        createdAt: now.toISOString(),
      });
      await flush(context.tenantId);
      return approval;
    },
  };
}
export type PolicyService = ReturnType<typeof createPolicyService>;

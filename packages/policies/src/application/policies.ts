import type { TenantContext } from '@luma/identity';
import { IdentityError, requireRole, requireTenant } from '@luma/identity';
import { measure } from '@luma/platform';

import type {
  Approval,
  PolicyDecision,
  PolicyEvidence,
  ProposedAction,
} from '../domain/action.js';
import { workspacePolicyVersion } from '../domain/action.js';
import { evaluatePolicy } from '../domain/evaluate.js';

export interface PolicyRepository {
  /** Reads the current workspace approval requirement and its revision. */
  workspacePolicy(
    tenantId: string,
  ): Promise<{ revision: number; required: boolean }>;
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

/**
 * Creates policy evaluation and approval commands that refresh authorization and record
 * decision evidence.
 */
export function createPolicyService(deps: PolicyDependencies) {
  const version = async (tenantId: string) =>
    workspacePolicyVersion(
      (await deps.repository.workspacePolicy(tenantId)).revision,
    );

  async function flush(tenantId: string) {
    for (const evidence of await deps.repository.pending(tenantId)) {
      await deps.appendEvidence(evidence);
      await deps.repository.delivered(tenantId, evidence.document.id);
    }
  }

  return {
    /** Reads a tenant policy decision after refreshing membership. */
    async decision(context: TenantContext, id: string) {
      const fresh = await deps.refreshContext(context);
      requireTenant(fresh, context.tenantId);
      requireRole(fresh, ['owner', 'admin', 'member']);
      if (fresh.actor.id !== context.actor.id)
        throw new IdentityError(403, 'FORBIDDEN', 'Sign in again to continue.');

      return deps.repository.findDecision(context.tenantId, id);
    },
    /** Reads the effective policy version for a fresh admission check. */
    currentVersion: version,
    async evaluate(
      context: TenantContext,
      action: ProposedAction,
      actionHash: string,
      capability: { available: boolean; minimumRisk: ProposedAction['risk'] },
    ) {
      return measure('policy.evaluate', async () => {
        requireTenant(context, action.tenantId);
        const fresh = await deps.refreshContext(context);
        requireTenant(fresh, action.tenantId);
        if (fresh.actor.id !== context.actor.id)
          throw new Error('Actor changed');
        const workspace = await deps.repository.workspacePolicy(
          context.tenantId,
        );
        const policyVersion = workspacePolicyVersion(workspace.revision);
        const now = deps.now();
        const approval = await deps.repository.findApproval(
          context.tenantId,
          action.id,
          actionHash,
          policyVersion,
        );
        const { outcome, reason } = evaluatePolicy(
          action,
          capability,
          fresh.actor.role,
          fresh.actor.id,
          now.getTime(),
          approval,
          workspace.required,
        );
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
      });
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
      const policyVersion = await version(context.tenantId);
      const decision = await deps.repository.findDecision(
        context.tenantId,
        decisionId,
      );
      if (!decision || decision.outcome !== 'approval_required')
        throw new IdentityError(
          404,
          'NOT_FOUND',
          'Approval decision not found.',
        );
      if (decision.policyVersion !== policyVersion)
        throw new IdentityError(
          409,
          'CONFLICT',
          'Approval policy changed. Refresh the review.',
        );
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

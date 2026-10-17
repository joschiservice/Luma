import type { TenantContext } from '@luma/identity';
import {
  isAppPermission,
  requireChangesAllowed,
  requirePermission,
  requireTenant,
} from '@luma/identity';
import { conflict, forbidden, measure, notFound } from '@luma/platform';

import type {
  Approval,
  PolicyDecision,
  PolicyEvidence,
  ProposedAction,
} from '../domain/action.js';
import { workspacePolicyVersion } from '../domain/action.js';
import type { PolicyCapability } from '../domain/evaluate.js';
import { approvalRequirement, evaluatePolicy } from '../domain/evaluate.js';
import type { ScopedAutonomy } from './scoped-autonomy.js';

export interface PolicyRepository {
  /** Reads the current workspace approval requirement and its revision. */
  workspacePolicy(tenantId: string): Promise<{
    revision: number;
    autonomyRevision?: number;
    required: boolean;
    requireIndependentApproval: boolean;
  }>;
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
  /** Trusted incident-owner admission for explicitly opted-in stock protection, with persisted caps. */
  stockProtection?:
    | ((context: TenantContext, action: ProposedAction) => Promise<boolean>)
    | undefined;
  /** Trusted owner evidence for an unchanged later step covered by an existing approval. */
  coveredApproval?:
    | ((
        context: TenantContext,
        action: ProposedAction,
        policyVersion: string,
        permission: string,
      ) => Promise<Approval | null>)
    | undefined;

  autonomy?: Pick<ScopedAutonomy, 'evaluate'> | undefined;
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
  const version = async (tenantId: string) => {
    const workspace = await deps.repository.workspacePolicy(tenantId);

    return workspacePolicyVersion(
      workspace.revision,
      workspace.requireIndependentApproval,
      workspace.autonomyRevision,
    );
  };

  async function flush(tenantId: string) {
    for (const evidence of await deps.repository.pending(tenantId)) {
      await deps.appendEvidence(evidence);
      await deps.repository.delivered(tenantId, evidence.document.id);
    }
  }

  return {
    /** Reads a tenant policy decision and its recorded human response after refreshing membership. */
    async decision(context: TenantContext, id: string) {
      const fresh = await deps.refreshContext(context);
      requireTenant(fresh, context.tenantId);
      if (fresh.actor.id !== context.actor.id)
        throw forbidden('Sign in again to continue.');

      const decision = await deps.repository.findDecision(context.tenantId, id);
      if (!decision) return null;
      const approval = await deps.repository.findApproval(
        context.tenantId,
        decision.proposalId,
        decision.actionHash,
        decision.policyVersion,
      );

      const workspace = await deps.repository.workspacePolicy(context.tenantId);

      return {
        ...decision,
        approval,
        requireIndependentApproval: workspace.requireIndependentApproval,
      };
    },
    /** Reads the effective policy version for a fresh admission check. */
    currentVersion: version,
    /** Reads whether a different person must approve under the effective workspace rule. */
    async requiresIndependentApproval(tenantId: string) {
      return (await deps.repository.workspacePolicy(tenantId))
        .requireIndependentApproval;
    },
    /**
     * States whether every proposal for an action needs a person under the current workspace
     * policy. It reads policy only; admission still evaluates each proposal.
     */
    async approvalRequirement(
      tenantId: string,
      action: {
        minimumRisk: ProposedAction['risk'];
        workflowRequired?: boolean;
      },
    ) {
      const workspace = await deps.repository.workspacePolicy(tenantId);

      return approvalRequirement({
        ...action,
        workspaceRequired: workspace.required,
      });
    },
    /**
     * Records a policy decision for an action against the actor's current permissions. Callers
     * state the permission the step needs; see `PolicyCapability`.
     */
    async evaluate(
      context: TenantContext,
      action: ProposedAction,
      actionHash: string,
      capability: PolicyCapability,
    ) {
      return measure('policy.evaluate', async () => {
        requireTenant(context, action.tenantId);
        requireChangesAllowed(context);
        const fresh = await deps.refreshContext(context);
        requireTenant(fresh, action.tenantId);
        if (fresh.actor.id !== context.actor.id)
          throw new Error('Actor changed');
        const workspace = await deps.repository.workspacePolicy(
          context.tenantId,
        );
        const policyVersion = workspacePolicyVersion(
          workspace.revision,
          workspace.requireIndependentApproval,
          workspace.autonomyRevision,
        );
        const now = deps.now();
        const approval = await deps.repository.findApproval(
          context.tenantId,
          action.id,
          actionHash,
          policyVersion,
        );
        const scoped = await deps.autonomy?.evaluate(
          fresh,
          action,
          capability.minimumRisk,
        );
        const preauthorized =
          action.capability === 'inventory.available.protect' &&
          (await deps.stockProtection?.(fresh, action)) === true;
        const baseline = evaluatePolicy(
          action,
          action.capability === 'inventory.available.protect' && !preauthorized
            ? { ...capability, available: false }
            : capability,
          fresh.permissions,
          fresh.actor.id,
          now.getTime(),
          approval,
          workspace.required || scoped?.outcome === 'approval_required',
          workspace.requireIndependentApproval,
          preauthorized,
        );
        const candidate =
          baseline.outcome === 'approval_required' &&
          !approval &&
          scoped?.outcome !== 'approval_required'
            ? await deps.coveredApproval?.(
                fresh,
                action,
                policyVersion,
                capability.permission,
              )
            : null;
        const covered =
          candidate &&
          candidate.outcome === 'approved' &&
          candidate.tenantId === fresh.tenantId &&
          candidate.policyVersion === policyVersion &&
          candidate.requesterId === fresh.actor.id &&
          Date.parse(candidate.expiresAt) > now.getTime() &&
          (!workspace.requireIndependentApproval ||
            candidate.approverId !== fresh.actor.id)
            ? candidate
            : null;
        const evaluated = covered
          ? { outcome: 'allowed' as const, reason: 'covered_approval' as const }
          : baseline;
        const { outcome, reason } =
          evaluated.outcome !== 'denied' && scoped?.outcome === 'denied'
            ? { outcome: 'denied' as const, reason: 'scoped_autonomy' as const }
            : evaluated;
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
          ...(scoped?.admission ? { autonomy: scoped.admission } : {}),
          ...(scoped?.reason ? { autonomyBlock: scoped.reason } : {}),
          permission: capability.permission,
          ...(covered ? { approvalId: covered.id } : {}),
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
              ...(covered ? [Date.parse(covered.expiresAt)] : []),
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
      requireChangesAllowed(context);
      const fresh = await deps.refreshContext(context);
      requireTenant(fresh, context.tenantId);
      requirePermission(fresh, 'decisions.respond');
      const workspace = await deps.repository.workspacePolicy(context.tenantId);
      const policyVersion = workspacePolicyVersion(
        workspace.revision,
        workspace.requireIndependentApproval,
        workspace.autonomyRevision,
      );
      const decision = await deps.repository.findDecision(
        context.tenantId,
        decisionId,
      );
      if (!decision || decision.outcome !== 'approval_required')
        throw notFound('Approval decision not found.');
      if (decision.policyVersion !== policyVersion)
        throw conflict('Approval policy changed. Refresh the review.');
      if (
        workspace.requireIndependentApproval &&
        fresh.actor.id === decision.actorId
      )
        throw forbidden('A different approver is required.');
      // Capabilities with their own app permission need it to approve, too.
      if (decision.permission && isAppPermission(decision.permission))
        requirePermission(fresh, decision.permission);
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

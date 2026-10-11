import type { Diagnosis, Incident } from '@luma/exceptions';
import type { ExecutionRecord } from '@luma/execution';
import type { Permission, TenantContext } from '@luma/identity';
import {
  hasPermission,
  IdentityError,
  requirePermission,
  requireTenant,
} from '@luma/identity';
import type { Approval, PolicyDecision, ProposedAction } from '@luma/policies';
import { currentPolicyVersion } from '@luma/policies';

import type { ActivityActor } from '../domain/activity.js';
import { approvalBlocksRenewal } from '../domain/proposal-renewal.js';
import type { WorkflowProgress, WorkflowSource } from './runtime.js';

export interface BoundProposal {
  action: ProposedAction;
  actionHash: string;
  version: number;
  diagnosisRevision: number;
}

export interface DeskSnapshot {
  observeOnly?: boolean;
  policyStale?: boolean;
  effectivePolicyVersion?: string;
  incident: Incident;
  revision: number;
  diagnosis: Diagnosis | null;
  proposal: BoundProposal | null;
  decision: PolicyDecision | null;
  approval: Approval | null;
  execution: ExecutionRecord | null;
}

export interface CaseDecision {
  commandId: string;
  kind: 'approve' | 'reject' | 'escalate';
  caseRevision: number;
  diagnosisRevision: number;
  proposalId?: string | undefined;
  proposalVersion?: number | undefined;
  decisionId?: string | undefined;
  reason: string;
}

export interface DecisionReceipt {
  id: string;
  exceptionId: string;
  kind: CaseDecision['kind'];
  actorId: string;
  caseRevision: number;
  approvalId: string | null;
  reason: string;
  createdAt: string;
}

export interface TimelineEvent {
  id: string;
  type: string;
  occurredAt: string;
  actor: ActivityActor;
  proposalId: string | null;
  outcome: string | null;
  evidenceRefs: string[];
}

export interface DeskSession {
  snapshot: DeskSnapshot;
  receipt(
    id: string,
  ): Promise<{ request: CaseDecision; receipt: DecisionReceipt } | null>;
  respond(
    context: TenantContext,
    decisionId: string,
    outcome: 'approved' | 'rejected',
    expiresAt: string,
  ): Promise<Approval>;
  save(request: CaseDecision, receipt: DecisionReceipt): Promise<void>;
  escalate(): Promise<number>;
  /** Names the people behind recorded user IDs; see {@link ActivityActor}. */
  people(ids: readonly (string | null | undefined)[]): Promise<ActivityActor[]>;
}

export interface DeskStore {
  /** Serializes source refresh and execution against decisions for this case across API and worker processes. */
  withRefresh<T>(
    context: TenantContext,
    id: string,
    operation: (snapshot: DeskSnapshot) => Promise<T>,
  ): Promise<T>;
  bindWorkflow(
    context: TenantContext,
    id: string,
    source: WorkflowSource,
  ): Promise<void>;
  workflowSource(
    context: TenantContext,
    id: string,
  ): Promise<WorkflowSource | null>;
  withCase<T>(
    context: TenantContext,
    id: string,
    write: boolean,
    operation: (session: DeskSession) => Promise<T>,
  ): Promise<T>;
  publish(
    context: TenantContext,
    id: string,
    revision: number,
    action: ProposedAction,
  ): Promise<BoundProposal>;
  proposal(
    context: TenantContext,
    id: string,
  ): Promise<{
    exceptionId: string;
    revision: number;
    action: ProposedAction;
  } | null>;
  timeline(
    context: TenantContext,
    id: string,
    query: { limit: number; cursor?: string | undefined },
  ): Promise<{ items: TimelineEvent[]; nextCursor: string | null }>;
}

export interface DeskDependencies {
  store: DeskStore;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  capability(action: ProposedAction): boolean;
  checkCapability(
    context: TenantContext,
    action: ProposedAction,
  ): Promise<boolean>;
  workflow?(
    context: TenantContext,
    id: string,
    source: WorkflowSource | null,
  ): Promise<WorkflowProgress | null>;
  /** Read current source facts and publish a new immutable proposal; never carry approvals forward. */
  refreshProposal?(context: TenantContext, id: string): Promise<void>;
  /** Wake the workflow after a durable decision; polling recovers a failed notification. */
  notifyDecision?(context: TenantContext, id: string): Promise<void>;
  now(): Date;
}

/** Approving or rejecting answers the policy decision; escalating changes the case lifecycle. */
const decisionPermission = {
  approve: 'decisions.respond',
  reject: 'decisions.respond',
  escalate: 'issues.manage',
} as const satisfies Record<CaseDecision['kind'], Permission>;

function conflict(
  message = 'The case changed. Refresh before deciding.',
): never {
  throw new IdentityError(409, 'CONFLICT', message);
}

/**
 * Creates proposal review and version-bound operator decisions with refreshed authorization
 * and capability checks.
 */
export function createDeskService(deps: DeskDependencies) {
  async function fresh(context: TenantContext) {
    const next = await deps.refreshContext(context);
    requireTenant(next, context.tenantId);
    if (next.actor.id !== context.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Actor changed');

    return next;
  }

  function permitted(context: TenantContext, s: DeskSnapshot) {
    const decisions: CaseDecision['kind'][] = [];
    if (
      s.incident.state === 'resolved' ||
      s.incident.state === 'escalated' ||
      s.execution
    )
      return decisions;
    if (hasPermission(context, decisionPermission.escalate))
      decisions.push('escalate');
    const p = s.proposal,
      d = s.decision;
    if (
      hasPermission(context, decisionPermission.reject) &&
      p &&
      d &&
      !s.approval &&
      s.diagnosis?.status === 'ready' &&
      p.diagnosisRevision === s.diagnosis.revision &&
      d.proposalId === p.action.id &&
      d.actionHash === p.actionHash &&
      d.outcome === 'approval_required' &&
      d.policyVersion === (s.effectivePolicyVersion ?? currentPolicyVersion) &&
      d.actorId !== context.actor.id &&
      Date.parse(p.action.expiresAt) > deps.now().getTime() &&
      Date.parse(p.action.preconditions.validUntil) > deps.now().getTime() &&
      (s.diagnosis.provenance.validUntil === null ||
        Date.parse(s.diagnosis.provenance.validUntil) > deps.now().getTime())
    ) {
      decisions.push('reject');
      if (!s.observeOnly && deps.capability(p.action))
        decisions.push('approve');
    }

    return decisions;
  }

  const refreshing = new Map<string, Promise<void>>();

  return {
    /** Holds the case renewal lock through proposal selection and execution admission. */
    async withExecution<T>(
      context: TenantContext,
      id: string,
      operation: () => Promise<T>,
    ) {
      context = await fresh(context);
      requirePermission(context, 'actions.execute');

      return deps.store.withRefresh(context, id, operation);
    },
    async refresh(context: TenantContext, id: string) {
      context = await fresh(context);
      requirePermission(context, 'actions.propose');
      if (!deps.refreshProposal)
        throw new IdentityError(
          409,
          'CONFLICT',
          'This case requires a new investigation before approval.',
        );
      const key = `${context.tenantId}:${id}`;
      let pending = refreshing.get(key);
      if (!pending) {
        pending = deps.store
          .withRefresh(context, id, async (s) => {
            if (
              approvalBlocksRenewal(s.approval, deps.now().getTime()) ||
              s.execution ||
              ['resolved', 'escalated'].includes(s.incident.state)
            )
              return;
            context = await fresh(context);
            requirePermission(context, 'actions.propose');
            await deps.refreshProposal!(context, id);
          })
          .finally(() => refreshing.delete(key));
        refreshing.set(key, pending);
      }
      await pending;
    },
    async bindWorkflow(
      context: TenantContext,
      id: string,
      source: WorkflowSource,
    ) {
      return deps.store.bindWorkflow(await fresh(context), id, source);
    },
    async publish(
      context: TenantContext,
      id: string,
      revision: number,
      action: ProposedAction,
    ) {
      return deps.store.publish(await fresh(context), id, revision, action);
    },
    async proposal(context: TenantContext, id: string) {
      return deps.store.proposal(await fresh(context), id);
    },
    async review(context: TenantContext, id: string) {
      context = await fresh(context);
      requirePermission(context, 'issues.read');

      return deps.store.withCase(
        context,
        id,
        false,
        async ({ snapshot: s, people }) => ({
          schemaVersion: 1 as const,
          people: await people([
            s.proposal?.action.proposedBy.kind === 'user'
              ? s.proposal.action.proposedBy.id
              : null,
            s.approval?.approverId,
          ]),
          observeOnly: s.observeOnly ?? false,
          policyStale: s.policyStale ?? false,
          refreshable:
            hasPermission(context, 'actions.propose') &&
            Boolean(deps.refreshProposal) &&
            !approvalBlocksRenewal(s.approval, deps.now().getTime()) &&
            !s.execution &&
            !['resolved', 'escalated'].includes(s.incident.state),
          caseRevision: s.revision,
          diagnosisRevision: s.diagnosis?.revision ?? 0,
          permittedDecisions: permitted(context, s),
          proposal: s.proposal
            ? {
                id: s.proposal.action.id,
                version: s.proposal.version,
                diagnosisRevision: s.proposal.diagnosisRevision,
                capability: s.proposal.action.capability,
                capabilityVersion: s.proposal.action.capabilityVersion,
                available: deps.capability(s.proposal.action),
                connectionId: s.proposal.action.connectionId,
                target: s.proposal.action.target,
                parameters: s.proposal.action.parameters,
                expectedPostcondition: s.proposal.action.expectedPostcondition,
                preconditions: s.proposal.action.preconditions,
                risk: s.proposal.action.risk,
                expiresAt: s.proposal.action.expiresAt,
                requestedBy: s.proposal.action.proposedBy.id,
                policy: s.decision
                  ? {
                      id: s.decision.id,
                      policyVersion: s.decision.policyVersion,
                      outcome: s.decision.outcome,
                      reason: s.decision.reason,
                      evaluatedAt: s.decision.evaluatedAt,
                      validUntil: s.decision.validUntil,
                    }
                  : null,
                approval: s.approval
                  ? {
                      id: s.approval.id,
                      outcome: s.approval.outcome,
                      actorId: s.approval.approverId,
                      createdAt: s.approval.createdAt,
                    }
                  : null,
              }
            : null,
        }),
      );
    },
    async decide(context: TenantContext, id: string, request: CaseDecision) {
      context = await fresh(context);
      requirePermission(context, decisionPermission[request.kind]);

      const receipt = await deps.store.withCase(
        context,
        id,
        true,
        async (session) => {
          context = await fresh(context);
          requirePermission(context, decisionPermission[request.kind]);
          const previous = await session.receipt(request.commandId);
          if (previous) {
            if (
              previous.receipt.actorId !== context.actor.id ||
              previous.receipt.exceptionId !== id ||
              JSON.stringify(Object.entries(previous.request).sort()) !==
                JSON.stringify(
                  Object.entries(request)
                    .filter(([, value]) => value !== undefined)
                    .sort(),
                )
            )
              conflict(
                'This command ID was already used for a different decision.',
              );

            return previous.receipt;
          }
          const s = session.snapshot;
          if (
            s.revision !== request.caseRevision ||
            (s.diagnosis?.revision ?? 0) !== request.diagnosisRevision
          )
            conflict();
          if (!permitted(context, s).includes(request.kind))
            conflict('This decision is no longer permitted.');
          let approvalId: string | null = null;
          let revision = s.revision;
          if (request.kind === 'escalate') revision = await session.escalate();
          else {
            const p = s.proposal!;
            if (
              request.proposalId !== p.action.id ||
              request.proposalVersion !== p.version ||
              request.decisionId !== s.decision?.id
            )
              conflict();
            if (
              request.kind === 'approve' &&
              !(await deps.checkCapability(context, p.action))
            )
              conflict('The capability or its preconditions are unavailable.');
            const expiry = new Date(
              Math.min(
                Date.parse(p.action.expiresAt),
                Date.parse(p.action.preconditions.validUntil),
                s.diagnosis!.provenance.validUntil === null
                  ? Infinity
                  : Date.parse(s.diagnosis!.provenance.validUntil),
                deps.now().getTime() + 86_400_000,
              ),
            ).toISOString();
            const approval = await session.respond(
              context,
              request.decisionId!,
              request.kind === 'approve' ? 'approved' : 'rejected',
              expiry,
            );
            if (
              approval.outcome !==
              (request.kind === 'approve' ? 'approved' : 'rejected')
            )
              conflict('A conflicting response already exists.');
            approvalId = approval.id;
          }
          const receipt: DecisionReceipt = {
            id: request.commandId,
            exceptionId: id,
            kind: request.kind,
            actorId: context.actor.id,
            caseRevision: revision,
            approvalId,
            reason: request.reason,
            createdAt: deps.now().toISOString(),
          };
          await session.save(request, receipt);

          return receipt;
        },
      );
      await deps.notifyDecision?.(context, id).catch(() => {
        // The decision is committed; the workflow also polls for lost notifications.
      });

      return receipt;
    },
    async receipt(context: TenantContext, id: string, commandId: string) {
      context = await fresh(context);
      requirePermission(context, 'issues.read');

      return deps.store.withCase(context, id, false, async (session) => {
        const value = await session.receipt(commandId);
        if (
          !value ||
          value.receipt.exceptionId !== id ||
          value.receipt.actorId !== context.actor.id
        )
          throw new IdentityError(404, 'NOT_FOUND', 'Decision not found');

        return value.receipt;
      });
    },
    async progress(context: TenantContext, id: string) {
      context = await fresh(context);
      requirePermission(context, 'issues.read');
      const snapshot = await deps.store.withCase(
        context,
        id,
        false,
        async ({ snapshot: s, people }) => {
          const e = s.execution;

          return {
            schemaVersion: 1 as const,
            people: await people([
              e?.attempt.requestedBy,
              s.incident.resolution?.actorId,
            ]),
            caseRevision: s.revision,
            state: s.incident.state,
            diagnosisRevision: s.diagnosis?.revision ?? 0,
            execution: e
              ? {
                  id: e.id,
                  proposalId: e.proposalId,
                  state: e.state,
                  attemptId: e.attempt.id,
                  attempt: e.attempt.number,
                  requestedBy: e.attempt.requestedBy,
                  executor: {
                    kind: e.attempt.executor.kind,
                    id: e.attempt.executor.id,
                  },
                  startedAt: e.attempt.startedAt,
                  finishedAt: e.attempt.finishedAt ?? null,
                  effectEvidenceRefs: e.attempt.effectEvidenceRefs ?? [],
                  verification: e.attempt.verification ?? null,
                }
              : null,
            resolution: s.incident.resolution
              ? {
                  kind: s.incident.resolution.kind,
                  at: s.incident.resolution.at,
                  actorId: s.incident.resolution.actorId,
                  evidenceRefs: s.incident.resolution.evidenceRefs.slice(
                    0,
                    100,
                  ),
                }
              : null,
          };
        },
      );
      let availability: 'available' | 'not_started' | 'unavailable' =
        'unavailable';
      let workflow: WorkflowProgress | null = null;
      if (deps.workflow) {
        try {
          workflow = await deps.workflow(
            context,
            id,
            await deps.store.workflowSource(context, id),
          );
          if (workflow?.exceptionId && workflow.exceptionId !== id)
            throw new Error('Workflow case mismatch');
          availability = workflow ? 'available' : 'not_started';
        } catch {
          workflow = null;
          /* Persisted state remains readable when the workflow service is unavailable. */
        }
      }

      return { ...snapshot, workflow: { availability, progress: workflow } };
    },
    async timeline(
      context: TenantContext,
      id: string,
      query: { limit: number; cursor?: string | undefined },
    ) {
      context = await fresh(context);
      requirePermission(context, 'issues.read');

      return deps.store.timeline(context, id, query);
    },
  };
}

export type DeskService = ReturnType<typeof createDeskService>;

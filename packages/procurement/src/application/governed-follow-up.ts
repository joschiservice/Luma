import type { TenantContext } from '@luma/identity';
import {
  requireChangesAllowed,
  requirePermission,
  requireTenant,
} from '@luma/identity';
import { conflict, forbidden, notFound } from '@luma/platform';
import type { ProcessActionResult } from '@luma/workflows';

/** Immutable internal-note intent. Successors keep the same receipt ID and original workflow provenance. */
export interface FollowUpPlan {
  id: string;
  tenantId: string;
  workflowRunId: string;
  executionRunId: string;
  stepId: string;
  orderRevision: number;
  orderScopeFingerprint: string;
  followUpId: string;
  orderId: string;
  key: string;
  nextCheckAt: string;
  observedAt: string;
  expiresAt: string;
  requestedBy: string;
  createdAt: string;
  previousProposalId: string | null;
}

export interface FollowUpRequest {
  orderRevision: number;
  orderScopeFingerprint: string;
  runId: string;
  stepId: string;
  actionId: string;
  orderId: string;
  key: string;
  nextCheckAt: string;
  observedAt: string;
}

/** Storage serializes renewal with execution reservation and never replaces immutable intent. */
export interface FollowUpPlanStore {
  head(
    context: TenantContext,
    workflowRunId: string,
  ): Promise<FollowUpPlan | null>;
  get(context: TenantContext, id: string): Promise<FollowUpPlan | null>;
  create(context: TenantContext, plan: FollowUpPlan): Promise<FollowUpPlan>;
  renew(
    context: TenantContext,
    previous: FollowUpPlan,
    next: FollowUpPlan,
    commandId: string,
  ): Promise<FollowUpPlan>;
  pending(context: TenantContext): Promise<FollowUpPlan[]>;
}

/** Trusted bridge to policy and Action Admission; the domain never receives external effect handlers. */
export interface FollowUpPlanAdmission {
  verify(context: TenantContext, plan: FollowUpPlan): Promise<boolean>;
  refreshability(
    context: TenantContext,
    plan: FollowUpPlan,
  ): Promise<{
    refreshable: boolean;
    refreshBlock: 'workflow_inactive' | 'release_unavailable' | null;
  }>;
  /** Independently reads a reserved or uncertain attempt; never dispatches a new note. */
  reconcile(context: TenantContext, plan: FollowUpPlan): Promise<void>;
  prepare(
    context: TenantContext,
    plan: FollowUpPlan,
    reviewOnly: boolean,
  ): Promise<void>;
  execute(
    context: TenantContext,
    plan: FollowUpPlan,
  ): Promise<ProcessActionResult>;
  respond(
    context: TenantContext,
    plan: FollowUpPlan,
    decisionId: string,
    outcome: 'approved' | 'rejected',
  ): Promise<void>;
  review(
    context: TenantContext,
    plan: FollowUpPlan,
  ): Promise<{
    decisionId: string | null;
    outcome: 'allowed' | 'denied' | 'approval_required' | null;
    stale: boolean;
    reason: string | null;
    refreshable: boolean;
    refreshBlock: 'workflow_inactive' | 'release_unavailable' | null;
  }>;
}

/** Creates governed internal follow-ups and explicit stale recovery; released runs never revert to direct writes. */
export function createGovernedFollowUps(deps: {
  store: FollowUpPlanStore;
  admission: FollowUpPlanAdmission;
  managed(tenantId: string): Promise<boolean>;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  current(
    context: TenantContext,
    orderId: string,
  ): Promise<{
    orderRevision: number;
    orderScopeFingerprint: string;
    key: string;
    observedAt: string;
    nextCheckAt: string;
  } | null>;
  now(): Date;
  id(): string;
}) {
  async function authorize(context: TenantContext, respond = false) {
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    requireChangesAllowed(fresh);
    if (fresh.actor.id !== context.actor.id)
      throw forbidden('Sign in again to continue.');
    requirePermission(fresh, 'procurement.manage');
    if (respond) requirePermission(fresh, 'decisions.respond');

    return fresh;
  }

  const expires = (observedAt: string) =>
    new Date(Date.parse(observedAt) + 300000).toISOString();

  return {
    /** Returns null only for never-enrolled legacy work; a saved governed run remains governed after flag rollback. */
    async record(
      context: TenantContext,
      request: FollowUpRequest,
    ): Promise<ProcessActionResult | null> {
      const prior = await deps.store.head(context, request.runId);
      if (!prior && !(await deps.managed(context.tenantId))) return null;
      context = await authorize(context);
      if (!prior) {
        const current = await deps.current(context, request.orderId);
        if (
          !current ||
          current.key !== request.key ||
          current.orderRevision !== request.orderRevision ||
          current.orderScopeFingerprint !== request.orderScopeFingerprint
        )
          return {
            state: 'denied',
            proposalId: request.actionId,
            reason:
              'The order changed before proposal preparation. Read it again.',
          };
      }
      const candidate: FollowUpPlan = prior ?? {
        id: request.actionId,
        tenantId: context.tenantId,
        workflowRunId: request.runId,
        executionRunId: request.runId,
        stepId: request.stepId,
        followUpId: request.actionId,
        orderId: request.orderId,
        orderRevision: request.orderRevision,
        orderScopeFingerprint: request.orderScopeFingerprint,
        key: request.key,
        nextCheckAt: request.nextCheckAt,
        observedAt: request.observedAt,
        expiresAt: expires(request.observedAt),
        requestedBy: context.actor.id,
        createdAt: deps.now().toISOString(),
        previousProposalId: null,
      };
      const readiness = await deps.admission.refreshability(context, candidate);
      if (!readiness.refreshable)
        return {
          state: 'denied',
          proposalId: candidate.id,
          reason: readiness.refreshBlock ?? 'blocked',
        };
      const plan = prior ?? (await deps.store.create(context, candidate));
      await deps.admission.prepare(context, plan, false);

      return deps.admission.execute(context, plan);
    },
    /** Lists immutable proposals with their real policy decision, including stale and blocked work. */
    async pending(context: TenantContext) {
      context = await authorize(context);

      return Promise.all(
        (await deps.store.pending(context)).map(async (plan) => ({
          ...plan,
          review: await deps.admission.review(context, plan),
        })),
      );
    },
    /** Responds to exactly the reviewed decision; no amount, source fact or grant comes from the request. */
    async respond(
      context: TenantContext,
      proposalId: string,
      decisionId: string,
      outcome: 'approved' | 'rejected',
    ) {
      context = await authorize(context, true);
      const plan = await deps.store.get(context, proposalId);
      if (!plan) throw notFound('Follow-up proposal not found.');
      await deps.admission.respond(context, plan, decisionId, outcome);

      return { proposalId, outcome };
    },
    /** Rereads the exact immutable governed note; null leaves never-enrolled legacy verification unchanged. */
    async verified(
      context: TenantContext,
      workflowRunId: string,
    ): Promise<boolean | null> {
      context = await authorize(context);
      const plan = await deps.store.head(context, workflowRunId);

      return plan ? deps.admission.verify(context, plan) : null;
    },
    /** Independently reconciles an existing attempt even while new scoped work is paused. */
    async reconcile(context: TenantContext, proposalId: string) {
      context = await authorize(context);
      const plan = await deps.store.get(context, proposalId);
      if (!plan) throw notFound('Follow-up proposal not found.');
      await deps.admission.reconcile(context, plan);

      return { proposalId };
    },
    /** Rereads and binds a successor before review; uncertain/reserved writes cannot be renewed. */
    async refresh(
      context: TenantContext,
      proposalId: string,
      commandId: string,
    ) {
      context = await authorize(context);
      const previous = await deps.store.get(context, proposalId);
      if (!previous) throw notFound('Follow-up proposal not found.');
      if (previous.requestedBy !== context.actor.id)
        throw forbidden('The workflow requester must refresh this proposal.');
      const eligibility = await deps.admission.refreshability(
        context,
        previous,
      );
      if (!eligibility.refreshable)
        throw conflict(
          eligibility.refreshBlock === 'workflow_inactive'
            ? 'The original workflow is inactive or finished. Review and start the current workflow; this proposal cannot be renewed.'
            : 'New scoped work is unavailable. Existing attempts can still be independently verified.',
        );
      const current = await deps.current(context, previous.orderId);
      if (!current) throw conflict('The order no longer needs this follow-up.');
      const id = deps.id();
      const next = await deps.store.renew(
        context,
        previous,
        {
          ...previous,
          id,
          executionRunId: id,
          orderRevision: current.orderRevision,
          orderScopeFingerprint: current.orderScopeFingerprint,
          key: current.key,
          nextCheckAt: current.nextCheckAt,
          observedAt: current.observedAt,
          expiresAt: expires(current.observedAt),
          createdAt: deps.now().toISOString(),
          requestedBy: context.actor.id,
          previousProposalId: previous.id,
        },
        commandId,
      );
      await deps.admission.prepare(context, next, true);

      return {
        previous,
        proposal: next,
        review: await deps.admission.review(context, next),
        approvalRetained: false as const,
      };
    },
  };
}

export type GovernedFollowUps = ReturnType<typeof createGovernedFollowUps>;

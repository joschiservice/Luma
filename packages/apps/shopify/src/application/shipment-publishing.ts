import type { EffectRegistry, InstallationCapability } from '@luma/connections';
import type {
  ActionAdmission,
  BoundActionStep,
  ExecutionResult,
} from '@luma/execution';
import type { TenantContext } from '@luma/identity';
import { hasPermission, IdentityError, requireTenant } from '@luma/identity';
import type { PolicyService, ProposedAction } from '@luma/policies';
import { z } from 'zod';

import {
  dispatchReference,
  publishingBlocker,
  type PublishingChoice,
  publishingPreviewInput,
  type PublishingSnapshot,
  publishingTarget,
  publishingVerified,
  type PublishingView,
} from '../domain/shipment-publishing.js';

export interface PublishingRun {
  id: string;
  tenantId: string;
  target: z.infer<typeof publishingTarget>;
  choice: PublishingChoice;
  before: PublishingSnapshot;
  action: ProposedAction;
  decisionId: string | null;
}

export interface PublishingStore {
  /** Inserts an immutable preview; returns an identical retry or rejects conflicting pending publishing. */
  save(context: TenantContext, run: PublishingRun): Promise<PublishingRun>;
  /** Reserves one logical publishing per source revision; repeated calls for the same run are safe. */
  claim(context: TenantContext, run: PublishingRun): Promise<void>;
  /** Releases the target lock after a durable acceptance or a confirmed withheld write. */
  settle(context: TenantContext, id: string, withheld?: boolean): Promise<void>;
  /** True only after atomic reconciliation fenced an operation that never reached the provider send. */
  closed(context: TenantContext, id: string): Promise<boolean>;
  get(context: TenantContext, id: string): Promise<PublishingRun | null>;
  list(
    context: TenantContext,
    target: z.infer<typeof publishingTarget>,
  ): Promise<PublishingRun[]>;
  decision(
    context: TenantContext,
    id: string,
    decisionId: string,
  ): Promise<void>;
  /** Lists the tenant's unexpired previews and those dispatched in the last seven days, newest first, at most 50. */
  open(context: TenantContext): Promise<PublishingRun[]>;
}

export interface PublishingDependencies {
  store: PublishingStore;
  /** Release gates eligibility and dispatch; read-only reconciliation remains available while disabled. */
  enabled(context: TenantContext): Promise<boolean>;
  /**
   * The person's access to this app feature, checked by the app host with installation, the
   * app's permission and its scopes. Pass a refreshed context.
   */
  permission: {
    require(context: TenantContext): Promise<void>;
    allowed(context: TenantContext): Promise<boolean>;
  };
  admission: ActionAdmission;
  policies: PolicyService;
  effects: EffectRegistry;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  authorize(
    context: TenantContext,
    connectionId: string,
  ): Promise<InstallationCapability[]>;
  read(
    context: TenantContext,
    target: z.infer<typeof publishingTarget>,
    source: z.infer<typeof dispatchReference>,
  ): Promise<PublishingSnapshot>;
  bind(context: TenantContext, run: PublishingRun): Promise<void>;
  hash(action: ProposedAction): string;
  now(): Date;
  /** How long a person has to decide on a preview. Defaults to four hours. */
  decisionWindowMs?: number;
}

/** Offers source-bound previews and reference-only execution, preserving the shared approval and reconciliation controls. */
export function createShipmentPublishing(deps: PublishingDependencies) {
  async function authorize(context: TenantContext) {
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    await deps.permission.require(fresh);
    if (fresh.actor.id !== context.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Sign in again.');

    return fresh;
  }

  async function load(context: TenantContext, id: string) {
    const run = await deps.store.get(context, id);
    if (!run)
      throw new IdentityError(
        404,
        'NOT_FOUND',
        'Shipment publication not found.',
      );
    await deps.authorize(context, run.target.connectionId);

    return run;
  }

  async function view(
    context: TenantContext,
    run: PublishingRun,
    result?: ExecutionResult | null,
    // `null` evaluates persisted state only; the source is then not checked for changes.
    snapshot?: PublishingSnapshot | null,
  ): Promise<PublishingView> {
    const execution = result ?? (await deps.admission.get(context, run.id));
    const record = execution && 'record' in execution ? execution.record : null;
    const observeOnly =
      !record &&
      (execution?.state === 'not_executed' ||
        (await deps.admission.writeMode?.(context, run.target.connectionId)) ===
          'observe_only');
    const decision = run.decisionId
      ? await deps.policies.decision(context, run.decisionId)
      : null;
    const expired = deps.now().getTime() >= Date.parse(run.action.expiresAt);
    const accepted = !!record?.attempt.effectEvidenceRefs?.length;
    const withheld =
      record?.attempt.dispatch === 'not_dispatched' ||
      (await deps.store.closed(context, run.id));
    if (accepted || withheld || record?.state === 'succeeded')
      await deps.store.settle(context, run.id, withheld);
    const verified = record?.attempt.businessOutcome === 'satisfied';
    const current =
      !record && !expired && snapshot !== null
        ? (snapshot ??
          (await deps.read(context, run.target, run.choice.source)))
        : null;
    const changed =
      current !== null &&
      (!(await deps.enabled(context)) ||
        current.revision !== run.before.revision ||
        !!publishingBlocker(
          current,
          run.choice,
          await deps.authorize(context, run.target.connectionId),
        ));
    const policyChanged =
      decision !== null &&
      decision.policyVersion !==
        (await deps.policies.currentVersion(context.tenantId));
    const rejected = decision?.approval?.outcome === 'rejected';
    const state: PublishingView['state'] = verified
      ? 'verified'
      : withheld
        ? 'denied'
        : record
          ? accepted
            ? 'recovery_required'
            : 'uncertain'
          : policyChanged ||
              changed ||
              rejected ||
              expired ||
              decision?.outcome === 'denied'
            ? 'denied'
            : decision?.outcome === 'approval_required'
              ? 'approval_required'
              : 'preview';
    const message = withheld
      ? 'No change was accepted by Shopify. Refresh the fulfillment and review its eligibility before another publishing.'
      : verified
        ? 'Fresh Shopify evidence verifies the exact shipment allocation and tracking.'
        : record
          ? accepted
            ? 'Shopify accepted the action. Fulfillment progress is not yet verified. Check again or review the order in Shopify.'
            : 'The write outcome is uncertain. Check Shopify before attempting another publishing; Luma will not resend this action.'
          : policyChanged
            ? 'Approval policy changed. Refresh and review a new action.'
            : changed
              ? 'Shopify changed since this preview. Refresh and review a new action.'
              : expired
                ? 'This preview expired. Refresh fulfillment details and review a new action.'
                : rejected
                  ? 'A person with approval permission rejected this action.'
                  : decision?.outcome === 'denied'
                    ? 'This action is no longer eligible. Refresh fulfillment details.'
                    : state === 'approval_required'
                      ? decision?.approval?.outcome === 'approved'
                        ? 'Approved. The requester can run the action after a fresh eligibility check.'
                        : decision?.requireIndependentApproval === false
                          ? 'Review and approve this exact action before running it.'
                          : 'Someone else who can approve changes must approve this exact action.'
                      : 'Review the exact change. Shopify eligibility is checked again before dispatch.';

    return {
      observeOnly,
      id: run.id,
      target: run.target,
      choice: run.choice,
      before: run.before,
      requesterId: run.action.proposedBy.id,
      expiresAt: run.action.expiresAt,
      decisionId: run.decisionId,
      state,
      approved: decision?.approval?.outcome === 'approved',
      denial:
        state !== 'denied'
          ? null
          : withheld
            ? 'withheld'
            : rejected
              ? 'rejected'
              : policyChanged || decision?.outcome === 'denied'
                ? 'policy'
                : changed
                  ? 'changed'
                  : 'expired',
      acceptance: accepted
        ? 'accepted'
        : record && !withheld
          ? 'unknown'
          : 'not_sent',
      message,
      canExecute:
        !withheld &&
        !observeOnly &&
        !record &&
        !expired &&
        !changed &&
        !policyChanged &&
        !rejected &&
        decision?.outcome !== 'denied' &&
        context.actor.id === run.action.proposedBy.id &&
        (decision?.outcome !== 'approval_required' ||
          decision.approval?.outcome === 'approved'),
      canApprove:
        hasPermission(context, 'decisions.respond') &&
        !withheld &&
        !observeOnly &&
        !record &&
        !expired &&
        !changed &&
        !policyChanged &&
        state === 'approval_required' &&
        !decision?.approval &&
        context.actor.id !== run.action.proposedBy.id,
    };
  }

  return {
    /**
     * Reads a saved preview's current state, rereading Shopify while it can still run. Returns
     * null when the tenant has no preview with this ID. Changes nothing except releasing a
     * settled target lock.
     */
    async status(context: TenantContext, id: string) {
      context = await authorize(context);
      const run = await deps.store.get(context, id);
      if (!run) return null;
      await deps.authorize(context, run.target.connectionId);

      return view(context, run);
    },
    async inspect(context: TenantContext, input: unknown) {
      context = await authorize(context);
      const { source, ...target } = publishingTarget
        .extend({ source: dispatchReference })
        .strict()
        .parse(input);
      const granted = await deps.authorize(context, target.connectionId);
      const snapshot = await deps.read(context, target, source);
      const runs = await deps.store.list(context, target);

      return {
        snapshot,
        granted,
        runs: await Promise.all(
          runs.map((run) => view(context, run, undefined, snapshot)),
        ),
      };
    },
    async preview(context: TenantContext, input: unknown) {
      context = await authorize(context);
      const parsed = publishingPreviewInput.parse(input);
      const { requestId, choice, ...target } = parsed;
      const existing = await deps.store.get(context, requestId);
      if (existing) {
        if (
          JSON.stringify(existing.target) !== JSON.stringify(target) ||
          JSON.stringify(existing.choice) !== JSON.stringify(choice) ||
          existing.action.proposedBy.id !== context.actor.id
        )
          throw new IdentityError(
            409,
            'CONFLICT',
            'This request already belongs to another publishing.',
          );

        return view(context, await load(context, requestId));
      }
      const granted = await deps.authorize(context, target.connectionId);
      for (const previous of await deps.store.list(context, target)) {
        const execution = await deps.admission.get(context, previous.id);
        if (
          execution &&
          'record' in execution &&
          execution.record.attempt.dispatch !== 'not_dispatched' &&
          !execution.record.attempt.effectEvidenceRefs?.length &&
          execution.record.state !== 'succeeded' &&
          !(await deps.store.closed(context, previous.id))
        )
          throw new IdentityError(
            409,
            'CONFLICT',
            'A previous write is uncertain. Reconcile that publishing before starting another.',
          );
      }
      const before = await deps.read(context, target, choice.source);
      if (!(await deps.enabled(context)))
        throw new IdentityError(
          409,
          'CONFLICT',
          'Shipment publishing is not enabled for this workspace.',
        );
      const blocker = publishingBlocker(before, choice, granted);
      if (blocker) throw new IdentityError(409, 'CONFLICT', blocker);
      // People get a decision window; Shopify is reread and the revision checked before sending.
      const expiresAt = new Date(
        deps.now().getTime() + (deps.decisionWindowMs ?? 4 * 60 * 60_000),
      ).toISOString();
      const action: ProposedAction = {
        schemaVersion: 1,
        id: requestId,
        tenantId: context.tenantId,
        capability: choice.capability,
        capabilityVersion: '0',
        connectionId: target.connectionId,
        target: { kind: 'shopify_shipment_publication', id: requestId },
        parameters: {
          orderId: target.orderId,
          expectedRevision: before.revision,
          sourceConnectionId: choice.source.downstreamConnectionId,
          sourceShipmentId: choice.source.shipmentId,
          choice: JSON.stringify(choice),
          operationId: requestId,
        },
        preconditions: {
          evidenceRefs: [
            before.id,
            ...(before.dispatch
              ? [before.dispatch.id, before.dispatch.observationId]
              : []),
          ],
          validUntil: expiresAt,
        },
        expectedPostcondition: { shipmentPublished: true },
        risk: 'high',
        proposedBy: { kind: 'user', id: context.actor.id },
        expiresAt,
      };
      const run = await deps.store.save(context, {
        id: requestId,
        tenantId: context.tenantId,
        target,
        choice,
        before,
        action,
        decisionId: null,
      });
      await deps.bind(context, run);
      const effect = await deps.effects.resolve(context, action);
      const decision = await deps.policies.evaluate(
        context,
        action,
        deps.hash(action),
        {
          available: !!effect && (await effect.checkPreconditions(action)),
          minimumRisk: 'high',
          permission: effect?.permission ?? 'actions.propose',
        },
      );
      await deps.store.decision(context, run.id, decision.id);

      return view(context, { ...run, decisionId: decision.id });
    },
    async execute(context: TenantContext, input: unknown) {
      context = await authorize(context);
      const { id } = z.object({ id: z.string().uuid() }).strict().parse(input);
      const run = await load(context, id);
      if (context.actor.id !== run.action.proposedBy.id)
        throw new IdentityError(
          403,
          'FORBIDDEN',
          'Only the requester can run this action.',
        );
      const previous = await deps.admission.get(context, id);
      if (previous?.state === 'not_executed')
        return view(context, run, previous);
      if (!previous || !('record' in previous)) {
        const current = await view(context, run);
        if (!current.canExecute && !current.observeOnly)
          throw new IdentityError(
            409,
            'CONFLICT',
            'This action needs current approval before it can run.',
          );
        if (!current.observeOnly) await deps.store.claim(context, run);
      }
      await deps.bind(context, run);
      const result = await deps.admission.execute(context, {
        runId: id,
        stepId: 'publish',
      });
      if ('decision' in result) {
        await deps.store.decision(context, id, result.decision.id);
        run.decisionId = result.decision.id;
      }

      return view(context, run, result);
    },
    async approve(context: TenantContext, input: unknown) {
      context = await authorize(context);
      const { id, outcome } = z
        .object({
          id: z.string().uuid(),
          outcome: z.enum(['approved', 'rejected']),
        })
        .strict()
        .parse(input);
      const run = await load(context, id);
      if (!run.decisionId || !(await view(context, run)).canApprove)
        throw new IdentityError(
          409,
          'CONFLICT',
          'This action cannot be approved by you.',
        );
      await deps.policies.respond(
        context,
        run.decisionId,
        outcome,
        run.action.expiresAt,
      );

      return view(context, run);
    },
    async check(context: TenantContext, input: unknown) {
      context = await authorize(context);
      const { id } = z.object({ id: z.string().uuid() }).strict().parse(input);
      const run = await load(context, id);
      const previous = await deps.admission.get(context, id);

      if (!previous && deps.now().getTime() >= Date.parse(run.action.expiresAt))
        await deps.store.settle(context, id);

      return view(
        context,
        run,
        previous && 'record' in previous
          ? await deps.admission.reconcile(context, id)
          : previous,
      );
    },
    /**
     * Lists recoveries that wait on a person: an approval, a run by the requester, or a check of an
     * accepted or uncertain write. Reads persisted state only, so an approvable preview may still
     * prove stale when its review reads Shopify. People without the app permission get none.
     */
    async pending(context: TenantContext): Promise<PublishingView[]> {
      const fresh = await deps.refreshContext(context);
      requireTenant(fresh, context.tenantId);
      if (
        fresh.actor.id !== context.actor.id ||
        !(await deps.permission.allowed(fresh))
      )
        return [];
      const views = await Promise.all(
        (await deps.store.open(fresh)).map((run) =>
          view(fresh, run, undefined, null),
        ),
      );

      return views.filter(
        (item) =>
          item.observeOnly ||
          ['approval_required', 'uncertain', 'recovery_required'].includes(
            item.state,
          ) ||
          item.canExecute,
      );
    },
    /** Rejects stale, altered or unrelated admission steps before the shared engine reserves a write. */
    async eligible(context: TenantContext, step: BoundActionStep) {
      const run = await deps.store.get(context, step.runId);
      if (
        !run ||
        step.stepId !== 'publish' ||
        step.actionHash !== deps.hash(run.action) ||
        step.principalId !== run.action.proposedBy.id ||
        deps.now().getTime() >= Date.parse(run.action.expiresAt) ||
        (await deps.store.closed(context, run.id))
      )
        return false;
      const granted = await deps.authorize(context, run.target.connectionId);
      const current = await deps.read(context, run.target, run.choice.source);

      return (
        (await deps.enabled(context)) &&
        current.revision === run.before.revision &&
        !publishingBlocker(current, run.choice, granted)
      );
    },
  };
}

/** Evaluates business progress independently from a successful mutation receipt. */
export function verifyPublishing(
  run: PublishingRun,
  current: PublishingSnapshot,
) {
  return {
    outcome: publishingVerified(run.before, run.choice, current)
      ? ('passed' as const)
      : ('inconclusive' as const),
    observationRefs: [current.id],
    observedAt: current.observedAt,
    evaluatorVersion: 'shopify-shipment-publication/1',
  };
}

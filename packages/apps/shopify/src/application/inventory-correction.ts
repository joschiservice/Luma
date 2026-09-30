import type { EffectRegistry, InstallationCapability } from '@luma/connections';
import type {
  ActionAdmission,
  BoundActionStep,
  ExecutionResult,
} from '@luma/execution';
import type { TenantContext } from '@luma/identity';
import { IdentityError, requireRole, requireTenant } from '@luma/identity';
import type { PolicyService, ProposedAction } from '@luma/policies';
import { z } from 'zod';

import {
  correctionBlocker,
  type CorrectionCandidate,
  type CorrectionChoice,
  correctionPreviewInput,
  type CorrectionSnapshot,
  correctionTarget,
  type CorrectionView,
  inventoryReconciled,
} from '../domain/inventory-correction.js';

export interface CorrectionRun {
  id: string;
  tenantId: string;
  target: z.infer<typeof correctionTarget>;
  choice: CorrectionChoice;
  before: CorrectionSnapshot;
  action: ProposedAction;
  decisionId: string | null;
}

export interface CorrectionStore {
  /** Inserts an immutable preview; returns an identical retry or rejects conflicting pending correction. */
  save(context: TenantContext, run: CorrectionRun): Promise<CorrectionRun>;
  /** Reserves one logical correction per source revision; repeated calls for the same run are safe. */
  claim(context: TenantContext, run: CorrectionRun): Promise<void>;
  /** Releases the target lock after a durable acceptance or a confirmed withheld write. */
  settle(context: TenantContext, id: string): Promise<void>;
  /** Reads a saved preview within the tenant; returns null for unknown IDs. */
  get(context: TenantContext, id: string): Promise<CorrectionRun | null>;
  /** Lists recent previews for the target, prioritizing unresolved dispatches. */
  list(
    context: TenantContext,
    target: z.infer<typeof correctionTarget>,
  ): Promise<CorrectionRun[]>;
  /** Links the policy decision to a saved preview without changing its intent. */
  decision(
    context: TenantContext,
    id: string,
    decisionId: string,
  ): Promise<void>;
}

export interface CorrectionDependencies {
  store: CorrectionStore;
  /** Lists tenant-scoped ERP and Shopify sources for one canonical stock position. */
  candidates(
    context: TenantContext,
    positionId: string,
  ): Promise<CorrectionCandidate[]>;
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
    target: z.infer<typeof correctionTarget>,
  ): Promise<CorrectionSnapshot>;
  bind(context: TenantContext, run: CorrectionRun): Promise<void>;
  hash(action: ProposedAction): string;
  now(): Date;
}

/** Offers source-bound previews and reference-only execution, preserving the shared approval and reconciliation controls. */
export function createInventoryCorrection(deps: CorrectionDependencies) {
  async function authorize(context: TenantContext) {
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    requireRole(fresh, ['owner', 'admin']);
    if (fresh.actor.id !== context.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Sign in again.');

    return fresh;
  }

  async function load(context: TenantContext, id: string) {
    const run = await deps.store.get(context, id);
    if (!run)
      throw new IdentityError(404, 'NOT_FOUND', 'Correction not found.');
    await deps.authorize(context, run.target.connectionId);

    return run;
  }

  async function view(
    context: TenantContext,
    run: CorrectionRun,
    result?: ExecutionResult | null,
    snapshot?: CorrectionSnapshot,
  ): Promise<CorrectionView> {
    const execution = result ?? (await deps.admission.get(context, run.id));
    const record = execution && 'record' in execution ? execution.record : null;
    const decision = run.decisionId
      ? await deps.policies.decision(context, run.decisionId)
      : null;
    const expired = deps.now().getTime() >= Date.parse(run.action.expiresAt);
    const accepted = !!record?.attempt.effectEvidenceRefs?.length;
    const withheld = record?.attempt.dispatch === 'not_dispatched';
    if (accepted || withheld || record?.state === 'succeeded')
      await deps.store.settle(context, run.id);
    const verified = record?.attempt.businessOutcome === 'satisfied';
    const current =
      !record && !expired
        ? (snapshot ?? (await deps.read(context, run.target)))
        : null;
    const changed =
      current !== null &&
      (current.revision !== run.before.revision ||
        !!correctionBlocker(
          current,
          run.choice,
          await deps.authorize(context, run.target.connectionId),
          deps.now(),
        ));
    const policyChanged =
      decision !== null &&
      decision.policyVersion !==
        (await deps.policies.currentVersion(context.tenantId));
    const rejected = decision?.approval?.outcome === 'rejected';
    const state: CorrectionView['state'] = verified
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
      ? 'No change was accepted by Shopify. Refresh the inventory and review its eligibility before another correction.'
      : verified
        ? 'A fresh Shopify read matches the approved ERP quantity.'
        : record
          ? accepted
            ? 'Shopify accepted the correction. The quantity is not yet verified. Verify stock or review the inventory in Shopify.'
            : 'The write outcome is uncertain. Check Shopify before attempting another correction; Luma will not resend this action.'
          : policyChanged
            ? 'Approval policy changed. Refresh and review a new action.'
            : changed
              ? 'Stock evidence or mappings changed. Refresh and review a new correction.'
              : expired
                ? 'This preview expired. Refresh inventory details and review a new action.'
                : rejected
                  ? 'Another administrator rejected this action.'
                  : decision?.outcome === 'denied'
                    ? 'This action is no longer eligible. Refresh inventory details.'
                    : state === 'approval_required'
                      ? decision?.approval?.outcome === 'approved'
                        ? 'Approved. The requester can run the action after a fresh eligibility check.'
                        : 'A different administrator must approve this exact action.'
                      : 'Review the exact change. Shopify eligibility is checked again before dispatch.';

    return {
      id: run.id,
      target: run.target,
      choice: run.choice,
      before: run.before,
      requesterId: run.action.proposedBy.id,
      expiresAt: run.action.expiresAt,
      decisionId: run.decisionId,
      state,
      acceptance: accepted
        ? 'accepted'
        : record && !withheld
          ? 'unknown'
          : 'not_sent',
      message,
      canExecute:
        decision !== null &&
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
        !record &&
        !expired &&
        !changed &&
        !policyChanged &&
        state === 'approval_required' &&
        !decision?.approval &&
        context.actor.id !== run.action.proposedBy.id,
    };
  }

  async function prepare(context: TenantContext, run: CorrectionRun) {
    await deps.bind(context, run);
    const effect = await deps.effects.resolve(context, run.action);
    const decision = await deps.policies.evaluate(
      context,
      run.action,
      deps.hash(run.action),
      {
        available: !!effect && (await effect.checkPreconditions(run.action)),
        minimumRisk: 'medium',
      },
    );
    await deps.store.decision(context, run.id, decision.id);

    return view(context, { ...run, decisionId: decision.id });
  }

  return {
    async candidates(context: TenantContext, input: unknown) {
      context = await authorize(context);
      const { positionId } = z
        .object({ positionId: z.string().uuid() })
        .strict()
        .parse(input);

      return deps.candidates(context, positionId);
    },
    async inspect(context: TenantContext, input: unknown) {
      context = await authorize(context);
      const target = correctionTarget.parse(input);
      const granted = await deps.authorize(context, target.connectionId);
      const snapshot = await deps.read(context, target);
      const runs = await deps.store.list(context, target);

      return {
        snapshot,
        granted,
        runs: await Promise.all(
          runs.map((run) =>
            view(
              context,
              run,
              undefined,
              run.target.sourceConnectionId === target.sourceConnectionId
                ? snapshot
                : undefined,
            ),
          ),
        ),
      };
    },
    async preview(context: TenantContext, input: unknown) {
      context = await authorize(context);
      const parsed = correctionPreviewInput.parse(input);
      const { requestId, ...target } = parsed;
      const choice: CorrectionChoice = {
        capability: 'inventory.available.reconcile',
      };
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
            'This request already belongs to another correction.',
          );

        const run = await load(context, requestId);

        return run.decisionId ? view(context, run) : prepare(context, run);
      }
      const granted = await deps.authorize(context, target.connectionId);
      for (const previous of await deps.store.list(context, target)) {
        const execution = await deps.admission.get(context, previous.id);
        if (
          execution &&
          'record' in execution &&
          execution.record.attempt.dispatch !== 'not_dispatched' &&
          !execution.record.attempt.effectEvidenceRefs?.length &&
          execution.record.state !== 'succeeded'
        )
          throw new IdentityError(
            409,
            'CONFLICT',
            'A previous write is uncertain. Reconcile that correction before starting another.',
          );
      }
      const before = await deps.read(context, target);
      const blocker = correctionBlocker(before, choice, granted, deps.now());
      if (blocker) throw new IdentityError(409, 'CONFLICT', blocker);
      const expiresAt = new Date(
        Math.min(
          deps.now().getTime() + 5 * 60_000,
          Date.parse(before.source.observedAt) + 5 * 60_000,
        ),
      ).toISOString();
      const action: ProposedAction = {
        schemaVersion: 1,
        id: requestId,
        tenantId: context.tenantId,
        capability: choice.capability,
        capabilityVersion: '0',
        connectionId: target.connectionId,
        target: { kind: 'shopify_inventory_correction', id: requestId },
        parameters: {
          policy: 'erp_to_shopify',
          sourceConnectionId: target.sourceConnectionId,
          sourceObservationId: before.source.observationId,
          sourceRevision: before.source.revision,
          inventoryItemId: before.inventoryItemId,
          locationId: before.locationId,
          expectedRevision: before.targetRevision,
          expectedAvailable: before.available,
          available: before.source.available,
        },
        preconditions: {
          evidenceRefs: [before.id, before.source.observationId],
          validUntil: expiresAt,
        },
        expectedPostcondition: { available: before.source.available },
        risk: 'medium',
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

      return prepare(context, run);
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
      if (!previous || !('record' in previous)) {
        if (!(await view(context, run)).canExecute)
          throw new IdentityError(
            409,
            'CONFLICT',
            'This action needs current approval before it can run.',
          );
        await deps.store.claim(context, run);
      }
      await deps.bind(context, run);
      const result = await deps.admission.execute(context, {
        runId: id,
        stepId: 'correct',
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

      if (
        !previous &&
        !run.decisionId &&
        context.actor.id === run.action.proposedBy.id &&
        deps.now().getTime() < Date.parse(run.action.expiresAt)
      )
        return prepare(context, run);

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
    /** Rejects stale, altered or unrelated admission steps before the shared engine reserves a write. */
    async eligible(context: TenantContext, step: BoundActionStep) {
      const run = await deps.store.get(context, step.runId);
      if (
        !run ||
        step.stepId !== 'correct' ||
        step.actionHash !== deps.hash(run.action) ||
        step.principalId !== run.action.proposedBy.id ||
        deps.now().getTime() >= Date.parse(run.action.expiresAt)
      )
        return false;
      const granted = await deps.authorize(context, run.target.connectionId);
      const current = await deps.read(context, run.target);

      return (
        current.revision === run.before.revision &&
        !correctionBlocker(current, run.choice, granted, deps.now())
      );
    },
  };
}

/** Verifies the approved quantity independently from a successful mutation receipt. */
export function verifyCorrection(
  run: CorrectionRun,
  current: CorrectionSnapshot,
) {
  return {
    outcome: inventoryReconciled(run.before, current)
      ? ('passed' as const)
      : ('inconclusive' as const),
    observationRefs: [current.id],
    observedAt: current.observedAt,
    evaluatorVersion: 'shopify-inventory-reconciliation/1',
  };
}

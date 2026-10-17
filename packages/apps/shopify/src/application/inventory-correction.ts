import type { EffectRegistry, InstallationCapability } from '@luma/connections';
import type {
  ActionAdmission,
  BoundActionStep,
  ExecutionResult,
} from '@luma/execution';
import type { TenantContext } from '@luma/identity';
import {
  hasPermission,
  requireChangesAllowed,
  requirePermission,
  requireTenant,
} from '@luma/identity';
import {
  canonicalJson,
  conflict,
  forbidden,
  notFound,
  ServiceError,
} from '@luma/platform';
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
  configurationKey?: string | undefined;
  workflowRunId?: string | undefined;
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
  /** Lists the tenant's unexpired previews and those dispatched in the last seven days, newest first, at most 50. */
  open(context: TenantContext): Promise<CorrectionRun[]>;
}

export interface CorrectionDependencies {
  /** Reads the current tenant detection settings without provider I/O. */
  configurationKey?(context: TenantContext): Promise<string>;
  store: CorrectionStore;
  /**
   * The person's access to this app feature, checked by the app host with installation, the
   * app's permission and its scopes. Pass a refreshed context.
   */
  permission: {
    require(context: TenantContext): Promise<void>;
    allowed(context: TenantContext): Promise<boolean>;
  };
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
  /** How long a person has to decide on a preview. Defaults to four hours. */
  decisionWindowMs?: number;
}

/** How long a person has to decide on a stock correction by default. */
const decisionWindowMs = 4 * 60 * 60_000;

/** Offers source-bound previews and reference-only execution, preserving the shared approval and reconciliation controls. */
export function createInventoryCorrection(deps: CorrectionDependencies) {
  async function authorize(context: TenantContext) {
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    await deps.permission.require(fresh);
    if (fresh.actor.id !== context.actor.id) throw forbidden('Sign in again.');

    return fresh;
  }

  async function load(context: TenantContext, id: string) {
    const run = await deps.store.get(context, id);
    if (!run) throw notFound('Correction not found.');
    await deps.authorize(context, run.target.connectionId);

    return run;
  }

  async function view(
    context: TenantContext,
    run: CorrectionRun,
    result?: ExecutionResult | null,
    // `null` evaluates persisted state only; the source is then not checked for changes.
    snapshot?: CorrectionSnapshot | null,
  ): Promise<CorrectionView> {
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
    const withheld = record?.attempt.dispatch === 'not_dispatched';
    if (accepted || withheld || record?.state === 'succeeded')
      await deps.store.settle(context, run.id);
    const verified = record?.attempt.businessOutcome === 'satisfied';
    let current: CorrectionSnapshot | null = null;
    let sourceChanged = false;
    if (!record && !expired && snapshot !== null) {
      try {
        current = snapshot ?? (await deps.read(context, run.target));
      } catch (error) {
        if (
          run.target.receipt &&
          error instanceof ServiceError &&
          [404, 409].includes(error.statusCode)
        )
          sourceChanged = true;
        else throw error;
      }
    }
    const changed =
      (!!deps.configurationKey &&
        run.configurationKey !== (await deps.configurationKey(context))) ||
      sourceChanged ||
      (current !== null &&
        (current.revision !== run.before.revision ||
          !!correctionBlocker(
            current,
            run.choice,
            await deps.authorize(context, run.target.connectionId),
            deps.now(),
          )));
    const policyChanged =
      decision !== null &&
      decision.policyVersion !==
        (await deps.policies.currentVersion(context.tenantId));
    const rejected = decision?.approval?.outcome === 'rejected';
    if (
      !record &&
      (changed ||
        expired ||
        rejected ||
        policyChanged ||
        decision?.outcome === 'denied')
    )
      await deps.store.settle(context, run.id);
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
        ? run.target.receipt
          ? 'A fresh Shopify read verifies stock after booking the approved undamaged receipt units.'
          : run.target.nativeAllocation
            ? 'A fresh Shopify read verifies the approved stored allocation and unchanged inventory eligibility.'
            : 'A fresh Shopify read matches the approved ERP quantity.'
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
                  ? 'A person with approval permission rejected this action.'
                  : decision?.outcome === 'denied'
                    ? 'This action is no longer eligible. Refresh inventory details.'
                    : state === 'approval_required'
                      ? decision?.approval?.outcome === 'approved'
                        ? run.workflowRunId
                          ? 'Approved. Luma will run this now through the workflow, then check the result independently.'
                          : 'Approved. The requester can run the action after a fresh eligibility check.'
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
      workflowRunId: run.workflowRunId,
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
        (!(run.target.nativeAllocation || run.target.receipt) ||
          hasPermission(context, 'inventory.manage')) &&
        !observeOnly &&
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
        (!(run.target.nativeAllocation || run.target.receipt) ||
          hasPermission(context, 'inventory.approve')) &&
        !observeOnly &&
        !record &&
        !expired &&
        !changed &&
        !policyChanged &&
        state === 'approval_required' &&
        !decision?.approval &&
        (decision?.requireIndependentApproval === false ||
          context.actor.id !== run.action.proposedBy.id),
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
        permission: effect?.permission ?? 'actions.propose',
      },
    );
    await deps.store.decision(context, run.id, decision.id);

    return view(context, { ...run, decisionId: decision.id });
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
      if (target.nativeAllocation || target.receipt) {
        requirePermission(context, 'inventory.manage');
        requireChangesAllowed(context);
      }
      const choice: CorrectionChoice = {
        capability: 'inventory.available.reconcile',
      };
      const existing = await deps.store.get(context, requestId);
      if (existing) {
        if (
          canonicalJson(existing.target) !== canonicalJson(target) ||
          JSON.stringify(existing.choice) !== JSON.stringify(choice) ||
          existing.action.proposedBy.id !== context.actor.id
        )
          throw conflict('This request already belongs to another correction.');

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
          throw conflict(
            'A previous write is uncertain. Reconcile that correction before starting another.',
          );
      }
      const before = await deps.read(context, target);
      const blocker = correctionBlocker(before, choice, granted, deps.now());
      if (blocker) throw conflict(blocker);
      // People get a decision window; evidence freshness is checked again on a fresh read before
      // the write, so the approval binds this exact change, not this read.
      const expiresAt = new Date(
        deps.now().getTime() + (deps.decisionWindowMs ?? decisionWindowMs),
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
          referenceDocumentUri: `luma://inventory-corrections/v0:${requestId}`,
          policy: target.receipt
            ? 'purchase_receipt_to_shopify'
            : target.nativeAllocation
              ? 'native_stock_to_shopify'
              : 'erp_to_shopify',
          ...(before.source.nativeAllocation
            ? {
                nativeScopeVersion:
                  before.source.nativeAllocation.scope.version,
              }
            : {}),
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
        ...(context.actor.sessionId.startsWith('workflow:')
          ? { workflowRunId: context.requestId }
          : {}),
        ...(deps.configurationKey
          ? { configurationKey: await deps.configurationKey(context) }
          : {}),
        decisionId: null,
      });

      return prepare(context, run);
    },
    async execute(context: TenantContext, input: unknown) {
      context = await authorize(context);
      const { id } = z.object({ id: z.string().uuid() }).strict().parse(input);
      const run = await load(context, id);
      if (run.target.nativeAllocation || run.target.receipt) {
        requirePermission(context, 'inventory.manage');
        requireChangesAllowed(context);
      }
      if (context.actor.id !== run.action.proposedBy.id)
        throw forbidden('Only the requester can run this action.');
      const previous = await deps.admission.get(context, id);
      if (previous?.state === 'not_executed')
        return view(context, run, previous);
      if (!previous || !('record' in previous)) {
        const current = await view(context, run);
        if (!current.canExecute && !current.observeOnly)
          throw conflict(
            'This action needs current approval before it can run.',
          );
        if (!current.observeOnly) await deps.store.claim(context, run);
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
      if (run.target.nativeAllocation || run.target.receipt) {
        requirePermission(context, 'inventory.approve');
        requireChangesAllowed(context);
      }
      if (!run.decisionId || !(await view(context, run)).canApprove)
        throw conflict('This action cannot be approved by you.');
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
    /**
     * Lists corrections that wait on a person: an approval, a run by the requester, or a check of an
     * accepted or uncertain write. Reads persisted state only, so an approvable preview may still
     * prove stale when its review reads Shopify. People without the app permission get none.
     */
    async pending(context: TenantContext): Promise<CorrectionView[]> {
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
        step.stepId !== 'correct' ||
        step.actionHash !== deps.hash(run.action) ||
        step.principalId !== run.action.proposedBy.id ||
        deps.now().getTime() >= Date.parse(run.action.expiresAt) ||
        (!!deps.configurationKey &&
          run.configurationKey !== (await deps.configurationKey(context)))
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
    outcome:
      inventoryReconciled(run.before, current) &&
      (run.action.parameters.referenceDocumentUri === undefined ||
        (current.writeAttribution?.referenceDocumentUri ===
          run.action.parameters.referenceDocumentUri &&
          current.writeAttribution.quantityMatches === true))
        ? ('passed' as const)
        : ('inconclusive' as const),
    observationRefs: [current.id],
    observedAt: current.observedAt,
    evaluatorVersion: 'shopify-inventory-reconciliation/2',
  };
}

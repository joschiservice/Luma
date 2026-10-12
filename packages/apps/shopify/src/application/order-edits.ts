import type { EffectRegistry, InstallationCapability } from '@luma/connections';
import type {
  ActionAdmission,
  BoundActionStep,
  ExecutionResult,
} from '@luma/execution';
import type { TenantContext } from '@luma/identity';
import { IdentityError, requireTenant } from '@luma/identity';
import { canonicalJson } from '@luma/platform';
import type { PolicyService, ProposedAction } from '@luma/policies';
import { z } from 'zod';

import {
  type AuthoritativeLines,
  editedLines,
  editFacts,
  type EditFence,
  editTouchesHold,
  orderEditBlocker,
  type OrderEditCalculation,
  orderEditCapability,
  type OrderEditChange,
  orderEditPreviewInput,
  type OrderEditSnapshot,
  type OrderEditTarget,
  orderEditTarget,
  type OrderEditView,
  type OrderLineAuthority,
} from '../domain/order-edits.js';

export interface OrderEditRun {
  id: string;
  tenantId: string;
  target: OrderEditTarget;
  change: OrderEditChange;
  /** Each changed line with the quantity the preview read and its approved target. */
  lines: { lineItemId: string; currentQuantity: number; quantity: number }[];
  before: OrderEditSnapshot;
  /** Shopify's calculation; null for previews made while writes were off. */
  calculation: OrderEditCalculation | null;
  authority: OrderLineAuthority;
  /**
   * The authoritative source read whose quantities this edit propagates; null when this store
   * holds line authority. Absent on edits saved before propagation existed.
   */
  source?: AuthoritativeLines | null;
  action: ProposedAction;
  decisionId: string | null;
}

export interface OrderEditStore {
  /** Inserts an immutable preview; returns an identical retry or rejects a conflicting one. */
  save(context: TenantContext, run: OrderEditRun): Promise<OrderEditRun>;
  /** Reserves one edit per order and revision; repeated calls for the same run are safe. */
  claim(context: TenantContext, run: OrderEditRun): Promise<void>;
  /** Releases the order after a durable acceptance, a confirmed withheld write or proof it was not applied. */
  settle(context: TenantContext, id: string): Promise<void>;
  get(context: TenantContext, id: string): Promise<OrderEditRun | null>;
  list(
    context: TenantContext,
    target: OrderEditTarget,
  ): Promise<OrderEditRun[]>;
  decision(
    context: TenantContext,
    id: string,
    decisionId: string,
  ): Promise<void>;
  /** Lists the tenant's unexpired previews and those dispatched in the last seven days, newest first, at most 50. */
  open(context: TenantContext): Promise<OrderEditRun[]>;
  /** Reads the commit fence without changing it. */
  fence(context: TenantContext, id: string): Promise<EditFence | null>;
}

export interface OrderEditDependencies {
  store: OrderEditStore;
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
  /** Grants of the tenant's installed Shopify connection; throws when it is not available. */
  authorize(
    context: TenantContext,
    connectionId: string,
  ): Promise<InstallationCapability[]>;
  read(
    context: TenantContext,
    target: OrderEditTarget,
  ): Promise<OrderEditSnapshot>;
  /** The workspace's order-line authority; null when the host has no authority reader. */
  authority(context: TenantContext): Promise<OrderLineAuthority | null>;
  /**
   * Another connection's current quantities for this order's lines, from Luma's stored reads;
   * null when the host can't tell or the order isn't linked to that source.
   */
  sourceLines(
    context: TenantContext,
    target: OrderEditTarget,
    sourceConnectionId: string,
  ): Promise<AuthoritativeLines | null>;
  /** Asks Shopify to calculate the edit without committing it. */
  calculate(
    context: TenantContext,
    target: OrderEditTarget,
    lines: OrderEditRun['lines'],
    restock: boolean,
  ): Promise<OrderEditCalculation>;
  digest(calculation: OrderEditCalculation): string;
  bind(context: TenantContext, run: OrderEditRun): Promise<void>;
  hash(action: ProposedAction): string;
  now(): Date;
  /** How long a person has to decide on a preview. Defaults to four hours. */
  decisionWindowMs?: number;
}

const tail = (gid: string) => gid.split('/').at(-1) ?? gid;

/**
 * Offers order-bound quantity edit previews and reference-only execution, preserving the shared
 * approval, claim and reconciliation controls. Workflows call the same entry points as people.
 */
export function createOrderEdits(deps: OrderEditDependencies) {
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
      throw new IdentityError(404, 'NOT_FOUND', 'Order edit not found.');
    await deps.authorize(context, run.target.connectionId);

    return run;
  }

  /**
   * Current line authority with, when another connection holds it, that source's latest stored
   * read of this order's lines.
   */
  async function authorityAccess(
    context: TenantContext,
    target: OrderEditTarget,
  ) {
    const authority = await deps.authority(context);
    const source =
      authority?.state === 'resolved' &&
      authority.connectionId &&
      authority.connectionId !== target.connectionId
        ? await deps.sourceLines(context, target, authority.connectionId)
        : null;

    return { authority, source, now: deps.now() };
  }

  /**
   * Whether a fresh read and current authority still match the reviewed edit. A propagated edit
   * also needs the same authoritative source, read freshly, still reporting the approved values.
   */
  async function current(
    context: TenantContext,
    run: OrderEditRun,
    snapshot: OrderEditSnapshot,
  ) {
    const access = await authorityAccess(context, run.target);

    return (
      snapshot.revision === run.before.revision &&
      access.authority?.revision === run.authority.revision &&
      (access.source?.connectionId ?? null) ===
        (run.source?.connectionId ?? null) &&
      !orderEditBlocker(snapshot, run.change, {
        connectionId: run.target.connectionId,
        granted: await deps.authorize(context, run.target.connectionId),
        ...access,
      })
    );
  }

  async function view(
    context: TenantContext,
    run: OrderEditRun,
    result?: ExecutionResult | null,
    // `null` evaluates persisted state only; the source is then not checked for changes.
    snapshot?: OrderEditSnapshot | null,
  ): Promise<OrderEditView> {
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
    // Independent reads proved a sent or interrupted commit never took effect.
    const notApplied =
      !!record &&
      !accepted &&
      !withheld &&
      record.state !== 'succeeded' &&
      record.attempt.verification?.outcome === 'failed';
    if (
      accepted ||
      withheld ||
      notApplied ||
      record?.state === 'succeeded' ||
      execution?.state === 'not_executed'
    )
      await deps.store.settle(context, run.id);
    const verified = record?.attempt.businessOutcome === 'satisfied';
    const live =
      !record && !expired && snapshot !== null
        ? (snapshot ?? (await deps.read(context, run.target)))
        : null;
    // A preview made while writes were off has no approved calculation to send.
    const uncalculated = !observeOnly && !record && !run.calculation;
    const changed =
      uncalculated || (live !== null && !(await current(context, run, live)));
    const policyChanged =
      decision !== null &&
      decision.policyVersion !==
        (await deps.policies.currentVersion(context.tenantId));
    const rejected = decision?.approval?.outcome === 'rejected';
    const state: OrderEditView['state'] = verified
      ? 'verified'
      : withheld || notApplied
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
    const message = verified
      ? 'A fresh Shopify read shows the approved quantities and Luma’s edit.'
      : withheld
        ? 'Shopify did not apply this edit. Review the order again before another edit.'
        : notApplied
          ? 'Independent reads show the edit was not applied. Luma will not send it again; review a new edit.'
          : record
            ? accepted
              ? 'Shopify accepted the edit. The new quantities are not yet verified. Check again or review the order in Shopify.'
              : 'The edit outcome is uncertain. Luma reads Shopify to reconcile it and will not send it again.'
            : policyChanged
              ? 'Approval policy changed. Refresh and review a new edit.'
              : uncalculated
                ? 'Writes were off when this edit was previewed, so Shopify never calculated it. Review a new edit.'
                : changed
                  ? 'The order changed since this preview. Refresh and review a new edit.'
                  : expired
                    ? 'This preview expired. Refresh the order and review a new edit.'
                    : rejected
                      ? 'A person with approval permission rejected this edit.'
                      : decision?.outcome === 'denied'
                        ? 'This edit is no longer eligible. Refresh the order.'
                        : state === 'approval_required'
                          ? decision?.approval?.outcome === 'approved'
                            ? 'Approved. The requester can send the edit after a fresh check.'
                            : decision?.requireIndependentApproval === false
                              ? 'Review and approve this exact edit before sending it.'
                              : 'Someone else who can approve changes must approve this exact edit.'
                          : 'Review the exact edit. Shopify is checked and recalculated again before it is sent.';

    return {
      observeOnly,
      id: run.id,
      target: run.target,
      change: run.change,
      lines: run.lines,
      before: run.before,
      calculation: run.calculation,
      authority: run.authority,
      source: run.source ?? null,
      onHold: editTouchesHold(run.before, run.change),
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
            : notApplied
              ? 'not_applied'
              : rejected
                ? 'rejected'
                : policyChanged || decision?.outcome === 'denied'
                  ? 'policy'
                  : changed
                    ? 'changed'
                    : 'expired',
      acceptance: accepted
        ? 'accepted'
        : record && !withheld && !notApplied
          ? 'unknown'
          : 'not_sent',
      message,
      canExecute:
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

  return {
    /**
     * Reads a saved edit's current state, rereading Shopify while it can still run. Returns null
     * when the tenant has no edit with this ID. Changes nothing except releasing a settled claim.
     */
    async status(context: TenantContext, id: string) {
      context = await authorize(context);
      const run = await deps.store.get(context, id);
      if (!run) return null;
      await deps.authorize(context, run.target.connectionId);

      return view(context, run);
    },
    /**
     * Lists the order's recent edits from persisted state only, without reading Shopify, so an
     * order page can tell whether an edit waits on someone before opening the editor.
     */
    async recent(context: TenantContext, input: unknown) {
      context = await authorize(context);
      const target = orderEditTarget.parse(input);
      await deps.authorize(context, target.connectionId);

      return {
        runs: await Promise.all(
          (await deps.store.list(context, target)).map((run) =>
            view(context, run, undefined, null),
          ),
        ),
      };
    },
    /**
     * Reads the order, the connection's grants, line authority (with the authoritative source's
     * line quantities when another connection holds it) and recent edits of the order.
     */
    async inspect(context: TenantContext, input: unknown) {
      context = await authorize(context);
      const target = orderEditTarget.parse(input);
      const granted = await deps.authorize(context, target.connectionId);
      const [snapshot, { authority, source }] = await Promise.all([
        deps.read(context, target),
        authorityAccess(context, target),
      ]);
      const runs = await deps.store.list(context, target);

      return {
        snapshot,
        granted,
        authority,
        source,
        observeOnly:
          (await deps.admission.writeMode?.(context, target.connectionId)) ===
          'observe_only',
        runs: await Promise.all(
          runs.map((run) => view(context, run, undefined, snapshot)),
        ),
      };
    },
    /**
     * Saves an immutable preview bound to the order revision, exact lines, restock choice, line
     * authority (and the authoritative source read a propagated edit carries) and, unless writes
     * are off, Shopify's non-committing calculation. Rejects blocked edits with 409 and never
     * sends anything in observe-only.
     */
    async preview(context: TenantContext, input: unknown) {
      context = await authorize(context);
      const { requestId, change, ...target } =
        orderEditPreviewInput.parse(input);
      const existing = await deps.store.get(context, requestId);
      if (existing) {
        if (
          canonicalJson(existing.target) !== canonicalJson(target) ||
          canonicalJson(existing.change) !== canonicalJson(change) ||
          existing.action.proposedBy.id !== context.actor.id
        )
          throw new IdentityError(
            409,
            'CONFLICT',
            'This request already belongs to another order edit.',
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
          execution.record.attempt.verification?.outcome !== 'failed'
        )
          throw new IdentityError(
            409,
            'CONFLICT',
            'A previous edit of this order is uncertain. Reconcile it before starting another.',
          );
      }
      const { authority, source, now } = await authorityAccess(context, target);
      const access = {
        connectionId: target.connectionId,
        granted,
        authority,
        source,
        now,
      };
      const first = await deps.read(context, target);
      const blocker = orderEditBlocker(first, change, access);
      // The blocker already requires resolved authority; the check narrows its type.
      if (blocker || !authority)
        throw new IdentityError(
          409,
          'CONFLICT',
          blocker ?? 'Order line authority is unknown.',
        );
      // Observe-only sends nothing to Shopify, not even the non-committing calculation.
      const observeOnly =
        (await deps.admission.writeMode?.(context, target.connectionId)) ===
        'observe_only';
      let before = first;
      let calculation: OrderEditCalculation | null = null;
      if (!observeOnly) {
        calculation = await deps.calculate(
          context,
          target,
          editedLines(first, change),
          change.restock,
        );
        // Bind the read after calculating, so a revision bump from the session itself is reviewed.
        before = await deps.read(context, target);
        if (
          editFacts(before) !== editFacts(first) ||
          orderEditBlocker(before, change, access)
        )
          throw new IdentityError(
            409,
            'CONFLICT',
            'The order changed while Shopify calculated the edit. Refresh and try again.',
          );
      }
      const lines = editedLines(before, change);
      const expiresAt = new Date(
        deps.now().getTime() + (deps.decisionWindowMs ?? 4 * 60 * 60_000),
      ).toISOString();
      const action: ProposedAction = {
        schemaVersion: 1,
        id: requestId,
        tenantId: context.tenantId,
        capability: orderEditCapability,
        capabilityVersion: '0',
        connectionId: target.connectionId,
        target: { kind: 'shopify_order_edit', id: requestId },
        parameters: {
          orderId: target.orderId,
          expectedRevision: before.revision,
          restock: change.restock,
          lines: lines
            .map(
              (line) =>
                `${tail(line.lineItemId)}:${line.currentQuantity}>${line.quantity}`,
            )
            .join(','),
          calculation: calculation ? deps.digest(calculation) : null,
          authorityRevision: authority.revision,
          // A propagated edit binds the authoritative read whose values it carries.
          authoritySource: source
            ? `${source.connectionId}:${source.observationId}@${source.observedAt}`
            : null,
        },
        preconditions: {
          evidenceRefs: calculation ? [before.id, calculation.id] : [before.id],
          validUntil: expiresAt,
        },
        expectedPostcondition: {
          lineQuantities: lines
            .map((line) => `${tail(line.lineItemId)}:${line.quantity}`)
            .join(','),
        },
        risk: 'medium',
        proposedBy: { kind: 'user', id: context.actor.id },
        expiresAt,
      };
      const run = await deps.store.save(context, {
        id: requestId,
        tenantId: context.tenantId,
        target,
        change,
        lines,
        before,
        calculation,
        authority,
        source,
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
          minimumRisk: 'medium',
          permission: effect?.permission ?? 'actions.propose',
        },
      );
      await deps.store.decision(context, run.id, decision.id);

      return view(context, { ...run, decisionId: decision.id });
    },
    /** Sends an approved edit by reference as its requester; observe-only records it as not executed. */
    async execute(context: TenantContext, input: unknown) {
      context = await authorize(context);
      const { id } = z.object({ id: z.string().uuid() }).strict().parse(input);
      const run = await load(context, id);
      if (context.actor.id !== run.action.proposedBy.id)
        throw new IdentityError(
          403,
          'FORBIDDEN',
          'Only the requester can send this edit.',
        );
      const previous = await deps.admission.get(context, id);
      if (previous?.state === 'not_executed')
        return view(context, run, previous);
      if (!previous || !('record' in previous)) {
        const now = await view(context, run);
        if (!now.canExecute && !now.observeOnly)
          throw new IdentityError(
            409,
            'CONFLICT',
            'This edit needs current approval before it can be sent.',
          );
        if (!now.observeOnly) await deps.store.claim(context, run);
      }
      await deps.bind(context, run);
      const result = await deps.admission.execute(context, {
        runId: id,
        stepId: 'edit',
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
          'This edit cannot be approved by you.',
        );
      await deps.policies.respond(
        context,
        run.decisionId,
        outcome,
        run.action.expiresAt,
      );

      return view(context, run);
    },
    /** Rechecks a preview, or reconciles and verifies a sent edit through independent reads only. */
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
     * Lists edits that wait on a person: an approval, a send by the requester, or a check of an
     * accepted or uncertain edit. Reads persisted state only. People without the app permission
     * get none.
     */
    async pending(context: TenantContext): Promise<OrderEditView[]> {
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
    /** Rejects stale, altered, uncalculated or unrelated admission steps before the engine reserves a write. */
    async eligible(context: TenantContext, step: BoundActionStep) {
      const run = await deps.store.get(context, step.runId);
      if (
        !run ||
        // Only observe-only runs, which never dispatch, may lack an approved calculation.
        (!run.calculation &&
          (await deps.admission.writeMode?.(
            context,
            run.target.connectionId,
          )) !== 'observe_only') ||
        step.stepId !== 'edit' ||
        step.actionHash !== deps.hash(run.action) ||
        step.principalId !== run.action.proposedBy.id ||
        deps.now().getTime() >= Date.parse(run.action.expiresAt)
      )
        return false;

      return current(context, run, await deps.read(context, run.target));
    },
    /** Whether a fresh read still matches a reviewed edit; the provider calls this right before calculating. */
    async unchanged(
      context: TenantContext,
      id: string,
      snapshot: OrderEditSnapshot,
    ) {
      const run = await deps.store.get(context, id);

      return !!run && current(context, run, snapshot);
    },
  };
}

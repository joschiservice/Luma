import type { BoundActionStep } from '@luma/execution';
import type { TenantContext } from '@luma/identity';
import {
  hasPermission,
  requirePermission,
  requireTenant,
} from '@luma/identity';
import {
  canonicalJson,
  conflict,
  forbidden,
  mapLimited,
  notFound,
  unavailable,
} from '@luma/platform';

import type { PurchaseOrderInput } from '../domain/procurement.js';
import type {
  PurchasingOverview,
  PurchasingPlan,
  PurchasingPlanInput,
  PurchasingSettings,
} from '../domain/purchasing.js';
import { purchasingAmountUnits } from '../domain/purchasing.js';

export interface PurchasingStore {
  settings(context: TenantContext): Promise<PurchasingSettings>;
  saveSettings(
    context: TenantContext,
    settings: PurchasingSettings,
  ): Promise<PurchasingSettings>;
  plans(context: TenantContext): Promise<PurchasingPlan[]>;
  plan(context: TenantContext, id: string): Promise<PurchasingPlan | null>;
  /** Persists a new immutable request or checks its exact retry under a tenant lock. */
  insert(context: TenantContext, plan: PurchasingPlan): Promise<PurchasingPlan>;
  update(context: TenantContext, plan: PurchasingPlan): Promise<void>;
}

export interface PurchasingAdmission {
  prepare(
    context: TenantContext,
    plan: PurchasingPlan,
  ): Promise<{ decisionId: string; allowed: boolean; reason: string | null }>;
  decision(
    context: TenantContext,
    plan: PurchasingPlan,
  ): Promise<{
    requireIndependentApproval?: boolean | undefined;
    approved: boolean;
    rejected: boolean;
  } | null>;
  respond(
    context: TenantContext,
    plan: PurchasingPlan,
    outcome: 'approved' | 'rejected',
  ): Promise<void>;
  execute(
    context: TenantContext,
    plan: PurchasingPlan,
    reconcile: boolean,
  ): Promise<{ state: PurchasingPlan['state']; failure: string | null }>;
}

/** Plan decisions one plan list reads at once. */
const decisionReadConcurrency = 3;

/** Authorizes purchasing reads and binds immutable supplier plans to governed draft creation. */
export function createPurchasingService(deps: {
  parsePlan(input: unknown): PurchasingPlanInput;
  parseSettings(input: unknown): PurchasingSettings;
  store: PurchasingStore;
  overview(
    context: TenantContext,
    settings: PurchasingSettings,
  ): Promise<
    Omit<PurchasingOverview, 'enabled' | 'plansEnabled' | 'canManage'>
  >;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  principal(
    tenantId: string,
    actorId: string,
    requestId: string,
  ): Promise<TenantContext>;
  released(
    context: TenantContext,
    key: 'purchasing-workbench' | 'purchasing-plans',
  ): Promise<boolean>;
  admission: PurchasingAdmission | null;
  shortfall?(
    context: TenantContext,
    orderId: string,
    key: string,
  ): Promise<{
    supplierId: string;
    quantities: { sku: string; lineId: string; quantity: number }[];
    evidenceRefs: string[];
  }>;
  acknowledgeShortfall?(
    context: TenantContext,
    plan: PurchasingPlan,
  ): Promise<void>;
  now(): Date;
  uuid(key: string): string;
}) {
  async function authorize(context: TenantContext, write = false) {
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    if (fresh.actor.id !== context.actor.id)
      throw forbidden('Sign in again to continue.');
    requirePermission(fresh, write ? 'procurement.manage' : 'procurement.read');

    return fresh;
  }

  async function released(context: TenantContext, write = false) {
    if (
      !(await deps.released(context, 'purchasing-workbench')) ||
      (write && !(await deps.released(context, 'purchasing-plans')))
    )
      throw conflict('Purchasing is not enabled for this workspace.');
  }

  async function get(context: TenantContext, id: string) {
    const plan = await deps.store.plan(context, id);
    if (!plan) throw notFound('Purchasing plan not found.');

    return plan;
  }

  async function overview(context: TenantContext, period?: number) {
    context = await authorize(context);
    const enabled = await deps.released(context, 'purchasing-workbench');
    const plansEnabled =
      enabled &&
      !!deps.admission &&
      (await deps.released(context, 'purchasing-plans'));
    const stored = await deps.store.settings(context);
    const settings = deps.parseSettings({
      ...stored,
      ...(period ? { demandPeriodDays: period } : {}),
    });
    const facts = enabled
      ? await deps.overview(context, settings)
      : {
          settings,
          items: [],
          locations: [],
          asOf: deps.now().toISOString(),
          truncated: false,
        };

    return {
      ...facts,
      enabled,
      plansEnabled,
      canManage: hasPermission(context, 'procurement.manage'),
    };
  }

  async function propose(context: TenantContext, input: PurchasingPlanInput) {
    context = await authorize(context, true);
    await released(context, true);
    const request = deps.parsePlan(input);
    const prior = await deps.store.plan(context, request.id);
    if (prior) {
      if (
        prior.requestedBy !== context.actor.id ||
        canonicalJson(prior.request) !== canonicalJson(request)
      )
        throw conflict('This plan ID already belongs to a different request.');
      if (prior.decisionId || prior.state !== 'approval_required') return prior;
      const decision = await deps.admission!.prepare(context, prior);
      const updated = {
        ...prior,
        decisionId: decision.decisionId,
        state: decision.allowed
          ? ('approval_required' as const)
          : ('withheld' as const),
        failure: decision.reason,
      };
      await deps.store.update(context, updated);

      return updated;
    }
    const current = await overview(context);
    if (request.sourceOrderId && (!request.attentionKey || !deps.shortfall))
      throw conflict('Review the source shortfall before reordering.');
    const shortfall = request.sourceOrderId
      ? await deps.shortfall!(
          context,
          request.sourceOrderId,
          request.attentionKey!,
        )
      : null;
    if (shortfall?.supplierId === request.supplierId)
      throw conflict('Choose another supplier for the remainder.');
    const suggestions: PurchasingPlan['suggestions'] = [];
    const lines: PurchaseOrderInput['lines'] = [];
    for (const [index, line] of request.lines.entries()) {
      const rec = current.items.find(
        (r) =>
          r.supplierId === request.supplierId &&
          r.skuId === line.skuId &&
          r.stocks.some((s) => s.locationId === line.locationId),
      );
      const missing = rec?.missing.filter(
        (reason) =>
          !shortfall || !['demand_incomplete', 'lead_time'].includes(reason),
      ) ?? ['inputs_missing'];
      const existing =
        rec?.existingOrders.filter((o) => o.id !== request.sourceOrderId) ?? [];
      const remainder = shortfall?.quantities
        .filter(
          (q) =>
            q.sku === line.skuId ||
            q.sku === rec?.sku ||
            rec?.stocks.some((st) => st.sku === q.sku),
        )
        .reduce((sum, q) => sum + q.quantity, 0);
      if (
        !rec ||
        rec.termsRevision !== line.termsRevision ||
        missing.length ||
        existing.length ||
        (!shortfall && (rec.quantity === null || rec.quantity <= 0)) ||
        (shortfall &&
          (!remainder ||
            request.lines
              .filter((candidate) => candidate.skuId === line.skuId)
              .reduce((sum, candidate) => sum + candidate.quantity, 0) >
              Math.ceil(
                Math.max(remainder, rec.minimumQuantity!) / rec.packSize!,
              ) *
                rec.packSize!))
      )
        throw conflict(
          'Inputs changed or are unavailable. Refresh and review this purchasing plan.',
        );
      if (
        line.quantity % rec.packSize! !== 0 ||
        line.quantity < rec.minimumQuantity!
      )
        throw conflict(
          'Review the pack size and minimum quantity for each line.',
        );
      const stock = rec.stocks.find((s) => s.locationId === line.locationId)!;
      lines.push({
        id: deps.uuid(`${request.id}:line:${index}`),
        sku: line.skuId,
        description: rec.sku,
        quantity: line.quantity,
        unit: stock.unit,
        locationId: line.locationId,
        ...(rec.unitPrice ? { unitPrice: rec.unitPrice } : {}),
        ...(rec.supplierArticleNumber
          ? { supplierArticleNumber: rec.supplierArticleNumber }
          : {}),
      });
      suggestions.push({
        skuId: line.skuId,
        locationId: line.locationId,
        suggested: remainder ?? rec.quantity,
        chosen: line.quantity,
        sourceConnectionIds: [
          ...new Set(
            rec.stocks
              .filter((s) => s.locationId === line.locationId)
              .map((s) => s.connectionId),
          ),
        ],
        target:
          rec.stocks.length === 1
            ? (rec.rule?.target ??
              (rec.demand.daily !== null && rec.leadTimeDays !== null
                ? rec.demand.daily *
                  (rec.leadTimeDays + current.settings.safetyDays)
                : null))
            : null,
        evidenceRefs: [
          ...rec.stocks.map((s) => s.observationId),
          ...rec.demand.evidenceRefs,
          ...(shortfall?.evidenceRefs ?? []),
        ],
      });
    }
    const supplierRecs = current.items.filter(
      (r) => r.supplierId === request.supplierId,
    );
    const minimum = supplierRecs.find(
      (r) => r.orderMinimumValue,
    )?.orderMinimumValue;
    if (minimum) {
      const sameCurrency = lines.every(
        (l) => l.unitPrice?.currency === minimum.currency,
      );
      const total = sameCurrency
        ? lines.reduce(
            (sum, l) =>
              sum +
              purchasingAmountUnits(l.unitPrice!.amount) * BigInt(l.quantity),
            0n,
          )
        : null;
      if (
        (total === null || total < purchasingAmountUnits(minimum.amount)) &&
        !request.reason
      )
        throw conflict(
          'Record a reason for an order below or unable to verify the supplier minimum value.',
        );
    }
    const now = deps.now();
    const actionId = deps.uuid(`${request.id}:action`);
    const order: PurchasingPlan['order'] = {
      id: deps.uuid(`${request.id}:order`),
      supplierId: request.supplierId,
      reference: request.reference,
      authority: 'luma',
      externalReferences: [],
      origin: {
        actionId,
        outcomeId: request.id,
        ...(request.sourceOrderId
          ? {
              sourcePurchaseOrderId: request.sourceOrderId,
              sourceAttentionKey: request.attentionKey!,
            }
          : {}),
      },
      lines,
    };
    const plan = await deps.store.insert(context, {
      id: request.id,
      tenantId: context.tenantId,
      supplierId: request.supplierId,
      request,
      requestedBy: context.actor.id,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 4 * 3_600_000).toISOString(),
      order,
      suggestions,
      actionId,
      decisionId: null,
      state: 'approval_required',
      failure: null,
    });
    const decision = await deps.admission!.prepare(context, plan);
    const prepared = {
      ...plan,
      decisionId: decision.decisionId,
      state: decision.allowed
        ? ('approval_required' as const)
        : ('withheld' as const),
      failure: decision.reason,
    };
    await deps.store.update(context, prepared);

    return prepared;
  }

  async function execute(
    context: TenantContext,
    id: string,
    reconcile = false,
  ) {
    context = await authorize(context, true);
    const plan = await get(context, id);
    if (
      ['verified', 'rejected', 'failed', 'withheld', 'expired'].includes(
        plan.state,
      )
    ) {
      if (plan.state === 'verified' && plan.request.sourceOrderId)
        await deps.acknowledgeShortfall?.(context, plan);

      return plan;
    }
    if (!deps.admission)
      throw unavailable('Purchasing execution is unavailable.');
    if (!reconcile) await released(context, true);
    const requester = await deps.principal(
      context.tenantId,
      plan.requestedBy,
      context.requestId,
    );
    const result = await deps.admission.execute(requester, plan, reconcile);
    const updated = { ...plan, ...result };
    await deps.store.update(context, updated);
    if (updated.state === 'verified' && updated.request.sourceOrderId)
      await deps.acknowledgeShortfall?.(requester, updated);

    return updated;
  }

  return {
    overview,
    propose,
    execute,
    /** Reads an uncertain action without repeating draft creation. */
    reconcile: (context: TenantContext, id: string) =>
      execute(context, id, true),
    /** Reads saved plans, including pending approvals and uncertain outcomes. */
    async plans(context: TenantContext) {
      context = await authorize(context);
      const plans = await deps.store.plans(context);
      const active = await deps.released(context, 'purchasing-plans');
      // Each decision read opens its own transactions; a few at a time keeps a long plan list
      // from taking the request pool from concurrent requests.
      const items = await mapLimited(
        plans,
        decisionReadConcurrency,
        async (plan) => {
          const decision =
            deps.admission && plan.decisionId
              ? await deps.admission.decision(context, plan)
              : null;
          const expired =
            deps.now().getTime() >= Date.parse(plan.expiresAt) &&
            ['approval_required', 'approved'].includes(plan.state);

          return {
            ...plan,
            state: expired
              ? ('expired' as const)
              : decision?.rejected
                ? ('rejected' as const)
                : decision?.approved && plan.state === 'approval_required'
                  ? ('approved' as const)
                  : plan.state,
            canExecute:
              active &&
              !expired &&
              !!decision?.approved &&
              context.actor.id === plan.requestedBy &&
              hasPermission(context, 'procurement.manage'),
            canApprove:
              active &&
              !expired &&
              plan.state === 'approval_required' &&
              !!decision &&
              !decision.approved &&
              !decision.rejected &&
              hasPermission(context, 'procurement.manage') &&
              hasPermission(context, 'decisions.respond') &&
              (decision.requireIndependentApproval === false ||
                context.actor.id !== plan.requestedBy),
          };
        },
      );

      return { items };
    },
    /** Saves explicit workspace assumptions against the revision reviewed by the operator. */
    async settings(context: TenantContext, input: unknown) {
      context = await authorize(context, true);
      await released(context);

      return deps.store.saveSettings(context, deps.parseSettings(input));
    },
    /** Approval remains subject to current permissions and workspace independent approval policy. */
    async decide(
      context: TenantContext,
      id: string,
      input: { decisionId: string; outcome: 'approved' | 'rejected' },
    ) {
      context = await authorize(context, true);
      requirePermission(context, 'decisions.respond');
      await released(context, true);
      const plan = await get(context, id);
      if (
        !plan.decisionId ||
        plan.decisionId !== input.decisionId ||
        !deps.admission
      )
        throw conflict('Review the current plan decision.');
      await deps.admission.respond(context, plan, input.outcome);
      if (input.outcome === 'approved') return execute(context, id);
      const updated = { ...plan, state: 'rejected' as const };
      await deps.store.update(context, updated);

      return updated;
    },
    /** Rechecks exact persisted plan and current evidence immediately before admission. */
    async eligible(context: TenantContext, step: BoundActionStep) {
      context = await authorize(context, true);
      if (!step.subject || step.subject.kind !== 'purchasing_plan')
        return false;
      if (!(await deps.released(context, 'purchasing-plans'))) return false;
      const plan = await get(context, step.subject.id);
      if (
        plan.requestedBy !== context.actor.id ||
        deps.now().getTime() >= Date.parse(plan.expiresAt)
      )
        return false;
      const current = await overview(context);
      const shortfall =
        plan.request.sourceOrderId &&
        deps.shortfall &&
        plan.request.attentionKey
          ? await deps.shortfall(
              context,
              plan.request.sourceOrderId,
              plan.request.attentionKey,
            )
          : null;

      return plan.request.lines.every((line) => {
        const rec = current.items.find(
          (r) => r.supplierId === plan.supplierId && r.skuId === line.skuId,
        );

        return (
          !!rec &&
          rec.termsRevision === line.termsRevision &&
          !rec.missing.filter(
            (reason) =>
              !shortfall ||
              !['demand_incomplete', 'lead_time'].includes(reason),
          ).length &&
          !rec.existingOrders.filter((o) => o.id !== plan.request.sourceOrderId)
            .length &&
          (shortfall
            ? shortfall.quantities.some(
                (q) =>
                  (q.sku === line.skuId || q.sku === rec.sku) &&
                  q.quantity > 0 &&
                  plan.request.lines
                    .filter((candidate) => candidate.skuId === line.skuId)
                    .reduce((sum, candidate) => sum + candidate.quantity, 0) <=
                    Math.ceil(
                      Math.max(q.quantity, rec.minimumQuantity!) /
                        rec.packSize!,
                    ) *
                      rec.packSize!,
              )
            : rec.quantity !== null &&
              rec.quantity > 0 &&
              rec.quantity ===
                plan.suggestions.find(
                  (s) =>
                    s.skuId === line.skuId && s.locationId === line.locationId,
                )?.suggested)
        );
      });
    },
  };
}

export type PurchasingService = ReturnType<typeof createPurchasingService>;

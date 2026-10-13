import type { AuditEntry } from '@luma/audit';
import type { ActionDiff } from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import {
  hasPermission,
  IdentityError,
  isAppPermission,
  requirePermission,
  requireTenant,
} from '@luma/identity';
import { canonicalJson } from '@luma/platform';
import type { PolicyDecision, ProposedAction } from '@luma/policies';

import type { ReturnAction } from '../domain/return-actions.js';
import type { ReturnCase } from '../domain/return-cases.js';
import {
  exchangeConsistency,
  type ExchangeConsistencyEvidence,
} from '../domain/return-consistency.js';
import type {
  ExchangeProof,
  ExchangeReplacement,
  ExchangeStep,
  ExchangeStepPlan,
  ReturnExchange,
} from '../domain/return-exchanges.js';
import type {
  CreationExecution,
  ReturnCaseDependencies,
  ReturnCaseEvent,
  ReturnCaseStore,
} from './return-cases.js';

/** A replacement exists only through explicit canonical mappings in both installed systems. */
export interface ExchangeChoice extends Omit<
  ExchangeReplacement,
  'quantity' | 'variantId'
> {
  id: string;
  label: string;
}

/** All writes and audit entries belong to orders and serialize with the case's order lock. */
export interface ReturnExchangeStore {
  transaction<T>(
    tenantId: string,
    fn: (tx: {
      lock(caseId: string): Promise<ReturnCase | null>;
      root(caseId: string): Promise<ReturnExchange | null>;
      saveRoot(value: ReturnExchange): Promise<void>;
      get(id: string): Promise<ExchangeStep | null>;
      list(caseId: string): Promise<ExchangeStep[]>;
      save(value: ExchangeStep): Promise<void>;
      insert(value: ExchangeStep): Promise<void>;
      choices(value: ReturnCase): Promise<ExchangeChoice[]>;
      refundFallback(value: ReturnCase, event: ReturnCaseEvent): Promise<void>;
      stockActions(caseId: string): Promise<ReturnAction[]>;
      finishCase(value: ReturnCase, event: ReturnCaseEvent): Promise<void>;
      audit(entry: AuditEntry): Promise<void>;
    }) => Promise<T>,
  ): Promise<T>;
}

/** Source reads provide replacement identities, current availability and native financial outcomes. */
export interface ReturnExchangeSystem {
  /** Rereads each leg without a provider write. Missing evidence remains unresolved. */
  consistency?(
    context: TenantContext,
    value: ReturnCase,
    root: ReturnExchange,
    process: ExchangeStep | null,
    actions: ReturnAction[],
  ): Promise<ExchangeConsistencyEvidence>;
  choices(
    context: TenantContext,
    connectionId: string,
    items: ExchangeChoice[],
  ): Promise<{
    items: (ExchangeChoice & { variantId: string; available: number | null })[];
    observedAt: string;
    evidenceRefs: string[];
  }>;
  availability(
    context: TenantContext,
    replacement: ExchangeReplacement,
  ): Promise<{
    available: boolean | null;
    observedAt: string;
    evidenceRefs: string[];
  }>;
  quote(
    context: TenantContext,
    connectionId: string,
    input: { operationId: string; plan: ExchangeStepPlan },
  ): Promise<{
    plan: ExchangeStepPlan;
    available: boolean;
    observedAt: string;
    evidenceRefs: string[];
  }>;
  proof(context: TenantContext, value: ExchangeStep): Promise<ExchangeProof>;
}

/** Each provider step enters shared policy, independent approval and durable one-shot execution. */
export interface ReturnExchangeAdmission {
  prepare(
    context: TenantContext,
    value: ExchangeStep,
    action: ProposedAction,
  ): Promise<PolicyDecision>;
  decision(
    context: TenantContext,
    id: string,
  ): Promise<
    | (PolicyDecision & {
        approval?: { outcome: 'approved' | 'rejected'; approverId: string };
      })
    | null
  >;
  respond(
    context: TenantContext,
    id: string,
    outcome: 'approved' | 'rejected',
    expiresAt: string,
  ): Promise<void>;
  execute(
    context: TenantContext,
    value: ExchangeStep,
  ): Promise<CreationExecution>;
  reconcile(
    context: TenantContext,
    value: ExchangeStep,
  ): Promise<CreationExecution>;
  writeMode(
    context: TenantContext,
    id: string,
  ): Promise<'observe_only' | 'writes_enabled'>;
}

interface Dependencies extends Pick<
  ReturnCaseDependencies,
  'refreshContext' | 'principal' | 'digest' | 'uuid' | 'now'
> {
  store: ReturnExchangeStore;
  cases: ReturnCaseStore;
  system: ReturnExchangeSystem | null;
  admission: ReturnExchangeAdmission | null;
  /** Optional shared review supplied by runtime composition for the immutable owner plan. */
  describeDiff?: (
    context: TenantContext,
    action: ProposedAction,
    observedAt: string,
    plan: ExchangeStepPlan,
  ) => Promise<ActionDiff | null>;
}

const facts = (value: ReturnCase) => [
  value.state,
  value.connectionId,
  value.lines,
  value.receipt,
  value.inspection,
  value.proposal,
];

function fail(status: 404 | 409 | 503, message: string): never {
  throw new IdentityError(
    status,
    status === 404
      ? 'NOT_FOUND'
      : status === 409
        ? 'CONFLICT'
        : 'SERVICE_UNAVAILABLE',
    message,
  );
}

/** Freezes one exact source effect and its case evidence for Action Admission. */
function action(
  value: ExchangeStep,
  digest: (value: unknown) => string,
): ProposedAction {
  return {
    schemaVersion: 1,
    id: value.actionId,
    tenantId: value.tenantId,
    capability: `returns.exchange.${value.plan.kind}`,
    capabilityVersion: '0',
    connectionId: value.connectionId,
    target: { kind: 'return_case_exchange', id: value.id },
    parameters: {
      operationId: value.operationId,
      ...(value.intentVersion === 2
        ? { planDigest: digest(value.plan) }
        : { plan: canonicalJson(value.plan) }),
      caseDigest: value.caseDigest,
    },
    preconditions: {
      evidenceRefs: [value.caseId, ...value.quote.evidenceRefs],
      validUntil: value.expiresAt,
    },
    expectedPostcondition: {
      operationId: value.operationId,
      stepId: value.id,
      kind: value.plan.kind,
    },
    risk: 'high',
    proposedBy: { kind: 'user', id: value.requestedBy },
    expiresAt: value.expiresAt,
  };
}

/** Coordinates one exchange across availability choices, native fulfillment and independent payment proof. */
export function createReturnExchanges(deps: Dependencies) {
  async function authorize(context: TenantContext, write = false) {
    requireTenant(context, context.tenantId);
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    if (fresh.actor.id !== context.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Sign in again to continue');
    requirePermission(fresh, write ? 'returns.manage' : 'returns.read');

    return fresh;
  }

  function fresh(at: string, refs: string[], since?: string) {
    const t = Date.parse(at),
      now = deps.now().getTime();

    return (
      Number.isFinite(t) &&
      t <= now &&
      now - t <= 300_000 &&
      (!since || t >= Date.parse(since)) &&
      refs.length > 0
    );
  }

  function audit(
    context: TenantContext,
    value: ExchangeStep,
    event: string,
  ): AuditEntry {
    const occurrence = deps.digest([value.updatedAt, value.proof]);

    return {
      id: deps.uuid(`return-exchange-audit:${value.id}:${event}:${occurrence}`),
      tenantId: context.tenantId,
      eventKey: `orders:${event}:${value.id}:${occurrence}`,
      eventType: event,
      schemaVersion: 1,
      occurredAt: value.updatedAt,
      actor: { kind: 'user', id: context.actor.id },
      evidenceRefs: value.proof?.evidenceRefs ?? value.quote.evidenceRefs,
      correlationId: value.caseId,
      proposalId: value.actionId,
      actionHash: deps.digest(action(value, deps.digest)),
      details: { operationId: value.operationId, kind: value.plan.kind },
    };
  }

  async function save(
    context: TenantContext,
    value: ExchangeStep,
    patch: Partial<ExchangeStep>,
    event?: string,
  ) {
    return deps.store.transaction(context.tenantId, async (tx) => {
      await tx.lock(value.caseId);
      const current =
        (await tx.get(value.id)) ?? fail(404, 'Exchange step not found');
      if (
        (patch.sent === false &&
          (!current.sent || current.proof?.outcome === 'passed')) ||
        (patch.proof &&
          current.proof &&
          Date.parse(patch.proof.observedAt) <
            Date.parse(current.proof.observedAt)) ||
        (patch.sent !== false &&
          !patch.proof &&
          value.sent &&
          current.proof &&
          deps.digest(current.proof) !== deps.digest(value.proof))
      )
        return current;
      const next = {
        ...current,
        ...patch,
        updatedAt: deps.now().toISOString(),
      };
      await tx.save(next);
      if (patch.sent === false && current.plan.kind === 'process') {
        const root = await tx.root(current.caseId);
        if (root)
          await tx.saveRoot({
            ...root,
            processingStarted: false,
            revision: root.revision + 1,
            updatedAt: next.updatedAt,
          });
      }
      if (event) await tx.audit(audit(context, next, event));

      return next;
    });
  }

  async function load(context: TenantContext, caseId: string, id: string) {
    const value = await deps.store.transaction(context.tenantId, (tx) =>
      tx.get(id),
    );
    if (!value || value.caseId !== caseId) fail(404, 'Exchange step not found');

    return value;
  }

  async function view(context: TenantContext, value: ExchangeStep) {
    const decision =
        value.decisionId && deps.admission
          ? await deps.admission.decision(context, value.decisionId)
          : null,
      live = Date.parse(value.expiresAt) > deps.now().getTime(),
      manage = hasPermission(context, 'returns.manage'),
      observeOnly =
        !deps.admission ||
        (await deps.admission.writeMode(context, value.connectionId)) ===
          'observe_only';

    const diff =
      (await deps.describeDiff?.(
        context,
        action(value, deps.digest),
        value.quote.observedAt,
        value.plan,
      )) ?? null;
    if (diff)
      diff.policy = decision
        ? {
            outcome: decision.outcome,
            reason: decision.reason,
            evaluatedAt: decision.evaluatedAt,
            validUntil: decision.validUntil,
            current: false,
          }
        : null;

    return {
      ...value,
      ...(diff ? { diff } : {}),
      observeOnly,
      canApprove:
        manage &&
        live &&
        !observeOnly &&
        value.state === 'approval_required' &&
        value.requestedBy !== context.actor.id &&
        hasPermission(context, 'decisions.respond') &&
        (!decision?.permission ||
          !isAppPermission(decision.permission) ||
          hasPermission(context, decision.permission)),
      canSend:
        manage &&
        live &&
        !observeOnly &&
        ['approved', 'sending'].includes(value.state) &&
        value.requestedBy === context.actor.id,
      canCheck: manage && value.sent,
    };
  }

  async function check(context: TenantContext, value: ExchangeStep) {
    if (!value.sent || !deps.system) return value;
    let proof: ExchangeProof;
    try {
      proof = await deps.system.proof(context, value);
    } catch {
      return save(context, value, {
        state: 'uncertain',
        failure: 'source_unavailable',
      });
    }
    if (!fresh(proof.observedAt, proof.evidenceRefs, value.requestedAt))
      return save(context, value, {
        state: 'uncertain',
        failure: 'stale_evidence',
      });
    const state =
      proof.outcome === 'passed'
        ? 'verified'
        : proof.outcome === 'failed'
          ? 'failed'
          : 'uncertain';
    const saved = await save(
      context,
      value,
      { proof, state, failure: state === 'failed' ? 'provider_failed' : null },
      `return.exchange.${state}`,
    );
    await deps.admission?.reconcile(context, saved).catch(() => undefined);

    return saved;
  }

  async function dispatch(context: TenantContext, value: ExchangeStep) {
    if (!deps.admission || !deps.system)
      fail(503, 'Exchange execution unavailable');
    if (value.sent && value.state !== 'sending') return check(context, value);
    if (
      !['approved', 'sending'].includes(value.state) ||
      context.actor.id !== value.requestedBy
    )
      fail(409, 'Only the requester can send this approved step');
    if (
      (await deps.admission.writeMode(context, value.connectionId)) ===
      'observe_only'
    )
      return save(context, value, {
        state: 'not_executed',
        failure: 'observe_only',
      });
    if (value.plan.kind === 'process') {
      const availability = await deps.system
        .availability(context, value.plan.replacement)
        .catch(() => null);
      if (
        !availability ||
        availability.available !== true ||
        !fresh(availability.observedAt, availability.evidenceRefs)
      )
        return save(context, value, {
          state: 'not_executed',
          failure:
            availability?.available === false
              ? 'replacement_unavailable'
              : 'availability_unknown',
        });
    }
    const current = await deps.store.transaction(
      context.tenantId,
      async (tx) => {
        const c =
            (await tx.lock(value.caseId)) ?? fail(404, 'Return case not found'),
          step =
            (await tx.get(value.id)) ?? fail(404, 'Exchange step not found'),
          root = (await tx.root(c.id)) ?? fail(404, 'Exchange not found');
        if (step.sent) return step;
        if (
          c.state !== 'open' ||
          deps.digest(facts(c)) !== step.caseDigest ||
          Date.parse(step.expiresAt) <= deps.now().getTime()
        )
          fail(409, 'Case facts or approval changed');
        if (step.plan.kind === 'process' && root.choice !== null)
          fail(409, 'Review the recorded replacement choice first');
        if (step.plan.kind === 'process' && root.processingStarted)
          fail(409, 'This exchange was already processed or sent');
        const now = deps.now().toISOString();
        await tx.saveRoot({
          ...root,
          processingStarted:
            root.processingStarted || step.plan.kind === 'process',
          revision: root.revision + 1,
          updatedAt: now,
        });
        const next: ExchangeStep = {
          ...step,
          sent: true,
          state: 'sending',
          updatedAt: now,
        };
        await tx.save(next);

        return next;
      },
    );
    try {
      const result = await deps.admission.execute(context, current);
      if (result.state === 'not_started')
        return load(context, current.caseId, current.id);
      if (result.state === 'not_executed' || result.state === 'withheld') {
        const saved = await save(context, current, {
          state: 'not_executed',
          sent: false,
          failure: 'withheld',
        });

        return saved;
      }
    } catch {
      await save(context, current, {
        state: 'uncertain',
        failure: 'response_unknown',
      });
    }

    return check(context, current);
  }

  async function admit(context: TenantContext, value: ExchangeStep) {
    if (!deps.admission) fail(503, 'Exchange approval unavailable');
    if (value.state === 'failed' && !value.sent && !value.decisionId)
      value = await save(context, value, {
        state: 'approval_required',
        failure: null,
      });
    let decision: PolicyDecision;
    try {
      decision = await deps.admission.prepare(
        context,
        value,
        action(value, deps.digest),
      );
    } catch {
      await save(context, value, {
        state: 'failed',
        failure: 'approval_unavailable',
      });
      fail(503, 'Approval could not be requested; nothing was sent');
    }
    const saved = await save(
      context,
      value,
      {
        decisionId: decision.id,
        state:
          decision.outcome === 'denied'
            ? 'not_executed'
            : decision.outcome === 'allowed'
              ? 'approved'
              : 'approval_required',
      },
      'return.exchange.requested',
    );

    return view(
      context,
      saved.state === 'approved' ? await dispatch(context, saved) : saved,
    );
  }

  async function choices(context: TenantContext, c: ReturnCase) {
    if (!deps.system) return { items: [], status: 'unavailable' as const };
    const mapped = await deps.store.transaction(context.tenantId, (tx) =>
      tx.choices(c),
    );
    if (!mapped.length) return { items: [], status: 'not_configured' as const };
    try {
      const result = await deps.system.choices(context, c.connectionId, mapped);
      if (!fresh(result.observedAt, result.evidenceRefs))
        return { items: [], status: 'unavailable' as const };

      return { items: result.items, status: 'ready' as const };
    } catch {
      return { items: [], status: 'unavailable' as const };
    }
  }

  return {
    /** Reads the operation history and current explicitly mapped replacement choices. */
    async list(context: TenantContext, caseId: string) {
      context = await authorize(context);
      const data = await deps.store.transaction(
        context.tenantId,
        async (tx) => {
          const c =
            (await tx.lock(caseId)) ?? fail(404, 'Return case not found');

          return {
            c,
            operation: await tx.root(caseId),
            steps: await tx.list(caseId),
          };
        },
      );
      const options = hasPermission(context, 'returns.manage')
        ? await choices(context, data.c)
        : { items: [], status: 'restricted' as const };

      return {
        operation: data.operation,
        steps: await Promise.all(data.steps.map((v) => view(context, v))),
        choices: options.items,
        choiceStatus: options.status,
        available: !!deps.system && !!deps.admission,
        asOf: deps.now().toISOString(),
      };
    },
    /** Creates one exact independently approved native request, process, cancellation or hold release. */
    async request(
      context: TenantContext,
      caseId: string,
      input: {
        id: string;
        operationId: string;
        kind: ExchangeStepPlan['kind'];
        replacementId?: string;
        quantity?: number;
      },
    ) {
      context = await authorize(context, true);
      if (!deps.system || !deps.admission)
        fail(503, 'Exchange execution unavailable');
      const requestDigest = deps.digest([context.actor.id, caseId, input]),
        old = await deps.store.transaction(context.tenantId, (tx) =>
          tx.get(input.id),
        );
      if (old) {
        if (old.requestDigest !== requestDigest)
          fail(409, 'This request ID was already used');

        return !old.decisionId &&
          !old.sent &&
          ['approval_required', 'failed'].includes(old.state)
          ? admit(context, old)
          : view(context, old);
      }
      const data = await deps.store.transaction(
        context.tenantId,
        async (tx) => {
          const c =
            (await tx.lock(caseId)) ?? fail(404, 'Return case not found');
          if (
            c.state !== 'open' ||
            !c.receipt ||
            !c.inspection ||
            c.proposal?.kind !== 'exchange'
          )
            fail(
              409,
              'Record receipt, inspection and an exchange proposal first',
            );

          return {
            c,
            root: await tx.root(caseId),
            steps: await tx.list(caseId),
          };
        },
      );
      const { c } = data;
      let root = data.root,
        plan: ExchangeStepPlan;
      if (root && root.id !== input.operationId)
        fail(409, 'This case already has a tracked exchange');
      if (input.kind === 'request') {
        if (root?.processingStarted)
          fail(
            409,
            'A replacement was already processed or may have been sent',
          );
        if (c.sourceReturnId && !root)
          fail(
            409,
            'The existing source return needs an owned exchange handoff',
          );
        if (root) {
          const previousRequest = data.steps.find(
            (s) => s.id === root!.currentAttemptId,
          );
          const unsent =
            previousRequest &&
            !previousRequest.sent &&
            (['rejected', 'failed', 'expired', 'not_executed'].includes(
              previousRequest.state,
            ) ||
              Date.parse(previousRequest.expiresAt) <= deps.now().getTime());
          const cancelled = data.steps.find(
            (s) =>
              s.plan.kind === 'cancel' &&
              'marker' in s.plan &&
              s.plan.marker === root!.request.marker &&
              s.state === 'verified' &&
              s.proof &&
              fresh(s.proof.observedAt, s.proof.evidenceRefs),
          );
          if (!unsent && (root.choice?.kind !== 'different_item' || !cancelled))
            fail(
              409,
              'Cancel and freshly verify the previous replacement intent first',
            );
        }
        const option =
          (await choices(context, c)).items.find(
            (v) => v.id === input.replacementId,
          ) ?? fail(409, 'Choose an explicitly mapped replacement');
        if (
          root?.choice?.kind === 'different_item' &&
          canonicalJson(option.inventoryItem) ===
            canonicalJson(root.request.replacement.inventoryItem)
        )
          fail(409, 'Choose a different replacement item');
        if (
          !input.quantity ||
          !Number.isSafeInteger(input.quantity) ||
          input.quantity < 1 ||
          input.quantity > c.receipt!.lines.reduce((n, l) => n + l.received, 0)
        )
          fail(
            409,
            'Choose a whole replacement quantity within the received units',
          );
        const ids = await deps.cases.transaction(
          context.tenantId,
          false,
          (tx) =>
            tx.sourceIds(
              c.connectionId,
              c.orderId,
              c.lines.map((l) => l.orderLineId),
            ),
        );
        if (!ids.order) fail(409, 'The source order is not mapped');
        const replacement: ExchangeReplacement = {
          skuId: option.skuId,
          mappingIds: option.mappingIds,
          inventoryItem: option.inventoryItem,
          variantId: option.variantId,
          wawiConnectionId: option.wawiConnectionId,
          item: option.item,
          quantity: input.quantity,
        };
        plan = {
          kind: 'request',
          marker: `luma-ex:${input.operationId}:${input.id}`,
          order: ids.order,
          lines: c
            .receipt!.lines.filter((l) => l.received > 0)
            .map((l) => ({
              orderLineId: l.orderLineId,
              source:
                ids.lines.get(l.orderLineId) ??
                fail(409, 'The returned line is not mapped'),
              quantity: l.received,
              reason: 'OTHER',
            })),
          replacement,
        };
        root = {
          id: input.operationId,
          tenantId: context.tenantId,
          caseId,
          connectionId: c.connectionId,
          startedBy: root?.startedBy ?? context.actor.id,
          startedAt: root?.startedAt ?? deps.now().toISOString(),
          ownerId: c.assigneeId ?? c.openedBy,
          revision: (root?.revision ?? 0) + 1,
          choice: null,
          currentAttemptId: input.id,
          replacementName: option.label,
          request: plan,
          availability: null,
          processingStarted: false,
          updatedAt: deps.now().toISOString(),
        };
      } else {
        if (!root) fail(409, 'Request the replacement first');
        const requested = data.steps.find(
          (s) => s.id === root!.currentAttemptId,
        );
        if (
          !requested?.proof?.returnId ||
          requested.state !== 'verified' ||
          !fresh(requested.proof.observedAt, requested.proof.evidenceRefs)
        )
          fail(409, 'Freshly verify the exact source replacement intent first');
        if (input.kind === 'process') {
          if (
            root.processingStarted ||
            (root.choice && root.choice.kind !== 'wait')
          )
            fail(
              409,
              'Review the existing processed replacement or recorded choice',
            );
          if (!requested.proof.processLines || !requested.proof.financial)
            fail(
              409,
              'Fresh processable lines and a financial quote are required',
            );
          const availability = await deps.system
            .availability(context, root.request.replacement)
            .catch(() => null);
          if (
            !availability ||
            availability.available !== true ||
            !fresh(availability.observedAt, availability.evidenceRefs)
          )
            await deps.store.transaction(context.tenantId, async (tx) => {
              await tx.lock(caseId);
              const current = await tx.root(caseId);
              if (!current || current.revision !== root!.revision)
                fail(409, 'The exchange changed while reading availability');
              if (
                availability &&
                fresh(availability.observedAt, availability.evidenceRefs)
              )
                await tx.saveRoot({
                  ...current,
                  availability,
                  revision: current.revision + 1,
                  updatedAt: deps.now().toISOString(),
                });
            });
          if (
            !availability ||
            availability.available !== true ||
            !fresh(availability.observedAt, availability.evidenceRefs)
          )
            fail(
              409,
              'Replacement unavailable or unknown; record wait, different item or refund',
            );
          root = {
            ...root,
            availability,
            choice: null,
            revision: root.revision + 1,
            updatedAt: deps.now().toISOString(),
          };
          plan = {
            kind: 'process',
            marker: root.request.marker,
            order: root.request.order,
            returnId: requested.proof.returnId,
            returnLines: requested.proof.processLines.returnLines,
            exchangeLine: requested.proof.processLines.exchangeLine,
            replacement: root.request.replacement,
            financial: requested.proof.financial,
          };
        } else if (input.kind === 'cancel') {
          if (
            root.processingStarted ||
            !root.choice ||
            root.choice.kind === 'wait'
          )
            fail(
              409,
              'Only a pristine intent with a recorded different-item or refund choice can be cancelled',
            );
          plan = {
            kind: 'cancel',
            marker: root.request.marker,
            order: root.request.order,
            returnId: requested.proof.returnId,
            lines: root.request.lines,
            replacement: root.request.replacement,
          };
        } else {
          const processed = data.steps.find(
            (s) => s.plan.kind === 'process' && s.sent,
          );
          if (
            !processed?.proof ||
            processed.state !== 'verified' ||
            !fresh(processed.proof.observedAt, processed.proof.evidenceRefs) ||
            !processed.proof.fulfillmentOrderId ||
            !processed.proof.paymentHoldId ||
            !['paid', 'not_required'].includes(processed.proof.payment) ||
            processed.plan.kind !== 'process'
          )
            fail(
              409,
              'Freshly verify replacement fulfillment and actual payment before releasing its hold',
            );
          plan = {
            kind: 'release',
            marker: processed.plan.marker,
            returnLines: processed.plan.returnLines,
            exchangeLine: processed.plan.exchangeLine,
            replacement: processed.plan.replacement,
            order: root.request.order,
            returnId: requested.proof.returnId,
            fulfillmentOrderId: processed.proof.fulfillmentOrderId,
            holdId: processed.proof.paymentHoldId,
            financial: processed.plan.financial,
          };
        }
      }
      const quoted = await deps.system
        .quote(context, c.connectionId, { operationId: root.id, plan })
        .catch(() =>
          fail(
            503,
            'Fresh source exchange evidence is unavailable; nothing was sent',
          ),
        );
      if (
        plan.kind === 'process' &&
        !quoted.available &&
        fresh(quoted.observedAt, quoted.evidenceRefs)
      ) {
        await deps.store.transaction(context.tenantId, async (tx) => {
          await tx.lock(caseId);
          const current = await tx.root(caseId);
          if (!current || current.revision !== data.root?.revision)
            fail(409, 'The exchange changed while checking stock');
          await tx.saveRoot({
            ...current,
            availability: {
              available: false,
              observedAt: quoted.observedAt,
              evidenceRefs: quoted.evidenceRefs,
            },
            revision: current.revision + 1,
            updatedAt: deps.now().toISOString(),
          });
        });
        fail(
          409,
          'The replacement is unavailable; choose wait, a different item or refund',
        );
      }
      if (
        !fresh(quoted.observedAt, quoted.evidenceRefs) ||
        quoted.plan.kind !== plan.kind ||
        canonicalJson(quoted.plan) !== canonicalJson(plan)
      )
        fail(
          409,
          'The source plan changed; refresh the exact exchange evidence',
        );
      const now = deps.now(),
        value: ExchangeStep = {
          id: input.id,
          intentVersion: 2,
          actionId: deps.uuid(
            `return-exchange:${context.tenantId}:${input.id}`,
          ),
          operationId: root.id,
          tenantId: context.tenantId,
          caseId,
          connectionId: c.connectionId,
          plan: quoted.plan,
          caseDigest: deps.digest(facts(c)),
          requestDigest,
          quote: {
            observedAt: quoted.observedAt,
            evidenceRefs: quoted.evidenceRefs,
          },
          requestedBy: context.actor.id,
          requestedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 24 * 3600_000).toISOString(),
          decisionId: null,
          decidedBy: null,
          decidedAt: null,
          state: 'approval_required',
          sent: false,
          proof: null,
          failure: null,
          updatedAt: now.toISOString(),
        };
      const preparedRoot = root;
      await deps.store.transaction(context.tenantId, async (tx) => {
        const latest =
          (await tx.lock(caseId)) ?? fail(404, 'Return case not found');
        if (deps.digest(facts(latest)) !== value.caseDigest)
          fail(409, 'The case changed while reading the systems');
        const current = await tx.root(caseId);
        if ((current?.revision ?? 0) !== (data.root?.revision ?? 0))
          fail(409, 'The exchange changed while reading the systems');
        for (const previous of await tx.list(caseId))
          if (
            previous.plan.kind === input.kind &&
            ('marker' in previous.plan
              ? previous.plan.marker === preparedRoot.request.marker
              : true)
          ) {
            if (
              previous.sent ||
              (['approval_required', 'approved', 'sending'].includes(
                previous.state,
              ) &&
                Date.parse(previous.expiresAt) > now.getTime())
            )
              fail(409, 'This exchange step was already requested or sent');
            if (['approval_required', 'approved'].includes(previous.state))
              await tx.save({
                ...previous,
                state: 'expired',
                updatedAt: now.toISOString(),
              });
          }
        await tx.saveRoot(preparedRoot);
        await tx.insert(value);
        await tx.audit(audit(context, value, 'return.exchange.quoted'));
      });

      return admit(context, value);
    },
    /** Records an owner's explicit availability choice; it never substitutes, cancels or refunds on its own. */
    async choose(
      context: TenantContext,
      caseId: string,
      input: { revision: number; kind: 'wait' | 'different_item' | 'refund' },
    ) {
      context = await authorize(context, true);

      return deps.store.transaction(context.tenantId, async (tx) => {
        const c = (await tx.lock(caseId)) ?? fail(404, 'Return case not found'),
          root = (await tx.root(caseId)) ?? fail(404, 'Exchange not found');
        if (
          c.state !== 'open' ||
          root.revision !== input.revision ||
          root.processingStarted
        )
          fail(409, 'This exchange changed or processing has started');
        const now = deps.now().toISOString(),
          next = {
            ...root,
            ownerId: c.assigneeId ?? c.openedBy,
            choice: { kind: input.kind, by: context.actor.id, at: now },
            revision: root.revision + 1,
            updatedAt: now,
          };
        await tx.saveRoot(next);
        const step = (await tx.list(caseId)).find(
          (s) => s.id === root.currentAttemptId,
        );
        if (step)
          await tx.audit(
            audit(
              context,
              { ...step, updatedAt: now },
              `return.exchange.choice.${input.kind}`,
            ),
          );

        return next;
      });
    },
    /** Independently checks both systems, completes only consistent cases and reopens a failed later check. */
    async complete(context: TenantContext, caseId: string) {
      context = await authorize(context, true);
      const data = await deps.store.transaction(
        context.tenantId,
        async (tx) => {
          const value =
            (await tx.lock(caseId)) ?? fail(404, 'Return case not found');
          const root =
            (await tx.root(caseId)) ?? fail(404, 'Exchange not found');
          if (
            value.state === 'cancelled' ||
            value.proposal?.kind !== 'exchange'
          )
            fail(409, 'This case does not have an active exchange');
          const steps = await tx.list(caseId);

          return {
            value,
            root,
            process:
              steps.find((s) => s.plan.kind === 'process' && s.sent) ?? null,
            actions: await tx.stockActions(caseId),
          };
        },
      );
      if (!deps.system?.consistency)
        fail(503, 'Exchange consistency unavailable');
      const evidence = await deps.system.consistency(
        context,
        data.value,
        data.root,
        data.process,
        data.actions,
      );
      context = await authorize(context, true);

      return deps.store.transaction(context.tenantId, async (tx) => {
        const value =
            (await tx.lock(caseId)) ?? fail(404, 'Return case not found'),
          root = (await tx.root(caseId)) ?? fail(404, 'Exchange not found');
        if (
          value.revision !== data.value.revision ||
          root.revision !== data.root.revision
        )
          fail(
            409,
            'The exchange changed while its systems were read. Check again.',
          );
        const choices = await tx.choices(value);
        if (
          !choices.some(
            (c) =>
              c.skuId === root.request.replacement.skuId &&
              c.wawiConnectionId ===
                root.request.replacement.wawiConnectionId &&
              deps.digest(c.mappingIds) ===
                deps.digest(root.request.replacement.mappingIds),
          )
        ) {
          evidence.shopify = null;
          evidence.wawi = null;
        }
        const currentProcess = data.process
          ? await tx.get(data.process.id)
          : null;
        // A concurrent source check may have learned more while the remaining systems were read.
        if (
          evidence.shopify &&
          currentProcess?.proof &&
          Date.parse(currentProcess.proof.observedAt) >
            Date.parse(evidence.shopify.observedAt)
        )
          evidence.shopify = currentProcess.proof;
        const at = deps.now(),
          report = exchangeConsistency(value, root, data.process, evidence, at);
        const next = {
          ...root,
          completion: report,
          ownerId: value.assigneeId ?? value.openedBy,
          revision: root.revision + 1,
          updatedAt: at.toISOString(),
        };
        await tx.saveRoot(next);
        if (
          data.process &&
          evidence.shopify &&
          fresh(
            evidence.shopify.observedAt,
            evidence.shopify.evidenceRefs,
            data.process.requestedAt,
          )
        ) {
          if (
            currentProcess &&
            (!currentProcess.proof ||
              Date.parse(currentProcess.proof.observedAt) <=
                Date.parse(evidence.shopify.observedAt))
          ) {
            const state =
              evidence.shopify.outcome === 'passed'
                ? 'verified'
                : evidence.shopify.outcome === 'failed'
                  ? 'failed'
                  : 'uncertain';
            const step = {
              ...currentProcess,
              proof: evidence.shopify,
              state,
              failure: state === 'failed' ? 'provider_failed' : null,
              updatedAt: report.checkedAt,
            } satisfies ExchangeStep;
            await tx.save(step);
            await tx.audit(audit(context, step, `return.exchange.${state}`));
          }
        }
        const state = report.state === 'verified' ? 'completed' : 'open';
        if (state !== value.state) {
          const updated = {
            ...value,
            state,
            revision: value.revision + 1,
            updatedAt: report.checkedAt,
          } satisfies ReturnCase;
          await tx.finishCase(updated, {
            id: deps.uuid(`exchange-check-event:${root.id}:${next.revision}`),
            tenantId: context.tenantId,
            caseId,
            commandId: deps.uuid(
              `exchange-check-command:${root.id}:${next.revision}`,
            ),
            digest: deps.digest(report),
            kind:
              state === 'completed'
                ? 'exchange_completed'
                : 'exchange_reopened',
            actorId: context.actor.id,
            revision: updated.revision,
            occurredAt: report.checkedAt,
            evidence: null,
            details: {
              reason: report.checks
                .filter((c) => !c.verified)
                .map((c) => c.id)
                .join(', '),
            },
          });
        }
        await tx.audit({
          id: deps.uuid(`exchange-check-audit:${root.id}:${next.revision}`),
          tenantId: context.tenantId,
          eventKey: `orders:exchange-consistency:${root.id}:${next.revision}`,
          eventType: `return.exchange.consistency.${report.state}`,
          schemaVersion: 1,
          occurredAt: report.checkedAt,
          actor: { kind: 'user', id: context.actor.id },
          correlationId: caseId,
          proposalId: root.id,
          actionHash: deps.digest(report),
          evidenceRefs: report.evidenceRefs,
          details: {
            operationId: root.id,
            ownerId: report.ownerId,
            checks: JSON.stringify(report.checks),
          },
        });

        return report;
      });
    },

    /** Converts only a freshly cancelled, unprocessed exchange to the existing governed refund path. */
    async fallbackRefund(
      context: TenantContext,
      caseId: string,
      revision: number,
    ) {
      context = await authorize(context, true);

      return deps.store.transaction(context.tenantId, async (tx) => {
        const c = (await tx.lock(caseId)) ?? fail(404, 'Return case not found'),
          root = (await tx.root(caseId)) ?? fail(404, 'Exchange not found');
        if (
          root.revision !== revision ||
          root.processingStarted ||
          root.choice?.kind !== 'refund' ||
          c.state !== 'open'
        )
          fail(
            409,
            'Record the refund choice before cancelling the pristine source intent',
          );
        if (c.proposal?.kind === 'refund') return { caseId };
        if (c.proposal?.kind !== 'exchange')
          fail(409, 'This case no longer proposes an exchange');
        const step = (await tx.list(caseId)).find(
          (s) =>
            s.plan.kind === 'cancel' &&
            s.plan.marker === root.request.marker &&
            s.state === 'verified' &&
            s.proof &&
            fresh(s.proof.observedAt, s.proof.evidenceRefs),
        );
        if (!step) fail(409, 'Freshly verify cancellation first');
        const at = deps.now().toISOString();
        await tx.refundFallback(c, {
          id: deps.uuid(`exchange-refund-event:${root.id}`),
          tenantId: context.tenantId,
          caseId,
          commandId: root.id,
          digest: deps.digest([root.id, c.proposal, 'refund']),
          kind: 'resolution_proposed',
          actorId: context.actor.id,
          revision: c.revision + 1,
          occurredAt: at,
          evidence: c.proposal?.evidence ?? null,
          details: { resolution: 'refund', lines: c.proposal?.lines ?? [] },
        });
        await tx.audit(audit(context, step, 'return.exchange.refund_handoff'));

        return { caseId };
      });
    },
    /** Responds to the frozen decision and executes with the current requester's authority. */
    async decide(
      context: TenantContext,
      caseId: string,
      id: string,
      input: { decisionId: string; outcome: 'approved' | 'rejected' },
    ) {
      context = await authorize(context, true);
      const value = await load(context, caseId, id);
      if (
        !deps.admission ||
        !(await view(context, value)).canApprove ||
        input.decisionId !== value.decisionId
      )
        fail(409, 'This request needs a current independent approver');
      await deps.admission.respond(
        context,
        input.decisionId,
        input.outcome,
        value.expiresAt,
      );
      let saved = await save(
        context,
        value,
        {
          state: input.outcome,
          decidedBy: context.actor.id,
          decidedAt: deps.now().toISOString(),
        },
        `return.exchange.${input.outcome}`,
      );
      if (saved.state === 'approved') {
        const principal = await deps
          .principal(
            saved.requestedBy,
            context.tenantId,
            `return-exchange:${id}`,
          )
          .catch(() => null);
        if (principal) saved = await dispatch(principal, saved);
      }

      return view(context, saved);
    },
    /** Resumes the same durable execution; sent uncertain effects are reconciled, never replaced. */
    async send(context: TenantContext, caseId: string, id: string) {
      context = await authorize(context, true);

      return view(
        context,
        await dispatch(context, await load(context, caseId, id)),
      );
    },
    /** Independently checks current native records and payment; this method sends no provider write. */
    async check(context: TenantContext, caseId: string, id: string) {
      context = await authorize(context, true);

      return view(
        context,
        await check(context, await load(context, caseId, id)),
      );
    },
    /** Refreshes an already sent operation for owned monitoring; it cannot request or dispatch a write. */
    async observe(context: TenantContext, caseId: string, id: string) {
      context = await authorize(context);
      const value = await check(context, await load(context, caseId, id));
      if (
        ['source_unavailable', 'stale_evidence'].includes(value.failure ?? '')
      )
        throw new Error('Fresh financial proof unavailable');

      return value.proof;
    },
    /** Resolves only an exact tenant-owned execution intent. */
    async forAction(context: TenantContext, id: string) {
      context = await authorize(context, true);
      const value = await deps.store.transaction(context.tenantId, (tx) =>
        tx.get(id),
      );

      return value ? { value, action: action(value, deps.digest) } : null;
    },
    /** Rechecks current facts, mappings, root choice and trusted requester before dispatch. */
    async eligible(
      context: TenantContext,
      step: { subject?: { kind: string; id: string }; action: ProposedAction },
    ) {
      try {
        context = await authorize(context, true);
      } catch {
        return false;
      }
      if (step.subject?.kind !== 'return_case_exchange') return false;
      const candidate = await deps.store.transaction(context.tenantId, (tx) =>
        tx.get(step.subject!.id),
      );
      if (candidate?.plan.kind === 'process') {
        const availability = await deps.system
          ?.availability(context, candidate.plan.replacement)
          .catch(() => null);
        if (
          !availability ||
          availability.available !== true ||
          !fresh(availability.observedAt, availability.evidenceRefs)
        )
          return false;
      }

      return deps.store.transaction(context.tenantId, async (tx) => {
        const value = await tx.get(step.subject!.id);
        if (!value || value.requestedBy !== context.actor.id) return false;
        const c = await tx.lock(value.caseId),
          root = await tx.root(value.caseId);
        if (
          !c ||
          !root ||
          c.state !== 'open' ||
          deps.digest(facts(c)) !== value.caseDigest ||
          Date.parse(value.expiresAt) <= deps.now().getTime() ||
          !['approval_required', 'approved', 'sending'].includes(value.state) ||
          canonicalJson(action(value, deps.digest)) !==
            canonicalJson(step.action)
        )
          return false;
        if ('marker' in value.plan && value.plan.marker !== root.request.marker)
          return false;
        if (value.plan.kind === 'process' && root.choice) return false;
        if (
          value.plan.kind === 'cancel' &&
          (!root.choice ||
            root.choice.kind === 'wait' ||
            root.processingStarted)
        )
          return false;
        const ids = await deps.cases.transaction(context.tenantId, false, (t) =>
          t.sourceIds(
            c.connectionId,
            c.orderId,
            c.lines.map((l) => l.orderLineId),
          ),
        );
        if (
          canonicalJson(ids.order) !== canonicalJson(root.request.order) ||
          root.request.lines.some(
            (l) =>
              canonicalJson(ids.lines.get(l.orderLineId)) !==
              canonicalJson(l.source),
          )
        )
          return false;
        const replacement =
          'replacement' in value.plan
            ? value.plan.replacement
            : root.request.replacement;
        const mapped = (await tx.choices(c)).some(
          (o) =>
            canonicalJson([
              o.skuId,
              o.mappingIds,
              o.inventoryItem,
              o.wawiConnectionId,
              o.item,
            ]) ===
            canonicalJson([
              replacement.skuId,
              replacement.mappingIds,
              replacement.inventoryItem,
              replacement.wawiConnectionId,
              replacement.item,
            ]),
        );

        return mapped;
      });
    },
    /** Supplies fresh independent evidence to the execution engine without altering business state. */
    async verify(context: TenantContext, id: string) {
      const value = await deps.store.transaction(context.tenantId, (tx) =>
        tx.get(id),
      );
      if (!value || !deps.system)
        return { outcome: 'inconclusive' as const, observationRefs: [] };
      const proof = await deps.system.proof(context, value);
      const current = fresh(
        proof.observedAt,
        proof.evidenceRefs,
        value.requestedAt,
      );

      return {
        outcome: current ? proof.outcome : ('inconclusive' as const),
        observationRefs: current ? proof.evidenceRefs : [],
      };
    },
  };
}

export type ReturnExchanges = ReturnType<typeof createReturnExchanges>;

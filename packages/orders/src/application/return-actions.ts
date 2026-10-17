import type { AuditEntry } from '@luma/audit';
import type { ActionDiff } from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import {
  hasPermission,
  isAppPermission,
  requirePermission,
  requireTenant,
} from '@luma/identity';
import { canonicalJson, forbidden, ServiceError } from '@luma/platform';
import type { PolicyDecision, ProposedAction } from '@luma/policies';

import type {
  ReturnAction,
  ReturnActionPlan,
  ReturnActionProof,
} from '../domain/return-actions.js';
import type { ReturnCase } from '../domain/return-cases.js';
import type { SourceRef } from '../domain/return-creations.js';
import {
  citedReads,
  completeReads,
  type ReturnRead,
  type ReturnReadEvidence,
  returnReadEvidence,
} from '../domain/return-reads.js';
import { returnRecoveryStep } from '../domain/return-recovery.js';
import type {
  CreationExecution,
  ReturnCaseDependencies,
  ReturnCaseStore,
} from './return-cases.js';

/** One explicit mapping from a case line's canonical SKU to a Wawi warehouse position. */
export interface ReturnStockTarget {
  id: string;
  orderLineId: string;
  connectionId: string;
  label: string;
  item: SourceRef;
  warehouse: SourceRef;
  mappingIds: string[];
}

/** Tenant-owned settlement persistence; mutations serialize with case decisions. */
export interface ReturnActionStore {
  /** Runs one tenant transaction; `readOnlySnapshot` gives reads one consistent view without locks. */
  transaction<T>(
    tenantId: string,
    fn: (tx: {
      /** Reads the case after taking its order lock and row lock; use only before writes. */
      lock(caseId: string): Promise<ReturnCase | null>;
      /** Reads the case without locks, so polling does not wait for or block writers. */
      read(caseId: string): Promise<ReturnCase | null>;
      get(id: string): Promise<ReturnAction | null>;
      list(caseId: string): Promise<ReturnAction[]>;
      /** One requester's writes that may need a background step, oldest first, at most 100. */
      live(requestedBy: string): Promise<ReturnAction[]>;
      save(value: ReturnAction): Promise<void>;
      insert(value: ReturnAction): Promise<void>;
      targets(
        value: ReturnCase,
      ): Promise<Omit<ReturnStockTarget, 'warehouse'>[]>;
      audit(entry: AuditEntry): Promise<void>;
      /** Stores a cited provider read; an already stored read is kept unchanged. */
      recordRead(evidence: ReturnReadEvidence): Promise<void>;
    }) => Promise<T>,
    options?: { readOnlySnapshot: true },
  ): Promise<T>;
}

/** A fresh settlement proof with the provider reads its `evidenceRefs` name. */
export type ReturnActionProofRead = Omit<ReturnActionProof, 'complete'> & {
  reads: ReturnRead[];
};

/** Installed source reads; quoting and verification never write to providers. */
export interface ReturnSettlementSystem {
  warehouses(
    context: TenantContext,
    connectionId: string,
  ): Promise<(SourceRef & { name: string | null })[]>;
  quote(
    context: TenantContext,
    connectionId: string,
    input:
      | {
          kind: 'refund';
          order: SourceRef;
          lines: { orderLine: SourceRef; quantity: number }[];
        }
      | {
          kind: 'restock';
          item: SourceRef;
          warehouse: SourceRef;
          quantity: number;
        },
  ): Promise<{
    plan: ReturnActionPlan;
    observedAt: string;
    evidenceRefs: string[];
    /** The reads `evidenceRefs` names. */
    reads: ReturnRead[];
  }>;
  proof(
    context: TenantContext,
    action: ReturnAction,
  ): Promise<ReturnActionProofRead>;
}

/** Binds a settlement to shared policy, independent approval, admission and execution. */
export interface ReturnSettlementAdmission {
  prepare(
    context: TenantContext,
    value: ReturnAction,
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
    value: ReturnAction,
  ): Promise<CreationExecution>;
  reconcile(
    context: TenantContext,
    value: ReturnAction,
  ): Promise<CreationExecution>;
  /** The execution ledger's record; `not_started` means nothing was reserved or dispatched. */
  get(context: TenantContext, value: ReturnAction): Promise<CreationExecution>;
  writeMode(
    context: TenantContext,
    id: string,
  ): Promise<'observe_only' | 'writes_enabled'>;
}

interface Dependencies extends Pick<
  ReturnCaseDependencies,
  'refreshContext' | 'principal' | 'digest' | 'uuid' | 'now'
> {
  cases: ReturnCaseStore;
  store: ReturnActionStore;
  system: ReturnSettlementSystem | null;
  admission: ReturnSettlementAdmission | null;
  /** Optional shared review supplied by runtime composition for the immutable owner plan. */
  describeDiff?: (
    context: TenantContext,
    action: ProposedAction,
    observedAt: string,
    plan: ReturnActionPlan,
  ) => Promise<ActionDiff | null>;
}

function fail(status: 404 | 409 | 503, message: string): never {
  throw new ServiceError(
    status,
    status === 404
      ? 'NOT_FOUND'
      : status === 409
        ? 'CONFLICT'
        : 'SERVICE_UNAVAILABLE',
    message,
  );
}

const facts = (value: ReturnCase) => [
  value.state,
  value.connectionId,
  value.lines,
  value.receipt,
  value.inspection,
  value.proposal,
];

/** Immutable Action Admission intent for a case's stock or financial step. */
function returnSettlementAction(
  value: ReturnAction,
  digest: (value: unknown) => string,
): ProposedAction {
  return {
    schemaVersion: 1,
    id: value.actionId,
    tenantId: value.tenantId,
    capability: `returns.${value.kind}`,
    capabilityVersion: '0',
    connectionId: value.connectionId,
    target: { kind: 'return_case_settlement', id: value.id },
    parameters: {
      ...(value.intentVersion === 2
        ? { planDigest: digest(value.plan) }
        : { plan: canonicalJson(value.plan) }),
      caseDigest: value.caseDigest,
    },
    preconditions: {
      evidenceRefs: [value.caseId, ...value.quote.evidenceRefs],
      validUntil: value.expiresAt,
    },
    expectedPostcondition: { operationId: value.id, kind: value.kind },
    risk: 'high',
    proposedBy: { kind: 'user', id: value.requestedBy },
    expiresAt: value.expiresAt,
  };
}

/** Composes separately governed physical and financial steps. Checking uncertain writes never sends again. */
export function createReturnActions(deps: Dependencies) {
  async function authorize(context: TenantContext, write = false) {
    requireTenant(context, context.tenantId);
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    if (fresh.actor.id !== context.actor.id)
      throw forbidden('Sign in again to continue');
    requirePermission(fresh, write ? 'returns.manage' : 'returns.read');

    return fresh;
  }

  async function choices(context: TenantContext, c: ReturnCase) {
    if (
      !deps.system ||
      !c.proposal ||
      !c.proposal.lines.some((l) => l.restock > 0)
    )
      return { targets: [], targetStatus: 'not_required' as const };
    let unavailable = false;
    const items = await deps.store.transaction(context.tenantId, (tx) =>
      tx.targets(c),
    );
    const warehouses = new Map<
      string,
      (SourceRef & { name: string | null })[]
    >();
    for (const connectionId of new Set(items.map((i) => i.connectionId))) {
      try {
        warehouses.set(
          connectionId,
          await deps.system.warehouses(context, connectionId),
        );
      } catch {
        unavailable = true;
        warehouses.set(connectionId, []);
      }
    }

    const targets = items.flatMap((item) =>
      (warehouses.get(item.connectionId) ?? []).map((warehouse) => ({
        ...item,
        id: `${item.id}:${warehouse.externalId}`,
        label: `${item.label} · ${warehouse.name ?? warehouse.externalId}`,
        warehouse: {
          externalId: warehouse.externalId,
          scopeKey: warehouse.scopeKey,
        },
      })),
    );

    return {
      targets,
      targetStatus: unavailable
        ? ('unavailable' as const)
        : targets.length
          ? ('ready' as const)
          : ('not_configured' as const),
    };
  }

  async function load(context: TenantContext, caseId: string, id: string) {
    const value = await deps.store.transaction(context.tenantId, (tx) =>
      tx.get(id),
    );
    if (!value || value.caseId !== caseId) fail(404, 'Return action not found');

    return value;
  }

  async function view(context: TenantContext, value: ReturnAction) {
    const decision =
      value.decisionId && deps.admission
        ? await deps.admission.decision(context, value.decisionId)
        : null;
    const permission = decision?.permission;
    const live = Date.parse(value.expiresAt) > deps.now().getTime();
    const manage = hasPermission(context, 'returns.manage');
    const observeOnly =
      !deps.admission ||
      (await deps.admission.writeMode(context, value.connectionId)) ===
        'observe_only';

    const diff =
      (await deps.describeDiff?.(
        context,
        returnSettlementAction(value, deps.digest),
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
      // An unsent approval ends with its window; the background pass records it soon after.
      state:
        !live &&
        !value.sent &&
        ['approval_required', 'approved'].includes(value.state)
          ? ('expired' as const)
          : value.state,
      ...(diff ? { diff } : {}),
      canApprove:
        manage &&
        live &&
        !observeOnly &&
        value.state === 'approval_required' &&
        value.requestedBy !== context.actor.id &&
        hasPermission(context, 'decisions.respond') &&
        (!permission ||
          !isAppPermission(permission) ||
          hasPermission(context, permission)),
      canSend:
        manage &&
        live &&
        !observeOnly &&
        ['approved', 'sending'].includes(value.state) &&
        value.requestedBy === context.actor.id,
      canCheck: manage && value.sent,
      observeOnly,
    };
  }

  /** The stored evidence for a read a settlement cites. */
  function evidence(value: ReturnAction, read: ReturnRead) {
    return returnReadEvidence(
      value.tenantId,
      value.caseId,
      { purpose: 'settlement', id: value.id },
      read,
    );
  }

  /**
   * Applies a patch unless a newer proof or send fence supersedes it. `reads` are the provider
   * reads the patch cites; they are stored in the same transaction.
   */
  async function save(
    context: TenantContext,
    value: ReturnAction,
    patch: Partial<ReturnAction>,
    event?: string,
    reads: ReturnRead[] = [],
  ) {
    return deps.store.transaction(context.tenantId, async (tx) => {
      await tx.lock(value.caseId);
      const current =
        (await tx.get(value.id)) ?? fail(404, 'Return action not found');
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
      for (const read of reads) await tx.recordRead(evidence(next, read));
      await tx.save(next);
      if (event) await tx.audit(auditEntry(context, next, event));

      return next;
    });
  }

  /**
   * Accepts a fresh proof only when every reference names a returned read; a partial read
   * cannot pass. Returns null when the proof cannot be cited.
   */
  function citedProof(value: ReturnAction, read: ReturnActionProofRead) {
    const time = Date.parse(read.observedAt);
    const reads = citedReads(read.evidenceRefs, read.reads);
    if (
      !reads ||
      !read.evidenceRefs.length ||
      !Number.isFinite(time) ||
      time < Date.parse(value.requestedAt) ||
      time > deps.now().getTime() ||
      deps.now().getTime() - time > 300_000
    )
      return null;
    const complete = completeReads(reads);
    const proof: ReturnActionProof = {
      outcome:
        read.outcome === 'passed' && !complete ? 'inconclusive' : read.outcome,
      payment: read.payment,
      observedAt: read.observedAt,
      evidenceRefs: read.evidenceRefs,
      complete,
    };

    return { proof, reads };
  }

  function auditEntry(
    context: TenantContext,
    value: ReturnAction,
    event: string,
  ): AuditEntry {
    const occurrence = deps.digest([value.updatedAt, value.proof]);

    return {
      id: deps.uuid(
        `return-settlement-audit:${value.id}:${event}:${occurrence}`,
      ),
      tenantId: context.tenantId,
      eventKey: `orders:${event}:${value.id}:${occurrence}`,
      eventType: event,
      schemaVersion: 1,
      occurredAt: value.updatedAt,
      actor: { kind: 'user', id: context.actor.id },
      evidenceRefs: value.proof?.evidenceRefs ?? value.quote.evidenceRefs,
      correlationId: value.caseId,
      proposalId: value.actionId,
      actionHash: deps.digest(returnSettlementAction(value, deps.digest)),
      details: { kind: value.kind, caseId: value.caseId },
    };
  }

  async function check(context: TenantContext, value: ReturnAction) {
    if (!value.sent || !deps.system) return value;
    let read: ReturnActionProofRead;
    try {
      read = await deps.system.proof(context, value);
    } catch {
      return save(context, value, {
        state: 'uncertain',
        failure: 'source_unavailable',
      });
    }
    const cited = citedProof(value, read);
    if (!cited)
      return save(context, value, {
        state: 'uncertain',
        failure: 'stale_evidence',
      });
    const { proof } = cited;
    const state =
      proof.outcome === 'passed'
        ? 'verified'
        : proof.outcome === 'failed'
          ? 'failed'
          : proof.payment === 'pending' || proof.payment === 'partial'
            ? 'pending'
            : 'uncertain';
    const result = await save(
      context,
      value,
      {
        proof,
        state,
        failure: proof.outcome === 'failed' ? 'provider_failed' : null,
      },
      state === 'verified' ? 'return.settlement.verified' : undefined,
      cited.reads,
    );
    await deps.admission?.reconcile(context, result).catch(() => undefined);

    return result;
  }

  async function dispatch(context: TenantContext, value: ReturnAction) {
    if (!deps.admission) fail(503, 'Return execution is unavailable');
    if (value.sent && value.state !== 'sending') return check(context, value);
    if (
      !['approved', 'sending'].includes(value.state) ||
      context.actor.id !== value.requestedBy
    )
      fail(409, 'Only the requester can send the approved action');
    if (
      (await deps.admission.writeMode(context, value.connectionId)) ===
      'observe_only'
    )
      return save(context, value, {
        state: 'not_executed',
        failure: 'observe_only',
      });
    const current = await deps.store.transaction(
      context.tenantId,
      async (tx) => {
        const c =
          (await tx.lock(value.caseId)) ?? fail(404, 'Return case not found');
        const action =
          (await tx.get(value.id)) ?? fail(404, 'Return action not found');
        if (action.sent) return action;
        if (
          c.state !== 'open' ||
          deps.digest(facts(c)) !== action.caseDigest ||
          Date.parse(action.expiresAt) <= deps.now().getTime()
        )
          fail(409, 'Case facts or approval changed');
        const next: ReturnAction = {
          ...action,
          sent: true,
          state: 'sending',
          updatedAt: deps.now().toISOString(),
        };
        await tx.save(next);

        return next;
      },
    );
    // Durable sent fencing survives a lost response or worker restart. Execution owns dispatch deduplication.
    try {
      const result = await deps.admission.execute(context, current);
      if (result.state === 'not_started')
        return load(context, current.caseId, current.id);
      if (result.state === 'not_executed' || result.state === 'withheld')
        return save(context, current, {
          state: 'not_executed',
          sent: false,
          failure: 'withheld',
        });
    } catch {
      await save(context, current, {
        state: 'uncertain',
        failure: 'response_unknown',
      });
    }

    return check(context, current);
  }

  async function admit(context: TenantContext, value: ReturnAction) {
    if (value.state === 'failed' && !value.sent && !value.decisionId)
      value = await save(context, value, {
        state: 'approval_required',
        failure: null,
      });
    let decision: PolicyDecision;
    try {
      decision = await deps.admission!.prepare(
        context,
        value,
        returnSettlementAction(value, deps.digest),
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
      'return.settlement.requested',
    );

    return view(
      context,
      saved.state === 'approved' ? await dispatch(context, saved) : saved,
    );
  }

  return {
    /** Lists recorded attempts and mapped Wawi items with independently read current warehouse choices. */
    async list(context: TenantContext, caseId: string) {
      context = await authorize(context);
      const data = await deps.store.transaction(
        context.tenantId,
        async (tx) => {
          const c =
            (await tx.read(caseId)) ?? fail(404, 'Return case not found');

          return { items: await tx.list(caseId), c };
        },
        { readOnlySnapshot: true },
      );

      const targets = hasPermission(context, 'returns.manage')
        ? await choices(context, data.c)
        : { targets: [], targetStatus: 'not_required' as const };

      return {
        items: await Promise.all(
          data.items.map((value) => view(context, value)),
        ),
        ...targets,
        asOf: deps.now().toISOString(),
        available: !!deps.system && !!deps.admission,
      };
    },
    /** Freezes a source-calculated refund or a resale-only stock addition for independent approval. */
    async request(
      context: TenantContext,
      caseId: string,
      input: { id: string; kind: 'refund' | 'restock'; targetId?: string },
    ) {
      context = await authorize(context, true);
      if (!deps.system || !deps.admission)
        fail(503, 'Return execution is unavailable');
      const requestDigest = deps.digest([context.actor.id, caseId, input]);
      const previous = await deps.store.transaction(context.tenantId, (tx) =>
        tx.get(input.id),
      );
      if (previous) {
        if (previous.requestDigest !== requestDigest)
          fail(409, 'This request ID was already used');

        return !previous.decisionId &&
          !previous.sent &&
          ['approval_required', 'failed'].includes(previous.state)
          ? admit(context, previous)
          : view(context, previous);
      }
      const prepared = await deps.store.transaction(
        context.tenantId,
        async (tx) => {
          const c =
            (await tx.lock(caseId)) ?? fail(404, 'Return case not found');
          if (c.state !== 'open' || !c.receipt || !c.inspection || !c.proposal)
            fail(409, 'Record receipt, inspection and a proposal first');
          if (input.kind === 'refund' && c.proposal.kind !== 'refund')
            fail(409, 'This case does not propose a refund');

          return c;
        },
      );
      const c = prepared;
      const target =
        input.kind === 'restock'
          ? ((await choices(context, c)).targets.find(
              (t) => t.id === input.targetId,
            ) ??
            fail(
              409,
              'Choose an explicitly mapped Wawi item and a current warehouse',
            ))
          : null;
      const quantity = target
        ? (c.proposal!.lines.find((l) => l.orderLineId === target.orderLineId)
            ?.restock ?? 0)
        : 0;
      if (
        target &&
        (quantity <= 0 ||
          quantity >
            (c.inspection!.lines.find(
              (l) => l.orderLineId === target.orderLineId,
            )?.resellable ?? 0))
      )
        fail(409, 'Only approved resale units can be restocked');
      await deps.store.transaction(context.tenantId, async (tx) => {
        await tx.lock(caseId);
        const held = (await tx.list(caseId)).some(
          (old) =>
            old.kind === input.kind &&
            old.orderLineId === (target?.orderLineId ?? null) &&
            (old.sent ||
              (['approval_required', 'approved'].includes(old.state) &&
                Date.parse(old.expiresAt) > deps.now().getTime())),
        );
        if (held) fail(409, 'This settlement is already requested or was sent');
      });
      const ids = await deps.cases.transaction(context.tenantId, false, (tx) =>
        tx.sourceIds(
          c.connectionId,
          c.orderId,
          c.lines.map((l) => l.orderLineId),
        ),
      );
      const lines = c
        .receipt!.lines.filter((l) => l.received > 0)
        .map((l) => ({
          orderLine:
            ids.lines.get(l.orderLineId) ??
            fail(409, 'Return lines are not mapped'),
          quantity: l.received,
        }));
      if (!target && (!ids.order || !lines.length))
        fail(409, 'No received units can be refunded');
      const quoted = await deps.system
        .quote(
          context,
          target?.connectionId ?? c.connectionId,
          target
            ? {
                kind: 'restock',
                item: target.item,
                warehouse: target.warehouse,
                quantity,
              }
            : { kind: 'refund', order: ids.order!, lines },
        )
        .catch(() =>
          fail(
            503,
            'Fresh settlement evidence is unavailable; nothing was sent',
          ),
        );
      if (
        quoted.plan.kind !== input.kind ||
        (quoted.plan.kind === 'refund'
          ? canonicalJson([quoted.plan.order, quoted.plan.lines]) !==
            canonicalJson([ids.order, lines])
          : !target ||
            canonicalJson([
              quoted.plan.item,
              quoted.plan.warehouse,
              quoted.plan.quantity,
            ]) !== canonicalJson([target.item, target.warehouse, quantity])) ||
        !quoted.evidenceRefs.length ||
        !Number.isFinite(Date.parse(quoted.observedAt)) ||
        Date.parse(quoted.observedAt) > deps.now().getTime() ||
        deps.now().getTime() - Date.parse(quoted.observedAt) > 300_000
      )
        fail(409, 'Read fresh settlement evidence first');
      const quoteReads = citedReads(quoted.evidenceRefs, quoted.reads);
      if (!quoteReads || !completeReads(quoteReads))
        fail(409, 'Read fresh settlement evidence first');
      const now = deps.now();
      const value: ReturnAction = {
        id: input.id,
        intentVersion: 2,
        tenantId: context.tenantId,
        caseId,
        connectionId: target?.connectionId ?? c.connectionId,
        orderLineId: target?.orderLineId ?? null,
        kind: input.kind,
        mappingIds: target?.mappingIds ?? [],
        plan: quoted.plan,
        quote: {
          observedAt: quoted.observedAt,
          evidenceRefs: quoted.evidenceRefs,
        },
        caseDigest: deps.digest(facts(c)),
        requestDigest,
        actionId: deps.uuid(
          `return-settlement:${context.tenantId}:${input.id}`,
        ),
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
      await deps.store.transaction(context.tenantId, async (tx) => {
        const latest =
          (await tx.lock(caseId)) ?? fail(404, 'Return case not found');
        if (deps.digest(facts(latest)) !== value.caseDigest)
          fail(409, 'The case changed while reading the system');
        for (const old of await tx.list(caseId))
          if (
            old.kind === value.kind &&
            old.orderLineId === value.orderLineId
          ) {
            if (
              old.sent ||
              (['approval_required', 'approved'].includes(old.state) &&
                Date.parse(old.expiresAt) > now.getTime())
            )
              fail(409, 'This settlement is already requested or was sent');
            if (['approval_required', 'approved'].includes(old.state))
              await tx.save({
                ...old,
                state: 'expired',
                updatedAt: now.toISOString(),
              });
          }
        await tx.insert(value);
        for (const read of quoteReads)
          await tx.recordRead(evidence(value, read));
        await tx.audit(auditEntry(context, value, 'return.settlement.quoted'));
      });

      return admit(context, value);
    },
    /** Responds to the exact frozen decision; the approver does not acquire execution authority. */
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
        `return.settlement.${input.outcome}`,
      );
      if (saved.state === 'approved') {
        const principal = await deps
          .principal(
            saved.requestedBy,
            context.tenantId,
            `return-settlement:${id}`,
          )
          .catch(() => null);
        if (principal) saved = await dispatch(principal, saved);
      }

      return view(context, saved);
    },
    /** Sends once as the requester; a repeat only returns or checks the recorded operation. */
    async send(context: TenantContext, caseId: string, id: string) {
      context = await authorize(context, true);

      return view(
        context,
        await dispatch(context, await load(context, caseId, id)),
      );
    },
    /** Reads the exact operation marker and its outcome; never sends a write. */
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
    /**
     * Background step for one requester, run as them: applies approvals the owner never stored,
     * sends approved settlements within their approval, expires unsent ones after it, resumes a
     * send the execution ledger never reserved, and checks sent ones by reading. It never sends
     * a reserved or expired write again. Without `returns.manage` it only records expiry.
     */
    async recover(context: TenantContext) {
      requireTenant(context, context.tenantId);
      context = await deps.refreshContext(context);
      const manage = hasPermission(context, 'returns.manage');
      const values = await deps.store.transaction(context.tenantId, (tx) =>
        tx.live(context.actor.id),
      );
      const failures: unknown[] = [];
      for (let value of values) {
        try {
          let step = returnRecoveryStep(value, deps.now());
          if (step === 'expire') {
            await save(
              context,
              value,
              { state: 'expired' },
              'return.settlement.expired',
            );
            continue;
          }
          if (!step || !manage || !deps.admission) continue;
          if (step === 'decision') {
            const approval = (
              await deps.admission.decision(context, value.decisionId!)
            )?.approval;
            if (!approval) continue;
            value = await save(context, value, {
              state: approval.outcome,
              decidedBy: approval.approverId,
              decidedAt: deps.now().toISOString(),
            });
            step = value.state === 'approved' ? 'send' : null;
          }
          if (step === 'send') await dispatch(context, value);
          else if (step === 'reconcile') {
            if (
              (await deps.admission.get(context, value)).state !== 'not_started'
            )
              await check(context, value);
            else if (Date.parse(value.expiresAt) > deps.now().getTime())
              // Never reserved: resume the same execution identity under its approval.
              await dispatch(
                context,
                value.state === 'sending'
                  ? value
                  : await save(context, value, { state: 'sending' }),
              );
            // The approval ended before anything was reserved, so nothing can be dispatched.
            else
              await save(
                context,
                value,
                { state: 'expired', sent: false, failure: null },
                'return.settlement.expired',
              );
          }
        } catch (error) {
          // A refused step stays for the next pass; other failures must not hold up the rest.
          if (!(error instanceof ServiceError)) failures.push(error);
        }
      }
      if (failures.length)
        throw new AggregateError(
          failures,
          'Some return settlements could not be followed up',
        );
    },
    /** Resolves only a tenant-owned exact intent for the execution gateway. */
    async forAction(context: TenantContext, id: string) {
      context = await authorize(context, true);
      const value = await deps.store.transaction(context.tenantId, (tx) =>
        tx.get(id),
      );

      return value
        ? { value, action: returnSettlementAction(value, deps.digest) }
        : null;
    },
    /** Rechecks current case facts and authority immediately before dispatch. */
    async eligible(
      context: TenantContext,
      step: { subject?: { kind: string; id: string }; action: ProposedAction },
    ) {
      try {
        context = await authorize(context, true);
      } catch {
        return false;
      }
      if (step.subject?.kind !== 'return_case_settlement') return false;

      return deps.store.transaction(context.tenantId, async (tx) => {
        const value = await tx.get(step.subject!.id);
        if (!value || value.requestedBy !== context.actor.id) return false;
        const c = await tx.lock(value.caseId);
        if (!c) return false;
        if (value.plan.kind === 'restock') {
          const target = (await tx.targets(c)).find(
            (t) =>
              t.orderLineId === value.orderLineId &&
              t.connectionId === value.connectionId &&
              canonicalJson(t.item) ===
                canonicalJson(
                  value.plan.kind === 'restock' ? value.plan.item : null,
                ) &&
              canonicalJson(t.mappingIds) === canonicalJson(value.mappingIds),
          );
          if (!target) return false;
        } else {
          const ids = await deps.cases.transaction(
            context.tenantId,
            false,
            (t) =>
              t.sourceIds(
                c.connectionId,
                c.orderId,
                c.lines.map((l) => l.orderLineId),
              ),
          );
          const lines = c.receipt?.lines
            .filter((l) => l.received > 0)
            .map((l) => ({
              orderLine: ids.lines.get(l.orderLineId),
              quantity: l.received,
            }));
          if (
            canonicalJson([value.plan.order, value.plan.lines]) !==
            canonicalJson([ids.order, lines])
          )
            return false;
        }

        return (
          !!c &&
          c.state === 'open' &&
          deps.digest(facts(c)) === value.caseDigest &&
          Date.parse(value.expiresAt) > deps.now().getTime() &&
          ['approval_required', 'approved', 'sending'].includes(value.state) &&
          canonicalJson(returnSettlementAction(value, deps.digest)) ===
            canonicalJson(step.action)
        );
      });
    },
    /**
     * Supplies fresh business verification to the execution engine. Every read it cites is
     * stored first, so its observation IDs resolve to orders evidence. A partial read cannot
     * pass; a storage failure throws, which execution treats as unknown.
     */
    async verify(context: TenantContext, id: string) {
      const value = await deps.store.transaction(context.tenantId, (tx) =>
        tx.get(id),
      );
      if (!value || !deps.system)
        return { outcome: 'inconclusive' as const, observationRefs: [] };
      const cited = citedProof(value, await deps.system.proof(context, value));
      if (!cited)
        return { outcome: 'inconclusive' as const, observationRefs: [] };
      await deps.store.transaction(context.tenantId, async (tx) => {
        for (const read of cited.reads)
          await tx.recordRead(evidence(value, read));
      });

      return {
        outcome: cited.proof.outcome,
        observationRefs: cited.proof.evidenceRefs,
      };
    },
  };
}

export type ReturnActions = ReturnType<typeof createReturnActions>;

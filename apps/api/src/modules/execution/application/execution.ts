import { requireRole, requireTenant } from '#modules/identity/index';
import type { TenantContext } from '#modules/identity/index';
import type {
  PolicyService,
  ProposedAction,
  Provenance,
  PolicyDecision,
} from '#modules/policies/index';
import type {
  EffectRegistry,
  VerificationResult,
} from '#modules/connectors/index';
import type { AuditEntry, AuditLog } from '#modules/audit/index';

export interface ExecutionRecord {
  id: string;
  tenantId: string;
  proposalId: string;
  actionHash: string;
  intent: ProposedAction;
  idempotencyKey: string;
  state: 'prepared' | 'succeeded' | 'failed' | 'unknown';
  attempt: {
    id: string;
    number: 1;
    policyDecisionId: string;
    approvalId?: string;
    mechanism: string;
    executor: Provenance;
    requestedBy: string;
    startedAt: string;
    finishedAt?: string;
    effectEvidenceRefs?: string[];
    verification?: VerificationResult;
  };
}
export interface ExecutionRepository {
  bindIntent(action: ProposedAction, hash: string): Promise<void>;
  get(tenantId: string, proposalId: string): Promise<ExecutionRecord | null>;
  /** Atomically insert the attempt and audit outbox entry. Returns false on a competing reservation. */
  prepare(record: ExecutionRecord, event: AuditEntry): Promise<boolean>;
  /** Compare state, persist completion and append its outbox entry in one transaction. */
  finish(
    record: ExecutionRecord,
    expectedState: ExecutionRecord['state'],
    event: AuditEntry,
  ): Promise<boolean>;
  pending(tenantId: string, proposalId: string): Promise<AuditEntry[]>;
  delivered(tenantId: string, eventId: string): Promise<void>;
}
export interface ExecutionDependencies {
  repository: ExecutionRepository;
  policies: PolicyService;
  audit: AuditLog;
  registry: EffectRegistry;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  parse(input: unknown): { action: ProposedAction; hash: string };
  parseVerification(input: unknown): VerificationResult;
  parseEvidence(input: unknown): string[];
  now(): Date;
  id(): string;
}
export type ExecutionResult =
  | { state: 'denied' | 'approval_required'; decision: PolicyDecision }
  | {
      state: 'succeeded' | 'failed' | 'reconciliation_required';
      record: ExecutionRecord;
    };

export function createExecutionService(deps: ExecutionDependencies) {
  async function flush(tenantId: string, proposalId: string) {
    for (const entry of await deps.repository.pending(tenantId, proposalId)) {
      await deps.audit.append(entry);
      await deps.repository.delivered(tenantId, entry.id);
    }
  }
  function event(
    context: TenantContext,
    action: ProposedAction,
    hash: string,
    eventType: string,
    id: string,
    details: Record<string, string>,
    decisionId?: string,
    attemptId?: string,
  ): AuditEntry {
    return {
      id,
      tenantId: context.tenantId,
      eventKey: id,
      schemaVersion: 1,
      eventType,
      occurredAt: deps.now().toISOString(),
      actor: { kind: 'user', id: context.actor.id },
      correlationId: context.requestId,
      proposalId: action.id,
      actionHash: hash,
      connectionId: action.connectionId,
      evidenceRefs: action.preconditions.evidenceRefs,
      ...(decisionId ? { policyDecisionId: decisionId } : {}),
      ...(attemptId ? { attemptId } : {}),
      details,
    };
  }
  function result(record: ExecutionRecord): ExecutionResult {
    return {
      state:
        record.state === 'prepared' || record.state === 'unknown'
          ? 'reconciliation_required'
          : record.state,
      record,
    };
  }
  async function existing(tenantId: string, proposalId: string, hash: string) {
    const record = await deps.repository.get(tenantId, proposalId);
    if (record && record.actionHash !== hash)
      throw new Error('Idempotency key conflicts with existing intent');
    return record;
  }
  function verified(input: unknown, startedAt: string) {
    const observation = deps.parseVerification(input);
    const observedAt = Date.parse(observation.observedAt);
    if (observedAt < Date.parse(startedAt) || observedAt > deps.now().getTime())
      throw new Error('Verification observation is not fresh');
    return observation;
  }
  return {
    async get(
      context: TenantContext,
      proposalId: string,
    ): Promise<ExecutionResult | null> {
      requireTenant(context, context.tenantId);
      const fresh = await deps.refreshContext(context);
      requireTenant(fresh, context.tenantId);
      requireRole(fresh, ['owner', 'admin']);
      const record = await deps.repository.get(fresh.tenantId, proposalId);
      if (!record) return null;
      await flush(fresh.tenantId, proposalId);
      return result(record);
    },
    async execute(
      context: TenantContext,
      input: unknown,
    ): Promise<ExecutionResult> {
      const { action, hash } = deps.parse(input);
      requireTenant(context, action.tenantId);
      context = await deps.refreshContext(context);
      requireTenant(context, action.tenantId);
      // Only user provenance can be authenticated by the current identity context.
      const proposer = action.proposedBy;
      if (
        proposer.kind !== context.actor.type ||
        proposer.id !== context.actor.id ||
        (proposer.initiatingUserId !== undefined &&
          proposer.initiatingUserId !== context.actor.initiatingUserId) ||
        proposer.model !== undefined
      )
        throw new Error('Proposer must match the authenticated user');
      await deps.repository.bindIntent(action, hash);
      const previous = await existing(context.tenantId, action.id, hash);
      if (previous) {
        await flush(context.tenantId, action.id);
        return result(previous);
      }
      const adapter = await deps.registry.resolve(context, action);
      const available =
        !!adapter &&
        adapter.capability === action.capability &&
        adapter.version === action.capabilityVersion &&
        (await adapter.checkPreconditions(action)) === true;
      const decision = await deps.policies.evaluate(context, action, hash, {
        available,
        minimumRisk: adapter?.minimumRisk ?? 'high',
      });
      if (decision.outcome !== 'allowed')
        return { state: decision.outcome, decision };
      if (!adapter || !available) throw new Error('Capability unavailable');
      const record: ExecutionRecord = {
        id: deps.id(),
        tenantId: context.tenantId,
        proposalId: action.id,
        actionHash: hash,
        intent: action,
        idempotencyKey: `v0:${action.id}`,
        state: 'prepared',
        attempt: {
          id: deps.id(),
          number: 1,
          policyDecisionId: decision.id,
          ...(decision.approvalId ? { approvalId: decision.approvalId } : {}),
          mechanism: adapter.mechanism,
          executor: structuredClone(adapter.executor),
          requestedBy: context.actor.id,
          startedAt: deps.now().toISOString(),
        },
      };
      const prepared = event(
        context,
        action,
        hash,
        'execution.prepared',
        deps.id(),
        {
          idempotencyKey: record.idempotencyKey,
          executorId: adapter.executor.id,
          mechanism: adapter.mechanism,
        },
        decision.id,
        record.attempt.id,
      );
      prepared.proposedBy = action.proposedBy;
      prepared.executor = record.attempt.executor;
      if (!(await deps.repository.prepare(record, prepared))) {
        const winner = await existing(context.tenantId, action.id, hash);
        if (!winner) throw new Error('Execution reservation missing');
        return result(winner);
      }
      // A durable reservation is never automatically redelivered after a crash.
      await flush(context.tenantId, action.id);
      // Audit persistence can take time; expired decisions never authorize a call.
      if (deps.now().getTime() >= Date.parse(decision.validUntil)) {
        record.state = 'failed';
        record.attempt.finishedAt = deps.now().toISOString();
        await deps.repository.finish(
          record,
          'prepared',
          event(
            context,
            action,
            hash,
            'execution.withheld',
            deps.id(),
            { reason: 'decision_expired' },
            decision.id,
            record.attempt.id,
          ),
        );
        await flush(context.tenantId, action.id);
        return result(record);
      }
      try {
        const effect = await adapter.execute(action, record.idempotencyKey);
        record.attempt.effectEvidenceRefs = deps.parseEvidence(
          effect.evidenceRefs,
        );
        record.attempt.verification = verified(
          await adapter.verify(action),
          record.attempt.startedAt,
        );
        record.state =
          record.attempt.verification.outcome === 'passed'
            ? 'succeeded'
            : record.attempt.verification.outcome === 'failed'
              ? 'failed'
              : 'unknown';
      } catch {
        // A thrown request or invalid response cannot establish whether the effect committed.
        record.state = 'unknown';
      }
      record.attempt.finishedAt = deps.now().toISOString();
      const completion = event(
        context,
        action,
        hash,
        'execution.completed',
        deps.id(),
        {
          state: record.state,
          verification: record.attempt.verification?.outcome ?? 'inconclusive',
          ...(record.attempt.verification
            ? {
                evaluatorVersion: record.attempt.verification.evaluatorVersion,
                observedAt: record.attempt.verification.observedAt,
              }
            : {}),
        },
        decision.id,
        record.attempt.id,
      );
      completion.evidenceRefs = [
        ...new Set([
          ...completion.evidenceRefs,
          ...(record.attempt.effectEvidenceRefs ?? []),
          ...(record.attempt.verification?.observationRefs ?? []),
        ]),
      ];
      await deps.repository.finish(record, 'prepared', completion);
      await flush(context.tenantId, action.id);
      return result((await existing(context.tenantId, action.id, hash))!);
    },
    async reconcile(
      context: TenantContext,
      proposalId: string,
    ): Promise<ExecutionResult> {
      requireTenant(context, context.tenantId);
      context = await deps.refreshContext(context);
      requireRole(context, ['owner', 'admin']);
      const record = await deps.repository.get(context.tenantId, proposalId);
      if (!record) throw new Error('Execution not found');
      await flush(context.tenantId, proposalId);
      if (record.state === 'succeeded' || record.state === 'failed')
        return result(record);
      const adapter = await deps.registry.resolve(context, record.intent);
      if (
        !adapter ||
        adapter.capability !== record.intent.capability ||
        adapter.version !== record.intent.capabilityVersion
      )
        throw new Error('Capability unavailable');
      const verification = verified(
        await adapter.verify(record.intent),
        record.attempt.startedAt,
      );
      // A negative read while an old request is in flight cannot establish a safe retry.
      if (verification.outcome !== 'passed') return result(record);
      const expectedState = record.state;
      record.state = 'succeeded';
      record.attempt.verification = verification;
      record.attempt.finishedAt = deps.now().toISOString();
      const reconciled = event(
        context,
        record.intent,
        record.actionHash,
        'execution.reconciled',
        deps.id(),
        {
          state: 'succeeded',
          verification: 'passed',
          evaluatorVersion: verification.evaluatorVersion,
          observedAt: verification.observedAt,
        },
        record.attempt.policyDecisionId,
        record.attempt.id,
      );
      reconciled.evidenceRefs = verification.observationRefs;
      await deps.repository.finish(record, expectedState, reconciled);
      await flush(context.tenantId, proposalId);
      return result(
        (await existing(context.tenantId, proposalId, record.actionHash))!,
      );
    },
  };
}
export type ExecutionService = ReturnType<typeof createExecutionService>;

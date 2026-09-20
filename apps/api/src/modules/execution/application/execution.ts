import type {
  ExecutionFailure,
  VerificationAttempt,
} from '#modules/execution/application/history';
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
import { ConnectorError } from '#modules/connectors/index';
import type { AuditEntry, AuditLog } from '#modules/audit/index';

function sameExecutor(current: Provenance, reserved: Provenance): boolean {
  return (
    current.kind === reserved.kind &&
    current.id === reserved.id &&
    current.initiatingUserId === reserved.initiatingUserId &&
    (current.model === undefined) === (reserved.model === undefined) &&
    (['provider', 'name', 'version', 'promptVersion', 'runId'] as const).every(
      (key) => current.model?.[key] === reserved.model?.[key],
    )
  );
}

export interface ExecutionAdmission {
  runId: string;
  stepId: string;
  artifactId: string;
  artifactVersion: string;
  artifactDigest: string;
  incidentId: string;
  diagnosisRevision: number;
  generation: { kind: 'manual' | 'generated'; reference: string };
}

export interface ExecutionRecord {
  admission?: ExecutionAdmission;
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
    dispatchIdentity?: string;
    mechanism: string;
    executor: Provenance;
    requestedBy: string;
    startedAt: string;
    finishedAt?: string;
    dispatch?: 'not_dispatched' | 'dispatched' | 'uncertain';
    businessOutcome?: 'pending' | 'satisfied' | 'violated' | 'inconclusive';
    providerRequestId?: string;
    effectEvidenceRefs?: string[];
    verification?: VerificationResult;
  };
}
export interface ExecutionRepository {
  verification(tenantId: string, entry: VerificationAttempt): Promise<void>;
  failure(tenantId: string, entry: ExecutionFailure): Promise<void>;
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
  function failure(
    error: unknown,
    proposalId: string,
    phase: ExecutionFailure['phase'],
  ): ExecutionFailure {
    const value = error instanceof ConnectorError ? error.failure : null;
    const codes = [
      'unavailable',
      'unsupported_capability',
      'unsupported_version',
      'invalid_input',
      'invalid_response',
      'authentication',
      'permission_denied',
      'not_found',
      'conflict',
      'rate_limited',
      'timeout',
      'transient',
      'internal',
    ];
    return {
      id: deps.id(),
      proposalId,
      phase,
      occurredAt: deps.now().toISOString(),
      code: value && codes.includes(value.code) ? value.code : 'internal',
      retry:
        value && ['never', 'after_delay', 'reconcile'].includes(value.retry)
          ? value.retry
          : 'reconcile',
      effect: value?.effect === 'none' ? 'none' : 'unknown',
      ...(value?.providerRequestId &&
      /^[\x21-\x7e]{1,200}$/.test(value.providerRequestId)
        ? { providerRequestId: value.providerRequestId }
        : {}),
    };
  }
  async function observe(
    context: TenantContext,
    record: ExecutionRecord,
    read: () => Promise<VerificationResult>,
  ) {
    const entry: VerificationAttempt = {
      id: deps.id(),
      proposalId: record.proposalId,
      phase: 'pending',
      actorId: context.actor.id,
      startedAt: deps.now().toISOString(),
    };
    await deps.repository.verification(context.tenantId, entry);
    let observation: VerificationResult;
    try {
      observation = verified(await read(), record.attempt.startedAt);
    } catch (error) {
      await deps.repository.verification(context.tenantId, {
        ...entry,
        phase: 'completed',
        finishedAt: deps.now().toISOString(),
        failure: failure(error, record.proposalId, 'verification'),
      });
      throw error;
    }
    await deps.repository.verification(context.tenantId, {
      ...entry,
      phase: 'completed',
      finishedAt: deps.now().toISOString(),
      result: observation,
    });
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
      admission?: ExecutionAdmission,
      admissionGuard?: () => Promise<boolean>,
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
        ...(admission ? { admission: structuredClone(admission) } : {}),
        tenantId: context.tenantId,
        proposalId: action.id,
        actionHash: hash,
        intent: action,
        idempotencyKey: `v0:${action.id}`,
        state: 'prepared',
        attempt: {
          id: deps.id(),
          number: 1,
          dispatch: 'uncertain',
          businessOutcome: 'pending',
          policyDecisionId: decision.id,
          ...(decision.approvalId ? { approvalId: decision.approvalId } : {}),
          ...(adapter.dispatchIdentity
            ? { dispatchIdentity: adapter.dispatchIdentity }
            : {}),
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
          ...(admission
            ? {
                runId: admission.runId,
                stepId: admission.stepId,
                artifactId: admission.artifactId,
                artifactVersion: admission.artifactVersion,
                artifactDigest: admission.artifactDigest,
                incidentId: admission.incidentId,
                diagnosisRevision: String(admission.diagnosisRevision),
                generationKind: admission.generation.kind,
                generationReference: admission.generation.reference,
              }
            : {}),
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
      const admissionCurrent = admissionGuard
        ? await admissionGuard().catch(() => false)
        : true;
      if (
        !admissionCurrent ||
        deps.now().getTime() >= Date.parse(decision.validUntil)
      ) {
        record.state = 'failed';
        record.attempt.dispatch = 'not_dispatched';
        record.attempt.businessOutcome = 'inconclusive';
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
            {
              reason: admissionCurrent
                ? 'decision_expired'
                : 'admission_changed',
              dispatch: 'not_dispatched',
              businessOutcome: 'inconclusive',
            },
            decision.id,
            record.attempt.id,
          ),
        );
        await flush(context.tenantId, action.id);
        return result(record);
      }
      let phase: ExecutionFailure['phase'] = 'dispatch';
      try {
        const effect = await adapter.execute(action, record.idempotencyKey);
        record.attempt.dispatch = 'dispatched';
        if (effect.providerRequestId != null) {
          if (
            typeof effect.providerRequestId !== 'string' ||
            !/^[\x21-\x7e]{1,200}$/.test(effect.providerRequestId)
          )
            throw new Error('Invalid provider request ID');
          record.attempt.providerRequestId = effect.providerRequestId;
        }
        record.attempt.effectEvidenceRefs = deps.parseEvidence(
          effect.evidenceRefs,
        );
        phase = 'verification';
        record.attempt.verification = await observe(context, record, () =>
          adapter.verify(action),
        );
        record.state =
          record.attempt.verification.outcome === 'passed'
            ? 'succeeded'
            : record.attempt.verification.outcome === 'failed'
              ? 'failed'
              : 'unknown';
      } catch (error) {
        await deps.repository.failure(
          context.tenantId,
          failure(error, action.id, phase),
        );
        if (
          error instanceof ConnectorError &&
          typeof error.failure.providerRequestId === 'string' &&
          /^[\x21-\x7e]{1,200}$/.test(error.failure.providerRequestId) &&
          !record.attempt.providerRequestId
        )
          record.attempt.providerRequestId = error.failure.providerRequestId;
        if (
          error instanceof ConnectorError &&
          error.failure.dispatch !== undefined &&
          record.attempt.dispatch !== 'dispatched'
        )
          record.attempt.dispatch = error.failure.dispatch;
        // A thrown request or invalid response cannot establish whether the effect committed.
        record.state = 'unknown';
      }
      record.attempt.businessOutcome =
        record.attempt.verification?.outcome === 'passed'
          ? 'satisfied'
          : record.attempt.verification?.outcome === 'failed'
            ? 'violated'
            : 'inconclusive';
      record.attempt.finishedAt = deps.now().toISOString();
      const completion = event(
        context,
        action,
        hash,
        'execution.completed',
        deps.id(),
        {
          state: record.state,
          dispatch: record.attempt.dispatch ?? 'uncertain',
          businessOutcome: record.attempt.businessOutcome,
          ...(record.attempt.providerRequestId
            ? { providerRequestId: record.attempt.providerRequestId }
            : {}),
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
        adapter.version !== record.intent.capabilityVersion ||
        // Legacy attempts predate dispatch identities; retain their recorded executor binding.
        (record.attempt.dispatchIdentity === undefined
          ? adapter.mechanism !== record.attempt.mechanism ||
            !sameExecutor(adapter.executor, record.attempt.executor)
          : adapter.dispatchIdentity !== record.attempt.dispatchIdentity)
      )
        throw new Error('Capability unavailable');
      const verification = await observe(context, record, () =>
        adapter.verify(record.intent),
      );
      // A negative read while an old request is in flight cannot establish a safe retry.
      const expectedState = record.state;
      record.state =
        verification.outcome === 'passed' ? 'succeeded' : expectedState;
      record.attempt.businessOutcome =
        verification.outcome === 'passed'
          ? 'satisfied'
          : verification.outcome === 'failed'
            ? 'violated'
            : 'inconclusive';
      record.attempt.verification = verification;
      record.attempt.finishedAt = deps.now().toISOString();
      const reconciled = event(
        context,
        record.intent,
        record.actionHash,
        'execution.reconciled',
        deps.id(),
        {
          state: record.state,
          dispatch: record.attempt.dispatch ?? 'uncertain',
          businessOutcome: record.attempt.businessOutcome,
          verification: verification.outcome,
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

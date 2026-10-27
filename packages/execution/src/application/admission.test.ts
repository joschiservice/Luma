import type { AuditEntry } from '@luma/audit';
import type { EffectAdapter, VerificationResult } from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import { makeTenantContext, PermissionSet } from '@luma/identity';
import type {
  PolicyDecision,
  PolicyService,
  ProposedAction,
} from '@luma/policies';
import { currentPolicyVersion, evaluatePolicy } from '@luma/policies';
import { describe, expect, it } from 'vitest';

import type {
  ActivatedArtifact,
  AdmissionDependencies,
  BoundActionStep,
} from './admission.js';
import { AdmissionRejected, createActionAdmission } from './admission.js';
import type { ExecutionRecord, ObserveOnlyResult } from './execution.js';
import { createExecutionService } from './execution.js';

let sequence = 0;

/** A unique UUID-shaped identifier; application tests stay free of runtime modules. */
const randomUUID = () =>
  `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;

/** Actions the fake parser accepts, keyed by the bound step input it was handed. */
const proposals = new Map<unknown, ProposedAction>();

/** Stands in for boundary validation: only actions bound by this test parse. */
function parseAction(input: unknown) {
  const action = proposals.get(input);
  if (!action) throw new Error('Invalid action');

  return { action, hash: JSON.stringify(action) };
}

/** Stands in for the strict run and step reference schema. */
function parseReference(input: unknown) {
  if (
    typeof input !== 'object' ||
    input === null ||
    Object.keys(input).sort().join() !== 'runId,stepId' ||
    !('runId' in input) ||
    !('stepId' in input) ||
    typeof input.runId !== 'string' ||
    typeof input.stepId !== 'string'
  )
    throw new Error('Invalid reference');

  return { runId: input.runId, stepId: input.stepId };
}

const tenantId = randomUUID();
const userId = randomUUID();
const connectionId = randomUUID();
const targetId = randomUUID();
const runId = randomUUID();
const now = new Date('2026-10-27T10:00:00.000Z');
const later = new Date(now.getTime() + 3_600_000).toISOString();

function context(
  permissions: readonly string[] = ['actions.execute'],
  actor = userId,
  supportView = false,
): TenantContext {
  return makeTenantContext(
    { userId: actor, sessionId: randomUUID() },
    {
      id: tenantId,
      name: 'Workspace',
      slug: 'workspace',
      status: 'active',
      dataRegion: 'EU',
    },
    {
      id: randomUUID(),
      organizationId: tenantId,
      userId: actor,
      role: {
        id: 'role',
        key: 'custom',
        name: 'Custom',
        builtIn: false,
        revision: 1,
      },
      permissions: new PermissionSet(permissions),
    },
    randomUUID(),
    supportView
      ? { id: randomUUID(), mode: 'consent', expiresAt: later }
      : undefined,
  );
}

function proposal(overrides: Partial<ProposedAction> = {}): ProposedAction {
  return {
    schemaVersion: 1,
    id: randomUUID(),
    tenantId,
    capability: 'inventory.available.set',
    capabilityVersion: '1',
    connectionId,
    target: { kind: 'inventory_level', id: targetId },
    parameters: { quantity: 4 },
    preconditions: { evidenceRefs: [randomUUID()], validUntil: later },
    expectedPostcondition: { quantity: 4 },
    risk: 'low',
    proposedBy: { kind: 'user', id: userId },
    expiresAt: later,
    ...overrides,
  };
}

const artifactDigest = 'a'.repeat(64);

function artifact(
  overrides: Partial<ActivatedArtifact> = {},
): ActivatedArtifact {
  return {
    id: 'artifact',
    version: '1',
    digest: artifactDigest,
    active: true,
    generation: { kind: 'manual', reference: 'fixture' },
    steps: {
      correct: {
        capability: 'inventory.available.set',
        capabilityVersion: '1',
        targetKind: 'inventory_level',
        minimumRisk: 'low',
      },
    },
    ...overrides,
  };
}

function bind(
  action: ProposedAction,
  overrides: Partial<BoundActionStep> = {},
): BoundActionStep {
  proposals.set(action, action);

  return {
    runId,
    stepId: 'correct',
    tenantId,
    principalId: userId,
    artifactId: 'artifact',
    artifactVersion: '1',
    artifactDigest,
    incidentId: randomUUID(),
    diagnosisRevision: 1,
    actionHash: JSON.stringify(action),
    action,
    ...overrides,
  };
}

interface HarnessOptions {
  mode?: 'observe_only' | 'writes_enabled';
  /** The workspace requires a person to approve every action. */
  approvalRequired?: boolean;
  /** Independent eligibility answers, consumed in order; the last repeats. */
  eligible?: boolean[];
  refreshContext?: AdmissionDependencies['refreshContext'];
  artifact?: ActivatedArtifact | null;
}

/**
 * Composes admission with the real execution engine and policy evaluation over in-memory ports,
 * and records the order of audit and provider calls.
 */
function harness(step: BoundActionStep, options: HarnessOptions = {}) {
  const log: string[] = [];
  const dispatches: string[] = [];
  const decisions: PolicyDecision[] = [];
  const records = new Map<string, ExecutionRecord>();
  const observed = new Map<string, ObserveOnlyResult>();
  const outbox: { entry: AuditEntry; delivered: boolean }[] = [];
  const steps = new Map([[`${step.runId}:${step.stepId}`, step]]);
  const eligibility = [...(options.eligible ?? [true])];
  const stepReads: string[] = [];
  let mode = options.mode ?? 'writes_enabled';
  const id = randomUUID;
  const refresh = async (value: TenantContext) => value;

  const adapter: EffectAdapter = {
    capability: 'inventory.available.set',
    version: '1',
    minimumRisk: 'low',
    mechanism: 'api',
    executor: { kind: 'connector', id: 'fixture' },
    checkPreconditions: async () => true,
    async execute(_intent, idempotencyKey, beforeDispatch) {
      await beforeDispatch?.();
      log.push('dispatch');
      dispatches.push(idempotencyKey);

      return { evidenceRefs: [randomUUID()] };
    },
    verify: async () => verification,
  };

  const verification: VerificationResult = {
    outcome: 'passed',
    observationRefs: [randomUUID()],
    observedAt: now.toISOString(),
    evaluatorVersion: 'fixture/1',
  };

  // The real policy rule decides; only persistence and approvals are left out.
  const policies: PolicyService = {
    async decision(_context, decisionId) {
      const decision = decisions.find((value) => value.id === decisionId);

      return decision
        ? { ...decision, approval: null, requireIndependentApproval: true }
        : null;
    },
    decisions: async () => new Map(),
    currentVersion: async () => currentPolicyVersion,
    requiresIndependentApproval: async () => true,
    approvalRequirement: async () => {
      throw new Error('Approval requirements are not exercised here.');
    },
    async evaluate(current, action, actionHash, capability) {
      const { outcome, reason } = evaluatePolicy(
        action,
        capability,
        current.permissions,
        current.actor.id,
        now.getTime(),
        null,
        options.approvalRequired ?? false,
      );
      const decision: PolicyDecision = {
        id: id(),
        correlationId: current.requestId,
        tenantId: current.tenantId,
        proposalId: action.id,
        actionHash,
        actorId: current.actor.id,
        capability: action.capability,
        policyVersion: currentPolicyVersion,
        outcome,
        reason,
        permission: capability.permission,
        evaluatedAt: now.toISOString(),
        validUntil: new Date(now.getTime() + 30_000).toISOString(),
      };
      decisions.push(decision);

      return decision;
    },
    respond: async () => {
      throw new Error('Approval responses are not exercised here.');
    },
  };

  const execution = createExecutionService({
    writeControl: {
      mode: async () => mode,
      get: async (_tenant, proposalId) => observed.get(proposalId) ?? null,
      async record(_action, _hash, result, event) {
        observed.set(result.proposalId, result);
        outbox.push({ entry: event, delivered: false });

        return result;
      },
    },
    repository: {
      verification: async () => {},
      failure: async () => {},
      bindIntent: async () => {},
      get: async (_tenant, proposalId) =>
        structuredClone(records.get(proposalId) ?? null),
      async prepare(record, event) {
        if (records.has(record.proposalId)) return false;
        records.set(record.proposalId, structuredClone(record));
        outbox.push({ entry: event, delivered: false });

        return true;
      },
      async finish(record, expectedState, event) {
        if (records.get(record.proposalId)?.state !== expectedState)
          return false;
        records.set(record.proposalId, structuredClone(record));
        outbox.push({ entry: event, delivered: false });

        return true;
      },
      pending: async (_tenant, proposalId) =>
        outbox
          .filter(
            (item) => !item.delivered && item.entry.proposalId === proposalId,
          )
          .map((item) => item.entry),
      async delivered(_tenant, eventId) {
        for (const item of outbox)
          if (item.entry.id === eventId) item.delivered = true;
      },
    },
    policies,
    audit: {
      async append(entry) {
        log.push(entry.eventType);
      },
      list: async () => [],
    },
    registry: { resolve: async () => adapter },
    refreshContext: refresh,
    parse: parseAction,
    parseVerification(input) {
      if (input !== verification) throw new Error('Invalid verification');

      return verification;
    },
    parseEvidence: (input) =>
      Array.isArray(input)
        ? input.filter((value): value is string => typeof value === 'string')
        : [],
    now: () => now,
    id,
  });

  const admission = createActionAdmission({
    repository: {
      step: async (_context, run, stepId) => {
        stepReads.push(stepId);

        return steps.get(`${run}:${stepId}`) ?? null;
      },
      artifact: async () =>
        options.artifact === undefined ? artifact() : options.artifact,
    },
    execution,
    refreshContext: options.refreshContext ?? refresh,
    now: () => now,
    parseReference,
    parseAction,
    eligible: async () =>
      (eligibility.length > 1 ? eligibility.shift() : eligibility[0]) ?? false,
  });

  return {
    admission,
    log,
    dispatches,
    decisions,
    records,
    steps,
    stepReads,
    setMode(value: typeof mode) {
      mode = value;
    },
  };
}

const reference = (stepId = 'correct') => ({ runId, stepId });

describe('action admission', () => {
  it('dispatches an admitted step once under the v0 proposal key, after the prepared event reaches audit', async () => {
    const action = proposal();
    const run = harness(bind(action));

    const result = await run.admission.execute(context(), reference());

    expect(result.state).toBe('succeeded');
    expect(run.dispatches).toEqual([`v0:${action.id}`]);
    expect(run.log.indexOf('execution.prepared')).toBeLessThan(
      run.log.indexOf('dispatch'),
    );
    const record = run.records.get(action.id)!;
    expect(record.idempotencyKey).toBe(`v0:${action.id}`);
    expect(record.attempt).toMatchObject({
      number: 1,
      dispatch: 'dispatched',
      businessOutcome: 'satisfied',
    });
    expect(record.admission).toMatchObject({
      runId,
      stepId: 'correct',
      artifactDigest,
    });
  });

  it('returns the original attempt on replay without dispatching again', async () => {
    const action = proposal();
    const run = harness(bind(action));

    const first = await run.admission.execute(context(), reference());
    const replay = await run.admission.execute(context(), reference());

    expect(replay).toEqual(first);
    expect(run.dispatches).toHaveLength(1);
  });

  it('records observe-only as not executed before policy or reservation, and never redispatches it', async () => {
    const action = proposal();
    const run = harness(bind(action), { mode: 'observe_only' });

    const result = await run.admission.execute(context(), reference());

    expect(result).toMatchObject({
      state: 'not_executed',
      reason: 'observe_only',
      proposalId: action.id,
    });
    expect(run.decisions).toHaveLength(0);
    expect(run.records.size).toBe(0);
    expect(run.log).toEqual(['execution.not_executed']);

    run.setMode('writes_enabled');
    const replay = await run.admission.execute(context(), reference());

    expect(replay).toEqual(result);
    expect(run.dispatches).toHaveLength(0);
    expect(run.records.size).toBe(0);
  });

  it('returns a policy denial without reserving or dispatching', async () => {
    const run = harness(bind(proposal()));

    const result = await run.admission.execute(
      context(['actions.propose']),
      reference(),
    );

    expect(result.state).toBe('denied');
    expect(result).toMatchObject({
      decision: { outcome: 'denied', reason: 'permission_denied' },
    });
    expect(run.records.size).toBe(0);
    expect(run.dispatches).toHaveLength(0);
  });

  it('returns approval required for a higher-risk action without reserving or dispatching', async () => {
    const action = proposal({ risk: 'medium' });
    const run = harness(bind(action));

    const result = await run.admission.execute(context(), reference());

    expect(result).toMatchObject({
      state: 'approval_required',
      decision: {
        outcome: 'approval_required',
        proposalId: action.id,
        policyVersion: currentPolicyVersion,
      },
    });
    expect(run.records.size).toBe(0);
    expect(run.dispatches).toHaveLength(0);
  });

  it('returns approval required when the workspace requires approval for every action', async () => {
    const run = harness(bind(proposal()), { approvalRequired: true });

    const result = await run.admission.execute(context(), reference());

    expect(result.state).toBe('approval_required');
    expect(run.dispatches).toHaveLength(0);
  });

  it.each([
    [
      'a proposal instead of a reference',
      { runId, stepId: 'correct', action: {} },
    ],
    ['a missing step', { runId }],
    ['a non-object', 'correct'],
  ])('rejects %s before reading the step', async (_name, input) => {
    const run = harness(bind(proposal()));

    await expect(run.admission.execute(context(), input)).rejects.toThrow(
      'Invalid reference',
    );
    expect(run.stepReads).toHaveLength(0);
    expect(run.decisions).toHaveLength(0);
    expect(run.dispatches).toHaveLength(0);
  });

  it('rejects a read-only support view', async () => {
    const run = harness(bind(proposal()));

    await expect(
      run.admission.execute(
        context(['actions.execute'], userId, true),
        reference(),
      ),
    ).rejects.toThrow();
    expect(run.dispatches).toHaveLength(0);
  });

  it('rejects a principal that changed on refresh', async () => {
    const run = harness(bind(proposal()), {
      refreshContext: async () => context(['actions.execute'], randomUUID()),
    });

    await expect(run.admission.execute(context(), reference())).rejects.toThrow(
      new AdmissionRejected('Admission principal changed'),
    );
  });

  it.each<[string, (action: ProposedAction) => BoundActionStep]>([
    ['an unknown step', (action) => bind(action, { stepId: 'other' })],
    [
      'a step bound to another principal',
      (action) => bind(action, { principalId: randomUUID() }),
    ],
  ])('rejects %s as not found', async (_name, build) => {
    const run = harness(build(proposal()));

    await expect(run.admission.execute(context(), reference())).rejects.toThrow(
      new AdmissionRejected('Action step not found'),
    );
  });

  it.each<
    [string, (action: ProposedAction) => BoundActionStep, HarnessOptions?]
  >([
    ['a missing artifact', (action) => bind(action), { artifact: null }],
    [
      'a revoked artifact',
      (action) => bind(action),
      { artifact: artifact({ active: false }) },
    ],
    [
      'a different artifact digest',
      (action) => bind(action, { artifactDigest: 'b'.repeat(64) }),
    ],
    [
      'a changed action hash',
      (action) => bind(action, { actionHash: 'c'.repeat(64) }),
    ],
    [
      'a capability the step does not allow',
      (action) =>
        bind(proposal({ id: action.id, capability: 'orders.cancel' })),
    ],
    [
      'a target kind the step does not allow',
      (action) =>
        bind(
          proposal({ id: action.id, target: { kind: 'order', id: targetId } }),
        ),
    ],
    [
      'a risk below the step minimum',
      (action) => bind(action),
      {
        artifact: artifact({
          steps: {
            correct: {
              capability: 'inventory.available.set',
              capabilityVersion: '1',
              targetKind: 'inventory_level',
              minimumRisk: 'medium',
            },
          },
        }),
      },
    ],
    [
      'an action proposed by someone else',
      (action) =>
        bind({ ...action, proposedBy: { kind: 'user', id: randomUUID() } }),
    ],
  ])('rejects %s', async (_name, build, options) => {
    const run = harness(build(proposal()), options);

    await expect(run.admission.execute(context(), reference())).rejects.toThrow(
      new AdmissionRejected('Action does not match activated artifact'),
    );
    expect(run.decisions).toHaveLength(0);
    expect(run.dispatches).toHaveLength(0);
  });

  it('rejects an action outside its playbook activation grants', async () => {
    const run = harness(bind(proposal()), {
      artifact: artifact({
        playbook: {
          versionDigest: 'd'.repeat(64),
          policyVersion: currentPolicyVersion,
          principalIds: [userId],
          connectionIds: [randomUUID()],
          targetIds: [targetId],
        },
      }),
    });

    await expect(run.admission.execute(context(), reference())).rejects.toThrow(
      new AdmissionRejected('Action exceeds playbook activation grants'),
    );
  });

  it('rejects a playbook step whose eligibility deadline passed', async () => {
    const run = harness(
      bind(proposal(), {
        eligibilityValidUntil: new Date(now.getTime() - 1).toISOString(),
      }),
      {
        artifact: artifact({
          playbook: {
            versionDigest: 'd'.repeat(64),
            policyVersion: currentPolicyVersion,
            principalIds: [userId],
            connectionIds: [connectionId],
            targetIds: [targetId],
          },
        }),
      },
    );

    await expect(run.admission.execute(context(), reference())).rejects.toThrow(
      new AdmissionRejected('Action is no longer eligible'),
    );
    expect(run.decisions).toHaveLength(0);
  });

  it('rejects a step that is no longer eligible', async () => {
    const run = harness(bind(proposal()), { eligible: [false] });

    await expect(run.admission.execute(context(), reference())).rejects.toThrow(
      new AdmissionRejected('Action is no longer eligible'),
    );
    expect(run.decisions).toHaveLength(0);
    expect(run.records.size).toBe(0);
  });

  it('withholds dispatch when eligibility is lost after the reservation reaches audit', async () => {
    const action = proposal();
    const run = harness(bind(action), { eligible: [true, false] });

    const result = await run.admission.execute(context(), reference());

    expect(result.state).toBe('failed');
    expect(run.dispatches).toHaveLength(0);
    expect(run.records.get(action.id)?.attempt).toMatchObject({
      dispatch: 'not_dispatched',
      businessOutcome: 'inconclusive',
    });
    expect(run.log).toEqual(['execution.prepared', 'execution.withheld']);
  });

  it('refuses to reuse a reserved proposal from a different step', async () => {
    const action = proposal();
    const run = harness(bind(action), {
      artifact: artifact({
        steps: {
          correct: artifact().steps.correct!,
          again: artifact().steps.correct!,
        },
      }),
    });
    await run.admission.execute(context(), reference());
    run.steps.set(`${runId}:again`, bind(action, { stepId: 'again' }));

    await expect(
      run.admission.execute(context(), reference('again')),
    ).rejects.toThrow(
      new AdmissionRejected('Execution admission binding conflicts'),
    );
    expect(run.dispatches).toHaveLength(1);
  });
});

import { createHash, randomUUID } from 'node:crypto';

import type { EffectRegistry } from '@luma/connections';
import type { IdentityService, TenantContext } from '@luma/identity';
import {
  IdentityError,
  PermissionSet,
  requirePermission,
  requireTenant,
} from '@luma/identity';
import { canonicalJson, type TenantDatabase } from '@luma/platform';
import type { ProposedAction } from '@luma/policies';
import {
  createProcessClient,
  createProcessWorker,
  type TemporalSettings,
} from '@luma/workflow-temporal';
import {
  defaultCase,
  draftFromVersion,
  type ProcessActivities,
  type ProcessRun,
  type ProcessStepOutput,
  type ProcessWorkflowVersion,
  type WorkflowControlComparison,
  type WorkflowImprovementControls,
} from '@luma/workflows';
import {
  createProcessStepStore,
  createWorkflowCatalogStore,
  createWorkflowTriggerStore,
} from '@luma/workflows/composition';

import { createSafetyServices } from './services.js';

const hash = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
const effectEvidenceId = (key: string) => {
  const digest = hash(key);

  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};
const checks = [
  'admission_success',
  'approval_rejected',
  'role_revoked',
  'foreign_tenant',
  'artifact_revoked',
  'principal_tamper',
  'idempotent_restart',
  'committed_temporal_restart',
] as const;

type ActionStep = Extract<
  ProcessWorkflowVersion['steps'][number],
  { kind: 'capability' }
>;

/** Dedicated disposable resources; implementations must never return the application database or queue. */
export interface WorkflowControlFixture {
  isolated: true;
  database: TenantDatabase;
  context: TenantContext;
  reviewer: TenantContext;
  temporal: TemporalSettings;
  observedAt(): Promise<string>;
  advanceTime(milliseconds: number, signal: AbortSignal): Promise<void>;
  /** Terminates fixture workflows and destroys the disposable database even after failure. */
  close(): Promise<void>;
}

/**
 * Runs real admission, policy and SQL persistence, then stops and replaces a real Temporal worker.
 * Every effect adapter is owned here and writes only synthetic observations in the disposable
 * fixture. No installed connector, mailbox, credential or production effect registry is accepted.
 */
export function createWorkflowImprovementControlHarness(options: {
  identity: Pick<IdentityService, 'refreshContext'>;
  /** Honor cancellation while allocating; clean partial resources before rejecting. */
  open(
    context: TenantContext,
    label: 'baseline' | 'candidate',
    signal: AbortSignal,
  ): Promise<WorkflowControlFixture>;
}): WorkflowImprovementControls {
  return {
    async evaluate(context, baseline, candidate) {
      for (const version of [baseline, candidate]) {
        const actions = version.steps.filter(
          (step) => step.kind === 'capability',
        ).length;
        const waits = version.steps.reduce(
          (sum, step) => sum + (step.kind === 'wait' ? step.seconds : 0),
          0,
        );
        if (
          version.steps.length > 24 ||
          actions > 4 ||
          waits > 60 ||
          version.steps.some(
            (step) =>
              step.kind === 'code' ||
              step.kind === 'human_task' ||
              step.kind === 'event_wait',
          )
        )
          throw new Error(
            'Control evaluation supports up to 24 native steps, 4 actions and 60 seconds of waits; Code and coordination require another trusted harness.',
          );
      }
      const signal = AbortSignal.timeout(180_000);
      const fresh = await deadline(
        options.identity.refreshContext(context),
        signal,
      );
      requireTenant(fresh, context.tenantId);
      requirePermission(fresh, 'workflows.author');
      if (fresh.actor.id !== context.actor.id)
        throw new IdentityError(403, 'FORBIDDEN', 'Your access changed.');
      const versions: WorkflowControlComparison['versions'] = [];
      for (const [label, version] of [
        ['baseline', baseline],
        ['candidate', candidate],
      ] as const) {
        const opening = options.open(fresh, label, signal);
        // A cancelled allocator must tear down partial resources. Also close a late completed lease.
        void opening
          .then(async (lease) => {
            if (signal.aborted) await lease.close();
          })
          .catch(() => undefined);
        const fixture = await deadline(opening, signal);
        try {
          if (
            !fixture.isolated ||
            fixture.context.tenantId !== fresh.tenantId ||
            fixture.context.actor.id !== fresh.actor.id ||
            fixture.reviewer.tenantId !== fresh.tenantId ||
            fixture.reviewer.actor.id === fresh.actor.id ||
            !/^workflow-control-[a-f0-9-]{36}$/.test(fixture.temporal.taskQueue)
          )
            throw new Error('Invalid isolated evaluation bindings');
          versions.push(
            await deadline(
              exercise(fixture, version, baseline, signal),
              signal,
            ),
          );
        } finally {
          await deadline(fixture.close(), AbortSignal.timeout(35_000));
        }
      }
      const refreshed = await deadline(
        options.identity.refreshContext(fresh),
        signal,
      );
      requireTenant(refreshed, fresh.tenantId);
      requirePermission(refreshed, 'workflows.author');
      if (refreshed.actor.id !== fresh.actor.id)
        throw new IdentityError(403, 'FORBIDDEN', 'Your access changed.');

      return {
        suiteVersion: 'workflow-control-simulator/1',
        source: 'disposable_committed_fixture',
        tenantId: fresh.tenantId,
        actorId: fresh.actor.id,
        baselineDigest: baseline.digest,
        candidateDigest: candidate.digest,
        passed: versions.every((item) =>
          item.checks.every((check) => check.passed),
        ),
        versions,
      };
    },
  };
}

async function exercise(
  fixture: WorkflowControlFixture,
  version: ProcessWorkflowVersion,
  golden: ProcessWorkflowVersion,
  signal: AbortSignal,
): Promise<WorkflowControlComparison['versions'][number]> {
  const { context, reviewer } = fixture;
  const database: TenantDatabase = {
    transaction: (tenant, operation, options) =>
      fixture.database.transaction(
        tenant,
        async (tx) => {
          signal.throwIfAborted();
          requireTenant(context, tenant);
          await tx.query("SET LOCAL lock_timeout='3000ms'");
          await tx.query("SET LOCAL statement_timeout='5000ms'");

          return operation(tx);
        },
        options,
      ),
  };
  const connectionId = randomUUID(),
    targetId = randomUUID(),
    observationId = randomUUID();
  const allowed = golden.steps.filter(
    (step): step is ActionStep => step.kind === 'capability',
  );
  let dispatches = 0,
    uncertain = false,
    revoked = false;
  const scope = (current: TenantContext) => {
    requireTenant(current, context.tenantId);
    if (
      current.actor.id !== context.actor.id &&
      current.actor.id !== reviewer.actor.id
    )
      throw new IdentityError(403, 'FORBIDDEN', 'Unknown fixture principal.');

    return revoked && current.actor.id === context.actor.id
      ? { ...current, permissions: new PermissionSet([]) }
      : current;
  };
  const registry: EffectRegistry = {
    resolve: async (current, intent) => {
      scope(current);
      const permission = allowed.find(
        (step) =>
          step.capability === intent.capability &&
          step.capabilityVersion === intent.capabilityVersion &&
          step.targetKind === intent.target.kind,
      );
      if (
        !permission ||
        intent.tenantId !== context.tenantId ||
        intent.connectionId !== connectionId ||
        intent.target.id !== targetId
      )
        return null;

      return {
        capability: permission.capability,
        version: permission.capabilityVersion,
        minimumRisk: permission.minimumRisk,
        mechanism: 'api',
        executor: { kind: 'service', id: 'workflow-control-simulator/1' },
        dispatchIdentity: 'workflow-control-simulator/1',
        checkPreconditions: async (action) =>
          'risk' in action &&
          (action.risk === 'low' ||
            action.risk === 'medium' ||
            action.risk === 'high') &&
          { low: 0, medium: 1, high: 2 }[action.risk] >=
            { low: 0, medium: 1, high: 2 }[permission.minimumRisk],
        execute: async (action, key) => {
          dispatches++;
          const evidence = effectEvidenceId(key);
          await database.transaction(context.tenantId, async (tx) => {
            await tx.query(
              'INSERT INTO exception_sources(tenant_id,evidence_key,document) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
              [
                context.tenantId,
                evidence,
                {
                  key: evidence,
                  tenantId: context.tenantId,
                  connectionId,
                  adapterVersion: 'workflow-control-simulator/1',
                  schemaVersion: 1,
                  source: null,
                  observedAt: new Date().toISOString(),
                  facts: {
                    synthetic: true,
                    expected: action.expectedPostcondition,
                    parameters: action.parameters,
                  },
                },
              ],
            );
          });

          return { evidenceRefs: [evidence] };
        },
        verify: async (action) => {
          if (uncertain) {
            uncertain = false;
            throw new Error('Trusted simulated verification outage');
          }
          const exists = await database.transaction(
            context.tenantId,
            async (tx) =>
              (
                await tx.query<{
                  document: {
                    facts: { expected: unknown; parameters: unknown };
                  };
                }>(
                  'SELECT document FROM exception_sources WHERE tenant_id=$1 AND evidence_key=$2',
                  [
                    context.tenantId,
                    effectEvidenceId(
                      `v0:${'id' in action && typeof action.id === 'string' ? action.id : 'invalid-fixture-id'}`,
                    ),
                  ],
                )
              ).rows[0],
          );

          return {
            outcome:
              exists &&
              hash(exists.document.facts.expected) ===
                hash(action.expectedPostcondition) &&
              hash(exists.document.facts.parameters) === hash(action.parameters)
                ? 'passed'
                : 'failed',
            observationRefs: [randomUUID()],
            observedAt: new Date().toISOString(),
            evaluatorVersion: 'workflow-control-simulator/1',
          };
        },
      };
    },
  };
  const safety = () =>
    createSafetyServices(
      database,
      { refreshContext: async (c) => scope(c) },
      registry,
      {
        eligible: async (current, bound) =>
          bound.tenantId === current.tenantId &&
          bound.principalId === current.actor.id &&
          bound.action.connectionId === connectionId &&
          bound.action.target.id === targetId,
      },
    );
  let service = safety();
  const outcomes = new Map<string, boolean>(checks.map((id) => [id, true]));
  const example = defaultCase(draftFromVersion(golden), 'trusted-control');
  for (const step of golden.steps)
    if (step.kind === 'condition') {
      const read = golden.steps
        .slice(0, golden.steps.indexOf(step))
        .reverse()
        .find(
          (item) =>
            item.kind === 'read' && Object.hasOwn(item.fields, step.field),
        );
      const reply = read ? example.replies[read.id] : undefined;
      if (reply?.kind === 'read') reply.values[step.field] = step.equals;
      else example.evidence[step.field] = step.equals;
    }
  const resolve = (
    value: ActionStep['parameters'][string],
    outputs: ProcessStepOutput[] = [],
  ) => {
    if (value.source === 'literal') return value.value;
    if (value.source === 'input') return example.inputs[value.field];
    if (value.source === 'evidence') return example.evidence[value.field];
    if (value.source !== 'step') return undefined;
    const reply = example.replies[value.stepId];

    return (
      outputs.find((output) => output.stepId === value.stepId)?.values[
        value.field
      ] ?? (reply?.kind === 'read' ? reply.values[value.field] : undefined)
    );
  };

  async function bind(
    step: ActionStep,
    scenario: string,
    runId = randomUUID(),
    outputs: ProcessStepOutput[] = [],
  ) {
    const artifact = await service.provisioning.activate(context, {
      id: `evaluation:${hash([version.digest, scenario, runId])}`,
      version: '1',
      generation: {
        kind: 'manual',
        reference: `trusted-controls:${version.digest}`,
      },
      steps: Object.fromEntries(
        version.steps
          .filter((item): item is ActionStep => item.kind === 'capability')
          .map((item) => [
            item.id,
            {
              capability: item.capability,
              capabilityVersion: item.capabilityVersion,
              targetKind: item.targetKind,
              minimumRisk: item.minimumRisk,
            },
          ]),
      ),
    });
    const fields = (values: ActionStep['parameters']) =>
      Object.fromEntries(
        Object.entries(values).map(([key, value]) => {
          const resolved = resolve(value, outputs);
          if (resolved === undefined)
            throw new Error('Missing trusted fixture value');

          return [key, resolved];
        }),
      );
    const action: ProposedAction = {
      schemaVersion: 1,
      id: randomUUID(),
      tenantId: context.tenantId,
      connectionId,
      capability: step.capability,
      capabilityVersion: step.capabilityVersion,
      target: { kind: step.targetKind, id: targetId },
      parameters: fields(step.parameters),
      expectedPostcondition: fields(step.expectedPostcondition),
      preconditions: {
        evidenceRefs: [observationId],
        validUntil: new Date(Date.now() + 3600000).toISOString(),
      },
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      risk: step.minimumRisk === 'high' ? 'high' : 'medium',
      proposedBy: { kind: 'user', id: context.actor.id },
    };
    await service.provisioning.bind(context, {
      runId,
      stepId: step.id,
      tenantId: context.tenantId,
      principalId: context.actor.id,
      artifactId: artifact.id,
      artifactVersion: artifact.version,
      artifactDigest: artifact.digest,
      subject: { kind: version.applicability.subjectKind, id: targetId },
      action,
    });

    return { artifact, action, reference: { runId, stepId: step.id } };
  }

  for (const step of version.steps.filter(
    (item): item is ActionStep => item.kind === 'capability',
  )) {
    for (const scenario of checks.filter(
      (id) => id !== 'committed_temporal_restart',
    )) {
      const before = dispatches;
      revoked = false;
      uncertain = false;
      const bound = await bind(step, scenario);
      try {
        if (scenario === 'artifact_revoked')
          await service.provisioning.revoke(
            context,
            bound.artifact.id,
            bound.artifact.version,
          );
        revoked = scenario === 'role_revoked';
        const acting =
          scenario === 'foreign_tenant'
            ? { ...context, tenantId: randomUUID() }
            : scenario === 'principal_tamper'
              ? reviewer
              : context;
        let result = await service.execution.execute(acting, bound.reference);
        if (
          [
            'foreign_tenant',
            'principal_tamper',
            'artifact_revoked',
            'role_revoked',
          ].includes(scenario)
        ) {
          outcomes.set(
            scenario,
            outcomes.get(scenario)! &&
              result.state === 'denied' &&
              dispatches === before,
          );
          continue;
        }
        if (result.state !== 'approval_required' || dispatches !== before) {
          outcomes.set(scenario, false);
          continue;
        }
        await service.policies.respond(
          reviewer,
          result.decision.id,
          scenario === 'approval_rejected' ? 'rejected' : 'approved',
          new Date(Date.now() + 3600000).toISOString(),
        );
        uncertain = scenario === 'idempotent_restart';
        result = await service.execution.execute(context, bound.reference);
        if (scenario === 'approval_rejected')
          outcomes.set(
            scenario,
            outcomes.get(scenario)! &&
              result.state === 'denied' &&
              dispatches === before,
          );
        else {
          if (scenario === 'idempotent_restart') {
            const uncertainResult = result.state === 'reconciliation_required';
            await service.close();
            service = safety();
            result = await service.execution.reconcile(
              context,
              bound.action.id,
            );
            outcomes.set(scenario, outcomes.get(scenario)! && uncertainResult);
          }
          const repeated = await service.execution.execute(
            context,
            bound.reference,
          );
          outcomes.set(
            scenario,
            outcomes.get(scenario)! &&
              result.state === 'succeeded' &&
              repeated.state === 'succeeded' &&
              dispatches === before + 1,
          );
        }
      } catch (error) {
        if (
          ![
            'foreign_tenant',
            'principal_tamper',
            'artifact_revoked',
            'role_revoked',
          ].includes(scenario) ||
          dispatches !== before ||
          !(
            error instanceof IdentityError ||
            (error instanceof Error &&
              [
                'Action step not found',
                'Action does not match activated artifact',
              ].includes(error.message))
          )
        )
          outcomes.set(scenario, false);
      } finally {
        revoked = false;
        uncertain = false;
      }
    }
  }
  const runId = randomUUID(),
    createdAt = await fixture.observedAt();
  const snapshot = {
    inputs: example.inputs,
    evidence: {
      kind: version.context.kind,
      facts: example.evidence,
      observations: [
        {
          id: observationId,
          source: 'synthetic',
          observedAt: createdAt,
        },
      ],
    },
    provenance: {
      reference: 'workflow-control-simulator/1',
      capturedAt: createdAt,
    },
  };
  const run: ProcessRun = {
    id: runId,
    tenantId: context.tenantId,
    definitionId: version.definition.id,
    version: version.version,
    versionDigest: version.digest,
    subject: { kind: version.applicability.subjectKind, id: targetId },
    actor: { kind: 'user', id: context.actor.id },
    context: snapshot,
    contextDigest: hash(snapshot),
    createdAt,
  };
  await createWorkflowCatalogStore(database).publish(context, version);
  await createWorkflowTriggerStore(database).insert(context, randomUUID(), {
    ...run,
    activationId: null,
    artifactDigest: null,
    trigger: version.applicability.trigger,
    evidence: { sourceId: randomUUID(), occurredAt: createdAt },
    requestDigest: hash(run),
    state: 'awaiting_admission',
    triggeredAt: createdAt,
  });
  const stepStore = createProcessStepStore(database);
  let checkpointCommitted = false;
  const checkpointStep =
    version.steps.find((step) => step.kind === 'capability') ??
    version.steps[0];
  let resumeCheckpoint: () => void = () => undefined;
  const pausedCheckpoint = new Promise<void>((resolve) => {
    resumeCheckpoint = resolve;
  });
  const activities: ProcessActivities = {
    read: async (_run, step) => {
      const reply = example.replies[step.id];
      if (reply?.kind !== 'read')
        throw new Error('No captured trusted read fixture');

      return {
        values: reply.values,
        evidenceRefs: [observationId],
        observedAt: createdAt,
      };
    },
    decision: async () => ({
      state: 'approved',
      decisionId: 'trusted-workflow-approval',
    }),
    action: async (_run, _version, step, outputs) => {
      const existing = await service.provisioning.step(context, runId, step.id);
      const bound = existing
        ? { action: existing.action, reference: { runId, stepId: step.id } }
        : await bind(step, 'temporal', runId, outputs);
      let result = await service.execution.execute(context, bound.reference);
      if (result.state === 'approval_required') {
        await service.policies.respond(
          reviewer,
          result.decision.id,
          'approved',
          new Date(Date.now() + 3600000).toISOString(),
        );
        result = await service.execution.execute(context, bound.reference);
      }

      return result.state === 'succeeded'
        ? {
            state: 'accepted',
            proposalId: bound.action.id,
            receiptId: result.record.id,
          }
        : {
            state: 'denied',
            proposalId: bound.action.id,
            reason: 'trusted_simulator_admission_failed',
          };
    },
    verify: async (_run, step, outputs) => {
      const action = version.steps.find((item) => item.id === step.forStep);
      if (action?.kind !== 'capability')
        throw new Error('No verification action');
      const bound = await service.provisioning.step(context, runId, action.id);
      if (!bound) throw new Error('No admitted fixture action');
      const result = await service.execution.get(context, bound.action.id);
      if (result?.state !== 'succeeded')
        return {
          state: 'failed',
          values: {},
          evidenceRefs: ['trusted-verification'],
        };
      const adapter = await registry.resolve(context, bound.action);
      const observed = await adapter?.verify(bound.action);
      if (observed?.outcome !== 'passed')
        throw new Error('Independent verification failed');
      const values = Object.fromEntries(
        Object.keys(step.fields).map((key) => {
          const postcondition = action.expectedPostcondition[key];
          if (!postcondition)
            throw new Error('Missing trusted postcondition field');
          const value = resolve(postcondition, outputs);
          if (value === undefined)
            throw new Error('Missing trusted postcondition value');

          return [key, value];
        }),
      );

      return {
        state: 'verified',
        values,
        evidenceRefs: ['trusted-verification'],
      };
    },
    record: async (current, output) => {
      await stepStore.record(context, current.id, output);
      if (
        !checkpointCommitted &&
        output.stepId === checkpointStep?.id &&
        output.state === 'completed'
      ) {
        checkpointCommitted = true;
        await deadline(pausedCheckpoint, signal);
      }
    },
  };
  let worker: Awaited<ReturnType<typeof createProcessWorker>> | undefined,
    running: Promise<void> | undefined;
  const client = await createProcessClient(fixture.temporal, {
    refreshContext: async (c) => scope(c),
  });
  const before = dispatches;
  try {
    worker = await createProcessWorker(fixture.temporal, activities);
    running = worker.run();
    await client.start(context, run, version, 3000);
    await bounded(() => checkpointCommitted, 10000);
    worker.shutdown();
    resumeCheckpoint();
    await running;
    await worker.close();
    worker = undefined;
    const retained = (await stepStore.list(context, [runId])).get(runId) ?? [];
    if (!retained.length) throw new Error('Checkpoint did not commit');
    await service.close();
    service = safety();
    worker = await createProcessWorker(fixture.temporal, activities);
    running = worker.run();
    await deadline(
      fixture.advanceTime(
        Math.max(
          2000,
          version.steps.reduce(
            (sum, step) =>
              sum + (step.kind === 'wait' ? step.seconds * 1000 : 0),
            0,
          ) + 2000,
        ),
        signal,
      ),
      signal,
    );
    // A cold replacement worker may first drain the previous sticky queue. Observe the
    // committed owner checkpoint before querying its warmed Temporal workflow state.
    await bounded(
      async () => {
        const retainedOutputs =
          (await stepStore.list(context, [runId])).get(runId) ?? [];

        return retainedOutputs.some((output) => output.kind === 'end');
      },
      20000 +
        version.steps.reduce(
          (sum, step) => sum + (step.kind === 'wait' ? step.seconds * 1000 : 0),
          0,
        ),
    );
    const outputs = (await stepStore.list(context, [runId])).get(runId) ?? [];
    const actionCount = outputs.filter(
      (output) => output.kind === 'capability' && output.state === 'completed',
    ).length;
    const state = (await client.progress(context, run, 5000)).state;
    outcomes.set(
      'committed_temporal_restart',
      (state === 'verified' || state === 'ended') &&
        dispatches - before === actionCount &&
        actionCount ===
          version.steps.filter((step) => step.kind === 'capability').length &&
        version.steps
          .filter((step) => step.kind === 'verification')
          .every((step) =>
            outputs.some(
              (output) =>
                output.stepId === step.id && output.state === 'completed',
            ),
          ) &&
        outputs.some((output) => output.kind === 'end'),
    );
  } catch {
    outcomes.set('committed_temporal_restart', false);
  } finally {
    resumeCheckpoint();
    if (worker) {
      worker.shutdown();
      await running?.catch(() => undefined);
      await worker.close();
    }
    await client.close();
    await service.close();
  }

  return {
    digest: version.digest,
    checks: checks.map((id) => ({
      id,
      passed: outcomes.get(id) ?? false,
      applicable:
        id === 'committed_temporal_restart' ||
        version.steps.some((step) => step.kind === 'capability'),
    })),
    actions: version.steps.filter((step) => step.kind === 'capability').length,
    effects: dispatches,
    recovery: 'committed_postgres_temporal',
  };
}

async function bounded(
  read: () => boolean | Promise<boolean>,
  milliseconds: number,
) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (
        await Promise.race([
          Promise.resolve().then(read),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error('Trusted evaluation timed out')),
              Math.max(1, deadline - Date.now()),
            );
          }),
        ])
      )
        return;
    } finally {
      if (timer) clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Trusted evaluation timed out');
}

/** Cancels the caller's wait; fixture allocators and clock transports must honor the signal. */
function deadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => undefined);

    return Promise.reject(new Error('Trusted control evaluation timed out'));
  }

  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(new Error('Trusted control evaluation timed out'));
    signal.addEventListener('abort', abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

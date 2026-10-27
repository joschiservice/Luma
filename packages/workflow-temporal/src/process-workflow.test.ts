import { randomUUID } from 'node:crypto';

import { builtInMembership, makeTenantContext } from '@luma/identity';
import type {
  ProcessActivities,
  ProcessRun,
  ProcessStepOutput,
  ProcessWorkflowVersion,
} from '@luma/workflows';
import { WorkflowFailedError } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, Worker } from '@temporalio/worker';
import { expect, it, vi } from 'vitest';

import { createProcessClient, processWorkflowId } from './process-runtime.js';
import { workflowPath } from './runtime.js';

function fixture() {
  const version: ProcessWorkflowVersion = {
    schemaVersion: 2,
    format: 'workflow/2',
    digest: 'a'.repeat(64),
    definition: {
      id: 'stock',
      name: 'Stock',
      intent: 'Reserve stock',
      category: 'procurement',
    },
    version: '1.0.0',
    applicability: { trigger: { kind: 'manual' }, subjectKind: 'order' },
    inputs: {},
    context: {
      kind: 'stock',
      fields: { ready: 'boolean' },
      maxAgeSeconds: 300,
    },
    steps: [
      {
        kind: 'code',
        runtime: 'wasmtime-49.0.1/javy-9.1.0/typescript-5.9.3/1',
        artifactDigest: 'b'.repeat(64),
        id: 'calculate',
        source: 'function main() { return { quantity: 2 }; }',
        fields: { quantity: 'number' },
        grants: [],
        limits: {
          fuel: 100000000,
          memoryBytes: 67108864,
          wallTimeMs: 5000,
          maxRequests: 0,
        },
      },
      {
        id: 'read',
        kind: 'read',
        source: 'stock',
        fields: { ready: 'boolean' },
      },
      {
        id: 'condition',
        kind: 'condition',
        field: 'ready',
        equals: true,
        onFalse: 'escalate',
      },
      {
        id: 'approve',
        kind: 'approval',
        forStep: 'reserve',
        expiresAfterSeconds: 60,
      },
      {
        id: 'reserve',
        kind: 'capability',
        capability: 'stock.reserve',
        capabilityVersion: '1',
        targetKind: 'order',
        minimumRisk: 'medium',
        parameters: {},
        expectedPostcondition: { reserved: { source: 'literal', value: true } },
      },
      {
        id: 'verify',
        kind: 'verification',
        forStep: 'reserve',
        evaluatorVersion: '1',
        maxDurationSeconds: 60,
        fields: { reserved: 'boolean' },
      },
      { id: 'end', kind: 'end', outcome: 'reserved' },
    ],
    provenance: {
      kind: 'resolution',
      reference: 'test',
      authoredBy: 'test',
      evidenceRefs: ['stock'],
    },
  };
  const run: ProcessRun = {
    id: randomUUID(),
    tenantId: randomUUID(),
    definitionId: 'stock',
    version: version.version,
    versionDigest: version.digest,
    subject: { kind: 'order', id: randomUUID() },
    actor: { kind: 'user', id: 'operator' },
    context: {
      inputs: {},
      evidence: {
        kind: 'stock',
        facts: { ready: true },
        observations: [
          {
            id: randomUUID(),
            observedAt: new Date().toISOString(),
            source: 'stock',
          },
        ],
      },
      provenance: { reference: 'test', capturedAt: new Date().toISOString() },
    },
    contextDigest: 'test',
    createdAt: new Date().toISOString(),
  };
  const recorded: string[] = [];
  const outputs: ProcessStepOutput[] = [];
  const action = vi.fn<ProcessActivities['action']>(async () => ({
    state: 'accepted',
    proposalId: 'proposal',
    receiptId: 'receipt',
  }));
  const activities: ProcessActivities = {
    code: vi.fn(async (_run, _version, step) => ({
      state: 'completed' as const,
      values: { quantity: 2 },
      evidenceRefs: [step.artifactDigest],
      telemetry: {
        runtime: step.runtime,
        artifactDigest: step.artifactDigest,
        inputDigest: 'b'.repeat(64),
        requests: 0,
        wallTimeMs: 1,
        outcome: 'completed' as const,
      },
    })),
    read: async () => ({
      values: { ready: true },
      evidenceRefs: ['stock-read'],
      observedAt: new Date().toISOString(),
    }),
    decision: async () => ({ state: 'approved', decisionId: 'decision' }),
    action,
    verify: async () => ({
      state: 'verified',
      values: { reserved: true },
      evidenceRefs: ['stock-verify'],
    }),
    record: async (_run, output) => {
      recorded.push(output.stepId);
      outputs.push(output);
    },
  };

  return { version, run, recorded, outputs, action, activities };
}

it('replays a multi-step process without redispatching its capability action', async () => {
  const env = await TestWorkflowEnvironment.createLocal();
  const { version, run, recorded, activities } = fixture();
  const bundle = await bundleWorkflowCode({ workflowsPath: workflowPath() });
  const taskQueue = randomUUID();
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowBundle: bundle,
    activities,
  });
  try {
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start('processWorkflow', {
        workflowId: randomUUID(),
        taskQueue,
        args: [run, version],
      });
      expect(await handle.result()).toMatchObject({
        state: 'verified',
        stepId: 'end',
      });
      await Worker.runReplayHistory(
        { workflowBundle: bundle },
        await handle.fetchHistory(),
      );
    });
    expect(activities.action).toHaveBeenCalledTimes(1);
    expect(activities.code).toHaveBeenCalledTimes(1);
    expect(recorded).toEqual(version.steps.map((step) => step.id));
  } finally {
    await env.teardown();
  }
}, 60_000);

it.each([
  ['its workspace', 'WorkspaceInactive'],
  ['the member it acts as', 'MembershipSuspended'],
])(
  'pauses a run while %s is suspended without repeating completed steps',
  async (_name, type) => {
    const env = await TestWorkflowEnvironment.createTimeSkipping();
    const { version, run, recorded, action, activities } = fixture();
    const suspended = ApplicationFailure.nonRetryable('Suspended', type);
    action.mockRejectedValueOnce(suspended).mockRejectedValueOnce(suspended);
    const bundle = await bundleWorkflowCode({ workflowsPath: workflowPath() });
    const taskQueue = randomUUID();
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowBundle: bundle,
      activities,
    });
    try {
      await worker.runUntil(async () => {
        const handle = await env.client.workflow.start('processWorkflow', {
          workflowId: randomUUID(),
          taskQueue,
          args: [run, version],
        });
        expect(await handle.result()).toMatchObject({
          state: 'verified',
          stepId: 'end',
        });
        await Worker.runReplayHistory(
          { workflowBundle: bundle },
          await handle.fetchHistory(),
        );
      });
      // Both rejected attempts ran no effect; the action runs once after reactivation.
      expect(action).toHaveBeenCalledTimes(3);
      expect(activities.code).toHaveBeenCalledTimes(1);
      expect(recorded).toEqual(version.steps.map((step) => step.id));
    } finally {
      await env.teardown();
    }
  },
  60_000,
);

/** Runs one process on a time-skipping server and returns its result and history replay. */
async function runToEnd(
  run: ProcessRun,
  version: ProcessWorkflowVersion,
  activities: ProcessActivities,
) {
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const bundle = await bundleWorkflowCode({ workflowsPath: workflowPath() });
  const taskQueue = randomUUID();
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowBundle: bundle,
    activities,
  });
  try {
    return await worker.runUntil(async () => {
      const handle = await env.client.workflow.start('processWorkflow', {
        workflowId: randomUUID(),
        taskQueue,
        args: [run, version],
      });
      const result = await handle.result().catch((error: unknown) => error);
      await Worker.runReplayHistory(
        { workflowBundle: bundle },
        await handle.fetchHistory(),
      );

      return result;
    });
  } finally {
    await env.teardown();
  }
}

it('settles a process run as escalated when an activity exhausts its retries', async () => {
  const { version, run, outputs, action, activities } = fixture();
  const read = vi.fn<ProcessActivities['read']>(async () => {
    throw new Error('Database unavailable');
  });
  const result = await runToEnd(run, version, { ...activities, read });

  expect(result).toEqual({
    state: 'escalated',
    stepId: 'read',
    reason: 'process_failed',
  });
  // Retries back off over the bounded window instead of five quick attempts.
  expect(read.mock.calls.length).toBeGreaterThan(5);
  expect(action).not.toHaveBeenCalled();
  expect(outputs.at(-1)).toMatchObject({
    stepId: 'read',
    kind: 'read',
    state: 'escalated',
    values: {},
    reason: 'process_failed',
  });
}, 120_000);

it('settles an output that breaks its contract instead of retrying the workflow task', async () => {
  const { version, run, outputs, activities } = fixture();
  const result = await runToEnd(run, version, {
    ...activities,
    read: async () => ({
      values: { unexpected: true },
      evidenceRefs: ['stock-read'],
      observedAt: new Date().toISOString(),
    }),
  });

  expect(result).toMatchObject({ state: 'escalated', stepId: 'read' });
  expect(outputs.map((output) => [output.stepId, output.state])).toEqual([
    ['calculate', 'completed'],
    ['read', 'escalated'],
  ]);
}, 60_000);

it('fails a run bound to another version instead of retrying the workflow task', async () => {
  const { version, run, outputs, activities } = fixture();
  const result = await runToEnd(
    { ...run, versionDigest: 'c'.repeat(64) },
    version,
    activities,
  );

  expect(result).toBeInstanceOf(WorkflowFailedError);
  expect(outputs).toEqual([]);
}, 60_000);

it('reports a process run whose execution closed when it is started again', async () => {
  const env = await TestWorkflowEnvironment.createLocal();
  const { version, run } = fixture();
  const context = makeTenantContext(
    { userId: run.actor.id, sessionId: 'session' },
    {
      id: run.tenantId,
      name: 'Synthetic',
      slug: 'synthetic',
      status: 'active',
      dataRegion: 'AU',
    },
    builtInMembership(
      { id: randomUUID(), organizationId: run.tenantId, userId: run.actor.id },
      'owner',
    ),
    'request',
  );
  const client = createProcessClient(
    {
      address: env.address,
      namespace: env.namespace ?? 'default',
      taskQueue: randomUUID(),
      dataRegion: 'AU',
    },
    { refreshContext: async (value) => value },
  );
  try {
    const workflowId = processWorkflowId(run.tenantId, run.id);
    // No worker polls the queue, so the execution stays open until it is terminated.
    expect(await client.start(context, run, version)).toEqual({
      workflowId,
      closed: null,
    });
    expect(await client.start(context, run, version)).toEqual({
      workflowId,
      closed: null,
    });

    await env.client.workflow.getHandle(workflowId).terminate();
    expect(await client.start(context, run, version)).toEqual({
      workflowId,
      closed: 'terminated',
    });
  } finally {
    await client.close();
    await env.teardown();
  }
}, 60_000);

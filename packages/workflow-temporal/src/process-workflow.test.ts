import { randomUUID } from 'node:crypto';

import type {
  ProcessActivities,
  ProcessRun,
  ProcessWorkflowVersion,
} from '@luma/workflows';
import { ApplicationFailure } from '@temporalio/common';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, Worker } from '@temporalio/worker';
import { expect, it, vi } from 'vitest';

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
    },
  };

  return { version, run, recorded, action, activities };
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

it('pauses a run while its workspace is suspended without repeating completed steps', async () => {
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const { version, run, recorded, action, activities } = fixture();
  const suspended = ApplicationFailure.nonRetryable(
    'Workspace is not active',
    'WorkspaceInactive',
  );
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
}, 60_000);

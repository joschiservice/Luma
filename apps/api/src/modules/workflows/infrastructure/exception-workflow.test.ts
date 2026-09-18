import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker, bundleWorkflowCode } from '@temporalio/worker';
import type { WorkflowBundleWithSourceMap } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/common';
import type {
  ExceptionActivities,
  ExceptionWorkflowInput,
  WorkflowProgress,
} from '#modules/workflows/application/runtime';
import {
  temporalActivities,
  workflowPath,
} from '#modules/workflows/infrastructure/runtime';
import { IdentityError } from '#modules/identity/index';

let env: TestWorkflowEnvironment;
let bundle: WorkflowBundleWithSourceMap;
beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
  bundle = await bundleWorkflowCode({ workflowsPath: workflowPath() });
}, 60_000);
afterAll(async () => {
  await env?.teardown();
});
const input: ExceptionWorkflowInput = {
  tenantId: 'tenant',
  userId: 'requester',
  requestId: 'request',
  source: { kind: 'incident', id: 'incident' },
};
function fixture() {
  return {
    detect: vi
      .fn<ExceptionActivities['detect']>()
      .mockResolvedValue('incident'),
    diagnose: vi.fn<ExceptionActivities['diagnose']>().mockResolvedValue({
      status: 'ready',
      revision: 1,
      verificationRequired: false,
      retryAfter: null,
    }),
    propose: vi.fn<ExceptionActivities['propose']>().mockResolvedValue({
      id: 'proposal',
      revision: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    execute: vi
      .fn<ExceptionActivities['execute']>()
      .mockResolvedValue({ state: 'succeeded' }),
    reconcile: vi
      .fn<ExceptionActivities['reconcile']>()
      .mockResolvedValue({ state: 'succeeded' }),
    verify: vi.fn<ExceptionActivities['verify']>().mockResolvedValue(true),
  };
}
async function run(activities: ExceptionActivities) {
  const taskQueue = randomUUID();
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowBundle: bundle,
    activities,
  });
  return worker.runUntil(
    () =>
      env.client.workflow.execute('exceptionWorkflow', {
        workflowId: randomUUID(),
        taskQueue,
        args: [input],
      }) as Promise<WorkflowProgress>,
  );
}
it('verifies the business outcome after a successful effect and replays recorded history', async () => {
  const activities = fixture();
  const taskQueue = randomUUID();
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowBundle: bundle,
    activities,
  });
  await worker.runUntil(async () => {
    const handle = await env.client.workflow.start('exceptionWorkflow', {
      workflowId: randomUUID(),
      taskQueue,
      args: [input],
    });
    expect(await handle.result()).toMatchObject({
      phase: 'resolved',
      exceptionId: 'incident',
      proposalId: 'proposal',
    });
    await Worker.runReplayHistory(
      { workflowBundle: bundle },
      await handle.fetchHistory(),
    );
  });
  expect(activities.execute).toHaveBeenCalledTimes(1);
  expect(activities.verify).toHaveBeenCalledTimes(1);
}, 30_000);
it('resumes approval after worker replacement; notifications carry no authorization', async () => {
  const activities = fixture();
  let approved = false;
  activities.execute.mockImplementation(async () =>
    approved
      ? { state: 'succeeded' }
      : { state: 'approval_required', decisionId: 'decision' },
  );
  const taskQueue = randomUUID();
  const handle = await env.client.workflow.start('exceptionWorkflow', {
    workflowId: randomUUID(),
    taskQueue,
    args: [input],
  });
  const first = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowBundle: bundle,
    activities,
  });
  await first.runUntil(async () => {
    await vi.waitFor(
      async () =>
        expect(await handle.query<WorkflowProgress>('progress')).toMatchObject({
          phase: 'awaiting_approval',
        }),
      { timeout: 10_000 },
    );
    await handle.signal('approvalChanged');
    await vi.waitFor(
      () => expect(activities.execute).toHaveBeenCalledTimes(2),
      { timeout: 10_000 },
    );
    expect(activities.verify).not.toHaveBeenCalled();
  });
  approved = true;
  await handle.signal('approvalChanged');
  const second = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowBundle: bundle,
    activities,
  });
  await second.runUntil(async () =>
    expect(await handle.result()).toMatchObject({ phase: 'resolved' }),
  );
  expect(activities.detect).toHaveBeenCalledTimes(1);
  expect(activities.propose).toHaveBeenCalledTimes(1);
}, 30_000);
it.each(['reconciliation_required', 'failed', 'denied'] as const)(
  'handles execution %s without redispatch',
  async (state) => {
    const activities = fixture();
    activities.execute.mockResolvedValue({ state });
    activities.reconcile.mockResolvedValue({
      state: 'reconciliation_required',
    });
    expect(await run(activities)).toMatchObject({
      phase: state === 'denied' ? 'denied' : 'escalated',
    });
    expect(activities.execute).toHaveBeenCalledTimes(1);
    expect(activities.reconcile).toHaveBeenCalledTimes(
      state === 'reconciliation_required' ? 1 : 0,
    );
    expect(activities.verify).not.toHaveBeenCalled();
  },
  15_000,
);
it('recovers a lost activity result through read-only reconciliation', async () => {
  const activities = fixture();
  activities.execute.mockRejectedValue(
    ApplicationFailure.nonRetryable('lost completion'),
  );
  expect(await run(activities)).toMatchObject({ phase: 'resolved' });
  expect(activities.execute).toHaveBeenCalledTimes(1);
  expect(activities.reconcile).toHaveBeenCalledTimes(1);
}, 15_000);
it('does not turn failed business verification into resolution', async () => {
  const activities = fixture();
  activities.verify.mockResolvedValue(false);
  expect(await run(activities)).toMatchObject({
    phase: 'escalated',
    reason: 'verification_requires_review',
  });
}, 15_000);
it('expires approval without dispatching again', async () => {
  const activities = fixture();
  activities.propose.mockImplementation(async () => ({
    id: 'proposal',
    revision: 1,
    expiresAt: new Date(Date.now() + 1000).toISOString(),
  }));
  activities.execute.mockResolvedValue({
    state: 'approval_required',
    decisionId: 'decision',
  });
  expect(await run(activities)).toMatchObject({
    phase: 'denied',
    reason: 'proposal_expired',
  });
  expect(activities.execute).toHaveBeenCalledTimes(1);
}, 15_000);
it('leaves unsupported proposals for manual intervention', async () => {
  const activities = fixture();
  activities.propose.mockResolvedValue(null);
  expect(await run(activities)).toMatchObject({
    phase: 'escalated',
    reason: 'manual_intervention_required',
  });
  expect(activities.execute).not.toHaveBeenCalled();
}, 15_000);
it('stops when detection finds no incident', async () => {
  const activities = fixture();
  activities.detect.mockResolvedValue(null);
  expect(await run(activities)).toEqual({ phase: 'no_incident' });
  expect(activities.diagnose).not.toHaveBeenCalled();
}, 15_000);
it('routes a detector clear result through fresh business verification', async () => {
  const activities = fixture();
  activities.diagnose.mockResolvedValue({
    status: 'ready',
    revision: 1,
    verificationRequired: true,
    retryAfter: null,
  });
  expect(await run(activities)).toMatchObject({ phase: 'resolved' });
  expect(activities.propose).not.toHaveBeenCalled();
  expect(activities.execute).not.toHaveBeenCalled();
  expect(activities.verify).toHaveBeenCalledTimes(1);
}, 15_000);
it('honors diagnosis backoff and evaluates the next revision', async () => {
  const activities = fixture();
  activities.diagnose.mockResolvedValueOnce({
    status: 'pending',
    revision: 1,
    verificationRequired: false,
    retryAfter: new Date(Date.now() + 1000).toISOString(),
  });
  expect(await run(activities)).toMatchObject({ phase: 'resolved' });
  expect(activities.diagnose).toHaveBeenCalledTimes(2);
}, 15_000);
it('recovers committed approval without a notification', async () => {
  const activities = fixture();
  activities.execute.mockResolvedValueOnce({
    state: 'approval_required',
    decisionId: 'decision',
  });
  expect(await run(activities)).toMatchObject({ phase: 'resolved' });
  expect(activities.execute).toHaveBeenCalledTimes(2);
}, 40_000);
it.each(['succeeded', 'reconciliation_required', 'lost_completion'] as const)(
  'waits for in-flight execution before cancellation recovery: %s',
  async (outcome) => {
    const activities = fixture();
    let entered!: () => void;
    const executing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let committed = false;
    activities.execute.mockImplementation(async () => {
      entered();
      await pending;
      committed = true;
      if (outcome === 'lost_completion')
        throw ApplicationFailure.nonRetryable(
          'completion lost after provider commit',
        );
      return { state: outcome };
    });
    activities.reconcile.mockImplementation(async () => {
      expect(committed).toBe(true);
      return { state: 'succeeded' };
    });
    const taskQueue = randomUUID();
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowBundle: bundle,
      activities,
    });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start('exceptionWorkflow', {
        workflowId: randomUUID(),
        taskQueue,
        args: [input],
      });
      try {
        await executing;
        await handle.cancel();
        // Wait until a workflow task has processed cancellation, not merely until the request was accepted.
        await vi.waitFor(
          async () => {
            const events = (await handle.fetchHistory()).events ?? [];
            const cancelIndex = events.findIndex(
              (event) => event.workflowExecutionCancelRequestedEventAttributes,
            );
            expect(cancelIndex).toBeGreaterThanOrEqual(0);
            expect(
              events
                .slice(cancelIndex + 1)
                .some((event) => event.workflowTaskCompletedEventAttributes),
            ).toBe(true);
          },
          { timeout: 10_000 },
        );
        expect(activities.reconcile).not.toHaveBeenCalled();
        expect((await handle.describe()).status.name).toBe('RUNNING');
        finish();
        await expect(handle.result()).rejects.toThrow();
        expect((await handle.describe()).status.name).toBe('CANCELLED');
        expect(activities.reconcile).toHaveBeenCalledTimes(1);
        expect(activities.execute).toHaveBeenCalledTimes(1);
        expect(activities.verify).not.toHaveBeenCalled();
        await Worker.runReplayHistory(
          { workflowBundle: bundle },
          await handle.fetchHistory(),
        );
      } finally {
        finish();
      }
    });
  },
  15_000,
);

it('sanitizes stored activity failures and does not retry denied authorization', async () => {
  const activities = fixture();
  activities.detect.mockRejectedValue(new Error('secret-provider-payload'));
  await expect(
    temporalActivities(activities).detect(input),
  ).rejects.toMatchObject({
    message: 'Workflow activity unavailable',
    nonRetryable: false,
    cause: undefined,
  });
  activities.detect.mockRejectedValue(
    new IdentityError(403, 'FORBIDDEN', 'private authorization details'),
  );
  await expect(
    temporalActivities(activities).detect(input),
  ).rejects.toMatchObject({
    message: 'Workflow authorization or input rejected',
    nonRetryable: true,
    cause: undefined,
  });
});

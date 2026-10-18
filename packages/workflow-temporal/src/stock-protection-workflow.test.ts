import { randomUUID } from 'node:crypto';

import { ApplicationFailure } from '@temporalio/common';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, Worker } from '@temporalio/worker';
import { expect, it } from 'vitest';

import { workflowPath } from './runtime.js';
import type { StockProtectionWorkflowInput } from './stock-protection-workflow.js';

it('keeps the same incident identity over durable timers until fresh work confirms completion', async () => {
  const environment = await TestWorkflowEnvironment.createTimeSkipping();
  const calls: StockProtectionWorkflowInput[] = [];
  const times: number[] = [];
  const taskQueue = randomUUID();
  const worker = await Worker.create({
    connection: environment.nativeConnection,
    taskQueue,
    workflowBundle: await bundleWorkflowCode({ workflowsPath: workflowPath() }),
    activities: {
      stockProtectionTick: async (input: StockProtectionWorkflowInput) => {
        calls.push(input);
        times.push(await environment.currentTimeMs());

        return { done: calls.length === 3, moreWork: calls.length === 1 };
      },
    },
  });
  const input: StockProtectionWorkflowInput = {
    tenantId: randomUUID(),
    userId: randomUUID(),
    incidentId: randomUUID(),
    dataRegion: 'AU',
  };
  try {
    await worker.runUntil(
      environment.client.workflow.execute('stockProtectionWorkflow', {
        workflowId: randomUUID(),
        taskQueue,
        args: [input],
      }),
    );
    expect(calls).toEqual([input, input, input]);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(1000);
    expect(times[1]! - times[0]!).toBeLessThan(60000);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(60000);
  } finally {
    await environment.teardown();
  }
}, 30000);

it('backs off while the principal stays rejected and resumes at the normal pace', async () => {
  const environment = await TestWorkflowEnvironment.createTimeSkipping();
  const times: number[] = [];
  const taskQueue = randomUUID();
  const worker = await Worker.create({
    connection: environment.nativeConnection,
    taskQueue,
    workflowBundle: await bundleWorkflowCode({ workflowsPath: workflowPath() }),
    activities: {
      stockProtectionTick: async () => {
        times.push(await environment.currentTimeMs());
        if (times.length <= 3)
          throw ApplicationFailure.nonRetryable(
            'Workflow authorization or input rejected',
            'WorkflowRejected',
          );

        return { done: times.length === 5 };
      },
    },
  });
  try {
    await worker.runUntil(
      environment.client.workflow.execute('stockProtectionWorkflow', {
        workflowId: randomUUID(),
        taskQueue,
        args: [
          {
            tenantId: randomUUID(),
            userId: randomUUID(),
            incidentId: randomUUID(),
            dataRegion: 'AU',
          } satisfies StockProtectionWorkflowInput,
        ],
      }),
    );
    const gaps = times.slice(1).map((time, index) => time - times[index]!);
    expect(gaps[0]).toBeGreaterThanOrEqual(60_000);
    expect(gaps[1]).toBeGreaterThanOrEqual(120_000);
    expect(gaps[2]).toBeGreaterThanOrEqual(240_000);
    expect(gaps[3]).toBeGreaterThanOrEqual(60_000);
    expect(gaps[3]).toBeLessThan(120_000);
  } finally {
    await environment.teardown();
  }
}, 30000);

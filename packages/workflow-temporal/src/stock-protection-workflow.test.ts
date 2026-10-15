import { randomUUID } from 'node:crypto';

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

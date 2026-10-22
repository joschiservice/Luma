import { randomUUID } from 'node:crypto';

import { TestWorkflowEnvironment } from '@temporalio/testing';
import { expect, test } from 'vitest';

import { database, startProcess, until } from './helpers.mjs';

test('the standalone worker starts and drains on SIGTERM', async (t) => {
  const db = await database(t);
  await db.migrate();
  await db.grantRuntime();
  const temporal = await TestWorkflowEnvironment.createLocal();
  t.onTestFinished(() => temporal.teardown());
  const worker = startProcess(t, '../worker/dist/bootstrap.js', {
    // The worker receives only its own login, without the API's login or auth secret.
    WORKFLOW_DATABASE_URL: db.runtimeUrl,
    TEMPORAL_ADDRESS: temporal.address,
    TEMPORAL_NAMESPACE: 'default',
    TEMPORAL_TASK_QUEUE: `worker-startup-${randomUUID()}`,
    TEMPORAL_DATA_REGION: process.env.LUMA_REGION ?? 'AU',
  });
  await until(() => {
    if (worker.result) throw new Error(worker.output);

    // Temporal logs one JSON line per entry.
    return worker.output.includes('"state":"RUNNING"');
  }, 'standalone worker running');
  worker.child.kill('SIGTERM');
  expect(await worker.wait()).toEqual({ code: 0, signal: null });
});

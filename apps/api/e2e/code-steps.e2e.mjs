import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createTenantDatabase } from '@luma/platform/composition';
import { runProcess } from '@luma/workflows';
import {
  compileProcessWorkflow,
  createCodeProcesses,
  createWorkflows,
  createWorkflowTriggerStore,
  defineCodeStep,
} from '@luma/workflows/composition';
import { Pool } from 'pg';
import { expect, it } from 'vitest';

import { seedCodeSteps } from './code-steps-fixture.mjs';
import { database, signup, startApi, until } from './helpers.mjs';

it('evaluates published code in Wasmtime, persists replay and isolates actors and tenants', async (t) => {
  const db = await database(t);
  await db.migrate();
  await db.grantRuntime();
  await db.owner.query(
    `GRANT luma_connectors TO "${new URL(db.runtimeUrl).username}"`,
  );
  const api = await startApi(t, db, undefined, 'e2e/code-server.mjs');
  const user = await signup(api, 'code-owner');
  const org = (
    await api.request('/v1/organizations', {
      cookie: user.cookie,
      method: 'POST',
      status: 201,
      body: {
        name: 'Code studio',
        slug: 'code-studio',
        dataRegion: globalThis.process.env.LUMA_REGION ?? 'AU',
      },
    })
  ).body;
  const { version, context } = await seedCodeSteps(db, org.id);
  const root = `/v1/organizations/${org.id}/workflows/${version.definition.id}`;
  const detail = (await api.request(root, { cookie: user.cookie })).body;
  expect(detail.versions[0].codeSteps[0].artifactDigest).toBe(
    version.steps[0].artifactDigest,
  );
  const body = {
    id: randomUUID(),
    version: version.version,
    reviewedDigest: version.digest,
    stepId: 'calculate',
    now: '2026-01-01T00:00:00.000Z',
    input: { inputs: { quantity: 3 }, evidence: {}, steps: {} },
    replies: {},
    expected: { value: 6 },
  };
  const endpoint = `${root}/code-evaluations`;
  await api.request(endpoint, { cookie: user.cookie, method: 'POST', body });
  const result = await until(async () => {
    const item = (
      await api.request(`${endpoint}/${body.id}`, { cookie: user.cookie })
    ).body;

    return item.state !== 'running' && item;
  }, 'evaluation completion');
  expect(result.state).toBe('passed');
  expect(result.result.values).toEqual({ value: 6 });
  expect(
    (await api.request(endpoint, { cookie: user.cookie, method: 'POST', body }))
      .body,
  ).toEqual(result);
  await api.request(endpoint, {
    cookie: user.cookie,
    method: 'POST',
    body: { ...body, expected: { value: 9 } },
    status: 409,
  });
  const other = await signup(api, 'code-outsider');
  await api.request(`${endpoint}/${body.id}`, {
    cookie: other.cookie,
    status: 404,
  });
  await api.request(endpoint, {
    cookie: user.cookie,
    method: 'POST',
    body: { ...body, id: randomUUID(), reviewedDigest: 'a'.repeat(64) },
    status: 409,
  });
  const replay = { ...body, id: randomUUID() };
  await api.request(endpoint, {
    cookie: user.cookie,
    method: 'POST',
    body: replay,
  });
  const repeated = await until(async () => {
    const item = (
      await api.request(`${endpoint}/${replay.id}`, { cookie: user.cookie })
    ).body;

    return item.state !== 'running' && item;
  }, 'deterministic replay');
  expect(repeated.result.telemetry.inputDigest).toBe(
    result.result.telemetry.inputDigest,
  );
  const now = new Date().toISOString();
  const started = (
    await api.request(`${root}/starts`, {
      cookie: user.cookie,
      method: 'POST',
      body: {
        version: version.version,
        reviewedDigest: version.digest,
        subject: { kind: 'order', id: randomUUID() },
        signal: { kind: 'manual', sourceId: randomUUID(), occurredAt: now },
        context: {
          inputs: { quantity: 3 },
          evidence: {
            kind: 'stock',
            facts: {},
            observations: [
              { id: randomUUID(), observedAt: now, source: 'stock' },
            ],
          },
          provenance: { reference: 'code-test', capturedAt: now },
        },
      },
    })
  ).body;
  const pool = new Pool({ connectionString: db.runtimeUrl });
  t.onTestFinished(() => pool.end());
  const tenantDb = createTenantDatabase(pool);
  const previousDirectory = process.env.LUMA_CODE_RUNTIME_DIR;
  process.env.LUMA_CODE_RUNTIME_DIR = fileURLToPath(
    new URL('../../../.luma/code-runtime/', import.meta.url),
  );
  t.onTestFinished(() => {
    if (previousDirectory === undefined)
      delete process.env.LUMA_CODE_RUNTIME_DIR;
    else process.env.LUMA_CODE_RUNTIME_DIR = previousDirectory;
  });
  const runtime = createCodeProcesses(
    tenantDb,
    { resolveWorkflowContext: async () => context },
    { start: async () => undefined },
  );
  const run = await createWorkflowTriggerStore(tenantDb).run(
    context,
    started.id,
  );
  const progress = await runProcess(run, version, runtime.activities, {
    now: () => now,
    wait: async () => undefined,
    decisionChanged: async () => false,
  });
  expect(progress.state).toBe('ended');
  const stored = (
    await db.owner.query(
      'SELECT document FROM workflow_code_records WHERE tenant_id=$1 AND run_id=$2 AND record_key=$3',
      [org.id, run.id, 'result'],
    )
  ).rows[0].document.value;
  expect(stored.values).toEqual({ value: 6 });
  expect(stored.telemetry.outcome).toBe('completed');
  const loop = compileProcessWorkflow({
    ...version,
    digest: undefined,
    version: '2.0.0',
    steps: [
      defineCodeStep({
        ...version.steps[0],
        source: 'function main() { while(true) {} }',
        limits: {
          ...version.steps[0].limits,
          fuel: 1000000000,
          wallTimeMs: 30000,
        },
      }),
      version.steps[1],
    ],
  });
  await createWorkflows(tenantDb, {}, async () => context, {
    approvalRequirement: async () => ({
      mode: 'every_action',
      reason: 'minimum_risk',
    }),
  }).publish(context, loop);
  const cancelled = {
    ...body,
    id: randomUUID(),
    version: loop.version,
    reviewedDigest: loop.digest,
  };
  await api.request(endpoint, {
    cookie: user.cookie,
    method: 'POST',
    body: cancelled,
  });
  expect(
    (
      await api.request(`${endpoint}/${cancelled.id}/cancel`, {
        cookie: user.cookie,
        method: 'POST',
        body: {},
      })
    ).body.state,
  ).toBe('cancelled');
  expect(
    (await api.request(`${endpoint}/${cancelled.id}`, { cookie: user.cookie }))
      .body.state,
  ).toBe('cancelled');
});

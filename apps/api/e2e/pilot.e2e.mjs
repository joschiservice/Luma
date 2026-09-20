import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, expect, onTestFinished, test } from 'vitest';

import {
  respond,
  startJourney,
  waitFor,
} from '../../../tooling/pilot/journey.mjs';
import { createPilot } from '../../../tooling/pilot/runtime.mjs';
import { seedPilot } from '../../../tooling/pilot/seed.mjs';
import { database, secret, startProcess, until } from './helpers.mjs';

const require = createRequire(import.meta.url);

const { TestWorkflowEnvironment } = require('@temporalio/testing');

let temporal;

beforeAll(async () => {
  temporal = await TestWorkflowEnvironment.createLocal();
}, 60_000);

afterAll(async () => {
  await temporal?.teardown();
});

async function setup(t, scenario, options) {
  const db = await database(t);
  await db.migrate();
  await db.grantRuntime();
  const role = new URL(db.runtimeUrl).username;
  await db.owner.query(`GRANT luma_exceptions,luma_connectors TO "${role}"`);
  const directory = await mkdtemp(join(tmpdir(), 'luma-pilot-'));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const env = {
    IDENTITY_DATABASE_URL: db.runtimeUrl,
    WORKFLOW_DATABASE_URL: db.runtimeUrl,
    BETTER_AUTH_SECRET: secret,
    BETTER_AUTH_URL: 'http://127.0.0.1:3000',
    CONNECTIONS_ACTIVE_KEY_ID: 'test',
    CONNECTIONS_KEYS: JSON.stringify({
      test: randomBytes(32).toString('base64'),
    }),
  };
  const saved = { seedPassword: randomUUID() };
  const manifest = await seedPilot(saved, env, directory, scenario);
  const settings = {
    address: temporal.address,
    namespace: 'default',
    taskQueue: `luma-pilot-${manifest.runId}`,
    dataRegion: 'EU',
  };
  const pilot = await createPilot(env, directory, manifest, settings, options);
  const client = await pilot.runtime.createClient();
  t.onTestFinished(async () => {
    await client.close();
    await pilot.close();
  });

  return { db, directory, env, saved, manifest, pilot, client };
}

test('seed reuses its run, covers four classes and keeps simulated health pending', async (t) => {
  const f = await setup(t, 'diagnosis-pending');
  expect(await seedPilot(f.saved, f.env, f.directory)).toEqual(f.manifest);
  const actor = await f.pilot.context();
  const incidents = await f.pilot.detection.exceptions.list(actor);
  expect(incidents.map((item) => item.exceptionClass).sort()).toEqual([
    'inventory_mismatch',
    'stuck_fulfillment',
    'sync_failure',
    'workflow_failure',
  ]);
  expect(
    await f.pilot.detection.diagnoses.get(
      actor,
      f.manifest.incidents.workflow_failure,
    ),
  ).toMatchObject({ status: 'pending' });
  expect(
    (
      await f.db.owner.query(
        "SELECT document->>'status' AS status FROM connector_installations",
      )
    ).rows,
  ).toEqual([{ status: 'pending' }, { status: 'pending' }]);
  const before = (
    await f.db.owner.query('SELECT count(*) FROM exception_evaluations')
  ).rows;
  await seedPilot(f.saved, f.env, f.directory);
  expect(
    (await f.db.owner.query('SELECT count(*) FROM exception_evaluations')).rows,
  ).toEqual(before);
});

test.each(['healthy', 'decisions-needed', 'uncertain'])(
  'reproduces %s without executing',
  async (scenario) => {
    const t = { onTestFinished };
    const f = await setup(t, scenario);
    await startJourney(f.pilot, f.manifest, f.client);
    const incidents = await f.pilot.detection.exceptions.list(
      await f.pilot.context(),
    );
    expect(incidents).toHaveLength(scenario === 'healthy' ? 0 : 4);
    if (scenario !== 'healthy')
      expect(
        await f.pilot.detection.diagnoses.get(
          await f.pilot.context(),
          f.manifest.incidents.workflow_failure,
        ),
      ).toMatchObject({
        status: scenario === 'uncertain' ? 'insufficient_evidence' : 'ready',
      });
    expect((await f.pilot.provider()).effects).toHaveLength(0);
  },
);

test.each(['approval-required', 'rejected', 'resolved', 'failed'])(
  'real workflow reaches %s through policy and persisted evidence',
  async (scenario) => {
    const t = { onTestFinished };
    const f = await setup(t, scenario);
    const worker = await f.pilot.runtime.createWorker();
    const running = worker.run();
    t.onTestFinished(async () => {
      worker.shutdown();
      await running;
      await worker.close();
    });
    await startJourney(f.pilot, f.manifest, f.client);
    const actor = await f.pilot.context();
    const source = {
      kind: 'incident',
      id: f.manifest.incidents.workflow_failure,
    };
    const phase = {
      'approval-required': 'awaiting_approval',
      rejected: 'denied',
      resolved: 'resolved',
      failed: 'escalated',
    }[scenario];
    await waitFor(
      async () => (await f.client.progress(actor, source))?.phase === phase,
    );
    expect((await f.pilot.provider()).effects).toHaveLength(
      scenario === 'resolved' ? 1 : 0,
    );
    const incident = await f.pilot.detection.exceptions.get(actor, source.id);
    expect(incident.state === 'resolved').toBe(scenario === 'resolved');
    const playbook = await f.pilot.playbooks.get(actor, f.manifest.proposalId);
    expect(playbook.version.provenance.kind).toBe('pilot');
    expect(playbook.run.versionDigest).toBe(playbook.version.digest);
    expect(playbook.run.snapshot.inputs).toEqual({ shippingMethodId: '8' });
    expect(playbook.outcomes.length).toBeGreaterThan(0);
    if (scenario === 'resolved') {
      expect(playbook.outcomes.at(-1)).toMatchObject({
        state: 'verified',
        stepId: 'verify-correction',
      });
      expect(incident.resolution).toMatchObject({
        kind: 'verification',
        outcome: 'passed',
      });
      expect(
        (await f.db.owner.query('SELECT count(*)::int AS n FROM audit_entries'))
          .rows[0].n,
      ).toBeGreaterThan(0);
    }
    if (scenario === 'approval-required') {
      const review = await f.pilot.desk.review(actor, source.id);
      expect(review.permittedDecisions).not.toContain('approve');
      expect(
        (await f.pilot.desk.review(await f.pilot.operator(), source.id))
          .permittedDecisions,
      ).toContain('approve');
      await respond(f.pilot, f.manifest, f.client, 'reject');
      await waitFor(
        async () =>
          (await f.client.progress(actor, source))?.phase === 'denied',
      );
    }
  },
);

test.each(['executing', 'verifying'])(
  'exposes %s before verified resolution',
  async (scenario) => {
    const t = { onTestFinished };
    const { promise: paused, resolve: release } = Promise.withResolvers();
    const f = await setup(t, scenario, { pause: () => paused });
    const worker = await f.pilot.runtime.createWorker();
    const running = worker.run();
    t.onTestFinished(async () => {
      release();
      worker.shutdown();
      await running;
      await worker.close();
    });
    await startJourney(f.pilot, f.manifest, f.client);
    const actor = await f.pilot.context();
    const source = {
      kind: 'incident',
      id: f.manifest.incidents.workflow_failure,
    };
    await waitFor(
      async () => (await f.client.progress(actor, source))?.phase === scenario,
    );
    expect(
      (await f.pilot.detection.exceptions.get(actor, source.id)).state,
    ).not.toBe('resolved');
    release();
    await waitFor(
      async () =>
        (await f.client.progress(actor, source))?.phase === 'resolved',
    );
    expect((await f.pilot.provider()).patchRequests).toBe(1);
  },
);

test('worker death after provider commit reconciles without a second PATCH', async (t) => {
  const f = await setup(t, 'recovery');
  const script = new URL('../../../tooling/pilot/process.mjs', import.meta.url)
    .pathname;
  // Use a small entrypoint because the E2E process helper accepts one script path.
  const { writeFile } = await import('node:fs/promises');
  const entry = join(f.directory, 'worker.mjs');
  await writeFile(
    entry,
    `process.argv.push('--worker'); await import(${JSON.stringify(script)});`,
  );
  const env = {
    ...f.env,
    LUMA_PILOT_DIRECTORY: f.directory,
    TEMPORAL_ADDRESS: temporal.address,
  };
  const first = startProcess(t, entry, env);
  await until(
    async () =>
      (await f.pilot.provider()).effects.length === 1 ||
      (first.result &&
        (() => {
          throw new Error(first.output);
        })()),
    'provider commit',
    30_000,
  );
  first.child.kill('SIGKILL');
  await first.wait();
  const second = startProcess(t, entry, env);
  const source = {
    kind: 'incident',
    id: f.manifest.incidents.workflow_failure,
  };
  const actor = await f.pilot.context();
  await waitFor(async () => {
    if (second.result) throw new Error(second.output);

    return (await f.client.progress(actor, source))?.phase === 'resolved';
  }, 90_000);
  expect((await f.pilot.provider()).effects).toHaveLength(1);
  expect((await f.pilot.provider()).patchRequests).toBe(1);
  expect(
    await f.pilot.detection.exceptions.get(actor, source.id),
  ).toMatchObject({ state: 'resolved', resolution: { kind: 'verification' } });
}, 120_000);

async function operatorRequest(f) {
  const origin = f.env.BETTER_AUTH_URL;
  const login = await f.pilot.app.inject({
    method: 'POST',
    url: '/auth/sign-in/email',
    headers: { origin },
    payload: {
      email: 'pilot-operator@example.test',
      password: f.saved.seedPassword,
    },
  });
  expect(login.statusCode).toBe(200);
  const cookies = login.headers['set-cookie'];
  const cookie = (Array.isArray(cookies) ? cookies : [cookies])
    .map((value) => value.split(';')[0])
    .join('; ');

  return (url, payload) =>
    f.pilot.app.inject({
      method: payload ? 'POST' : 'GET',
      url,
      headers: { origin, cookie },
      ...(payload ? { payload } : {}),
    });
}

test.each(['before', 'after'])(
  'disconnect %s approval prevents fixture dispatch',
  async (timing) => {
    const f = await setup({ onTestFinished }, 'approval-required');
    const worker = await f.pilot.runtime.createWorker();
    const running = worker.run();
    try {
      await startJourney(f.pilot, f.manifest, f.client);
    } finally {
      worker.shutdown();
      await running;
      await worker.close();
    }
    const actor = await f.pilot.context();
    const id = f.manifest.incidents.workflow_failure;
    const proposal = await f.pilot.desk.proposal(actor, f.manifest.proposalId);
    if (timing === 'after')
      await respond(f.pilot, f.manifest, f.client, 'approve');
    const request = await operatorRequest(f);
    const base = `/v1/organizations/${f.manifest.organizationId}`;
    const disconnected = await request(
      `${base}/connections/${f.manifest.connections.jtl}/disconnect`,
      { version: 1 },
    );
    expect(disconnected.statusCode).toBe(200);
    const review = await request(`${base}/exceptions/${id}/review`);
    expect(review.statusCode).toBe(200);
    expect(review.json().proposal.available).toBe(false);
    expect(review.json().permittedDecisions).not.toContain('approve');
    if (timing === 'before')
      await expect(
        respond(f.pilot, f.manifest, f.client, 'approve'),
      ).rejects.toMatchObject({ statusCode: 409 });
    expect(
      await f.pilot.safety.execution.execute(actor, {
        runId: proposal.action.id,
        stepId: 'correct-shipping-method',
      }),
    ).toMatchObject({
      state: 'denied',
      decision: { reason: 'capability_unavailable' },
    });
    expect((await f.pilot.provider()).effects).toHaveLength(0);
    expect((await f.pilot.provider()).patchRequests ?? 0).toBe(0);
  },
);

test('health checks reject non-pilot connections without changing their health or history', async (t) => {
  const f = await setup(t, 'healthy');
  const other = await seedPilot(f.saved, f.env, f.directory, 'healthy', true);
  const request = await operatorRequest(f);
  const installed = await request(
    `/v1/organizations/${f.manifest.organizationId}/connections`,
    {
      label: 'Existing connected store',
      target: { kind: 'shopify', shop: 'existing.myshopify.com' },
      permissions: ['orders.read'],
      credentials: { token: 'synthetic-test-token' },
    },
  );
  expect(installed.statusCode).toBe(201);
  const targets = [
    {
      organizationId: other.organizationId,
      connectionId: other.connections.jtl,
    },
    {
      organizationId: f.manifest.organizationId,
      connectionId: installed.json().id,
    },
  ];
  for (const target of targets) {
    await f.db.owner.query(
      `UPDATE connector_installations SET document = document || '{"status":"active","granted":["orders.read"]}'::jsonb WHERE id=$1`,
      [target.connectionId],
    );
    const snapshot = async () => ({
      connection: (
        await f.db.owner.query(
          'SELECT * FROM connector_installations WHERE id=$1',
          [target.connectionId],
        )
      ).rows,
      events: (
        await f.db.owner.query(
          'SELECT * FROM connector_lifecycle_events ORDER BY tenant_id,connection_id,version',
        )
      ).rows,
    });
    const before = await snapshot();
    const checked = await request(
      `/v1/organizations/${target.organizationId}/connections/${target.connectionId}/check`,
      { version: 1 },
    );
    expect(checked.statusCode).toBe(404);
    expect(await snapshot()).toEqual(before);
  }
  const checked = await request(
    `/v1/organizations/${f.manifest.organizationId}/connections/${f.manifest.connections.jtl}/check`,
    { version: 1 },
  );
  expect(checked.statusCode).toBe(200);
  expect(checked.json().status).toBe('degraded');
});

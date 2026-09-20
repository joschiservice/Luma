import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, expect, test, onTestFinished } from 'vitest';
import { seedPilot } from '../../../tooling/pilot/seed.mjs';
import { createPilot } from '../../../tooling/pilot/runtime.mjs';
import {
  startJourney,
  respond,
  waitFor,
} from '../../../tooling/pilot/journey.mjs';
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

async function setup(t, scenario) {
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
  const pilot = await createPilot(env, directory, manifest, settings);
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
    if (scenario === 'resolved') {
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
    await waitFor(
      async () => (await f.client.progress(actor, source))?.phase === scenario,
    );
    expect(
      (await f.pilot.detection.exceptions.get(actor, source.id)).state,
    ).not.toBe('resolved');
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

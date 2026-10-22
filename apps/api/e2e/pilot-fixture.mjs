import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, expect } from 'vitest';

import { createPilot } from '../../../tooling/pilot/runtime.mjs';
import { seedPilot } from '../../../tooling/pilot/seed.mjs';
import { database, secret } from './helpers.mjs';

const require = createRequire(import.meta.url);

const { TestWorkflowEnvironment } = require('@temporalio/testing');

/**
 * Starts one local Temporal server for the calling journey file and stops it after the file's
 * tests. Call at the top level of the file. `setup` seeds a pilot scenario into its own database
 * and directory and composes the pilot runtime on that server with a per-run task queue; the
 * runtime, client and directory are released when the test finishes.
 */
export function pilotFixture() {
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
      AUTH_RATE_LIMIT: 'off',
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
      dataRegion: globalThis.process.env.LUMA_REGION ?? 'AU',
    };
    const pilot = await createPilot(
      env,
      directory,
      manifest,
      settings,
      options,
    );
    const client = await pilot.runtime.createClient();
    t.onTestFinished(async () => {
      await client.close();
      await pilot.close();
    });

    return { db, directory, env, saved, manifest, pilot, client };
  }

  return { setup, temporalAddress: () => temporal.address };
}

/** Signs in as the seeded pilot operator and returns a request function carrying the session. */
export async function operatorRequest(f) {
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

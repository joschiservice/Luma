import { assert, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

export const apiDirectory = fileURLToPath(new URL('../', import.meta.url));
export const secret = 'backend-e2e-secret-at-least-32-characters';

export async function until(check, description, timeout = 15_000) {
  try {
    return await vi.waitUntil(check, { timeout, interval: 25 });
  } catch (cause) {
    throw new Error(`Failed waiting for ${description}`, { cause });
  }
}

export function startProcess(t, script, env = {}, ipc = false) {
  const child = spawn(process.execPath, [script], {
    cwd: apiDirectory,
    // Do not inherit developer credentials, telemetry exporters, or NODE_OPTIONS.
    env: { PATH: process.env.PATH, NODE_ENV: 'test', ...env },
    stdio: ['ignore', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])],
  });
  let output = '';
  let result;
  const messages = [];
  child.stdout.on('data', (data) => {
    output += data;
  });
  child.stderr.on('data', (data) => {
    output += data;
  });
  child.on('message', (message) => messages.push(message));
  child.on('error', (error) => {
    result = { error };
  });
  child.on('close', (code, signal) => {
    result = { code, signal };
  });
  const wait = () =>
    until(() => result, `process exit: ${script}`).catch((error) => {
      throw new Error(`${error.message}\n${output}`);
    });
  t.onTestFinished(async () => {
    if (!result) child.kill('SIGKILL');
    await wait();
  });
  return {
    child,
    get output() {
      return output;
    },
    get result() {
      return result;
    },
    wait,
    async message(type) {
      return until(() => {
        const message = messages.find((value) => value.type === type);
        if (message) return message;
        if (result) throw new Error(`Process exited before ${type}: ${output}`);
      }, type);
    },
  };
}

export async function database(t) {
  assert.ok(
    process.env.TEST_DATABASE_URL,
    'TEST_DATABASE_URL is required for backend E2E tests',
  );
  const id = `e2e_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  let owner;
  t.onTestFinished(async () => {
    try {
      await owner?.end();
      await admin.query(`DROP DATABASE IF EXISTS "${id}" WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS "${id}"`);
    } finally {
      await admin.end();
    }
  });
  await admin.query(`CREATE DATABASE "${id}"`);
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.pathname = `/${id}`;
  const ownerUrl = url.toString();
  owner = new Pool({ connectionString: ownerUrl });
  const password = randomUUID();
  await admin.query(
    `CREATE ROLE "${id}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
  );
  url.username = id;
  url.password = password;
  return {
    owner,
    ownerUrl,
    runtimeUrl: url.toString(),
    async migrate(script = 'scripts/migrate.mjs', expectedCode = 0) {
      // Shared runtime roles are cluster-wide, including across integration suites.
      const lock = await admin.connect();
      try {
        await lock.query(
          "SELECT pg_advisory_lock(hashtext('luma_test_role_setup'))",
        );
        const migration = startProcess(t, script, {
          MIGRATION_DATABASE_URL: ownerUrl,
        });
        assert.strictEqual(
          (await migration.wait()).code,
          expectedCode,
          migration.output,
        );
        return migration.output;
      } finally {
        await lock.query(
          "SELECT pg_advisory_unlock(hashtext('luma_test_role_setup'))",
        );
        lock.release();
      }
    },
    async grantRuntime() {
      await admin.query(
        `GRANT luma_identity,luma_policies,luma_execution,luma_audit TO "${id}"`,
      );
    },
  };
}

export async function startApi(t, db) {
  const browserOrigin = 'http://localhost:3000';
  const process = startProcess(
    t,
    'dist/index.js',
    {
      HOST: '127.0.0.1',
      PORT: '0',
      LOG_LEVEL: 'silent',
      IDENTITY_DATABASE_URL: db.runtimeUrl,
      BETTER_AUTH_SECRET: secret,
      BETTER_AUTH_URL: browserOrigin,
      OBSERVABILITY_ENVIRONMENT: 'test',
    },
    true,
  );
  const { address: origin } = await process.message('listening');
  const address = new URL(origin);
  assert.strictEqual(address.hostname, '127.0.0.1');
  assert.ok(Number(address.port) > 0, 'API must report its assigned port');
  await until(async () => {
    if (process.result) throw new Error(`API exited: ${process.output}`);
    try {
      const response = await fetch(`${origin}/ready`, {
        signal: AbortSignal.timeout(500),
      });
      return response.status === 200;
    } catch {
      return false;
    }
  }, 'API readiness');
  return {
    origin,
    process,
    async request(path, { method = 'GET', cookie, body, status = 200 } = {}) {
      const response = await fetch(`${origin}${path}`, {
        method,
        headers: {
          origin: browserOrigin,
          ...(cookie ? { cookie } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(5000),
      });
      const text = await response.text();
      assert.strictEqual(response.status, status, `${method} ${path}: ${text}`);
      return {
        body: text ? JSON.parse(text) : null,
        headers: response.headers,
      };
    },
  };
}

export async function signup(api, name) {
  const response = await api.request('/auth/sign-up/email', {
    method: 'POST',
    body: {
      name,
      email: `${name}@example.test`,
      password: 'long-e2e-test-password',
    },
  });
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  assert.ok(cookie, 'Signup must issue a session cookie');
  return { cookie, userId: response.body.user.id };
}

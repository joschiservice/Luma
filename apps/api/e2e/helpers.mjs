import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

export const apiDirectory = fileURLToPath(new URL('../', import.meta.url));

export const runtimeDirectory = fileURLToPath(
  new URL('../../../packages/application-runtime/', import.meta.url),
);

export const secret = 'backend-e2e-secret-at-least-32-characters';

/** Waits for a truthy result, propagating check errors and rejecting at the deadline. */
export async function until(check, description, timeout = 15_000) {
  try {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const result = await check();
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('Condition timed out');
  } catch (cause) {
    throw new Error(`Failed waiting for ${description}`, { cause });
  }
}

/** Starts an isolated child process and registers forced shutdown with the test cleanup context. */
export function startProcess(t, script, env = {}, ipc = false) {
  /** @type {import('node:child_process').ChildProcess} */
  const child = spawn(process.execPath, [script], {
    cwd: apiDirectory,
    // Do not inherit developer credentials, telemetry exporters, or NODE_OPTIONS.
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      SHOPIFY_ADMISSION_URL: process.env.SHOPIFY_ADMISSION_URL,
      LUMA_REGION: process.env.LUMA_REGION ?? 'AU',
      LUMA_ENABLED_REGIONS: process.env.LUMA_REGION ?? 'AU',
      ...env,
    },
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
    if (t.failed && output) {
      await t.attach?.(`${script}-${child.pid}.log`, {
        body: Buffer.from(output),
        contentType: 'text/plain',
      });
    }
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

/** Shared runtime roles that `database(t).grantRuntime()` grants a journey's login. */
export const runtimeRoles = [
  'luma_identity',
  'luma_workflow_identity',
  'luma_case_reader',
  'luma_desk',
  'luma_policies',
  'luma_execution',
  'luma_audit',
  'luma_connectors',
  'luma_commerce_sync',
  'luma_sales',
  'luma_adaptive',
];

/**
 * Creates an isolated database and restricted login; the context must register teardown
 * callbacks. The database is a copy of the run's migrated template when one exists, so
 * `migrate()` with the default script has nothing left to do. Pass `empty: true` for a test
 * that migrates the database itself, or `template` to copy another migrated database, such
 * as an imported scenario snapshot, that nobody is connected to.
 */
export async function database(t, { empty = false, template: source } = {}) {
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
      await admin.query(`DROP DATABASE IF EXISTS "${id}"`);
      await admin.query(`DROP ROLE IF EXISTS "${id}"`);
    } finally {
      await admin.end();
    }
  });
  const template = empty
    ? undefined
    : (source ?? process.env.LUMA_E2E_TEMPLATE_DATABASE);
  await admin.query(
    `CREATE DATABASE "${id}"${template ? ` TEMPLATE "${template}"` : ''}`,
  );
  const migrated = Boolean(template);
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
    async migrate(
      script = `${runtimeDirectory}/scripts/migrate.mjs`,
      expectedCode = 0,
    ) {
      // A copy of the template is already migrated and provisioned for the run's region.
      if (
        migrated &&
        script === `${runtimeDirectory}/scripts/migrate.mjs` &&
        expectedCode === 0
      )
        return '';
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

        if (expectedCode === 0)
          await owner.query('SELECT luma_provision_cell_region($1)', [
            process.env.LUMA_REGION ?? 'AU',
          ]);

        return migration.output;
      } finally {
        await lock.query(
          "SELECT pg_advisory_unlock(hashtext('luma_test_role_setup'))",
        );
        lock.release();
      }
    },
    async grantRuntime() {
      await admin.query(`GRANT ${runtimeRoles.join(',')} TO "${id}"`);
    },
  };
}

/**
 * Writes a membership directly with the database owner pool and returns its ID. Customers add
 * people only through invitations; journeys that need extra members use this fixture instead.
 * `roleId` is a built-in role key or a custom role ID. Like a real member change, it also
 * records the `member.add` workspace access event, attributed to `actorId` or else the
 * workspace's first owner, or the added person when the workspace has no owner yet.
 */
export async function addMembership(
  owner,
  tenantId,
  userId,
  roleId,
  actorId = null,
) {
  const builtIn = { owner: 'Owner', admin: 'Admin', member: 'Member' };
  const custom = !Object.hasOwn(builtIn, roleId);
  const id = randomUUID();
  await owner.query(
    `WITH added AS (
      INSERT INTO memberships(id,tenant_id,user_id,role,custom_role_id,created_at)
      VALUES($1,$2,$3,$4,$5,now()) RETURNING id
    )
    INSERT INTO workspace_access_events(id,tenant_id,actor_id,event_type,target_id,before_value,after_value)
    SELECT $6,$2,COALESCE($7::uuid,(SELECT user_id FROM memberships WHERE tenant_id=$2 AND role='owner'
      ORDER BY created_at LIMIT 1),$3::uuid),'member.add',added.id::text,'null'::jsonb,
      jsonb_build_object('id',added.id,'userId',$3::text,'roleId',$8::text,'roleName',
        COALESCE($9::text,(SELECT name FROM workspace_roles WHERE tenant_id=$2 AND id::text=$8::text)))
    FROM added`,
    [
      id,
      tenantId,
      userId,
      custom ? 'custom' : roleId,
      custom ? roleId : null,
      randomUUID(),
      actorId,
      roleId,
      custom ? null : builtIn[roleId],
    ],
  );

  return id;
}

/** Starts the built API on an assigned port and waits for readiness. */
export async function startApi(
  t,
  db,
  browserOrigin = 'http://localhost:3000',
  script = 'dist/composition/bootstrap.js',
  env = {},
) {
  const process = startProcess(
    t,
    script,
    {
      HOST: '127.0.0.1',
      PORT: '0',
      LOG_LEVEL: 'silent',
      IDENTITY_DATABASE_URL: db.runtimeUrl,
      BETTER_AUTH_SECRET: secret,
      BETTER_AUTH_URL: browserOrigin,
      OBSERVABILITY_ENVIRONMENT: 'test',
      // Journeys sign in many times from one loopback address; limits have their own tests.
      AUTH_RATE_LIMIT: 'off',
      ...env,
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
    db,
    /**
     * Sends a JSON request as the trusted browser origin and asserts the response status.
     * Prefer the typed client in `typed-client.mjs` for contract routes.
     * @param {string} path
     * @param {{ method?: string; cookie?: string; body?: unknown; status?: number }} [options]
     */
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

/**
 * Confirms a test account's email address directly, as following the emailed link would.
 * `owner` is the test database's owner pool.
 */
export async function verifyEmail(owner, email) {
  const result = await owner.query(
    'UPDATE users SET email_verified=true WHERE email=$1',
    [email.toLowerCase()],
  );
  assert.strictEqual(result.rowCount, 1, `No account for ${email}`);
}

/**
 * Registers a test user, confirms its email address and signs in. Returns the session cookie
 * and identifier. `api` must come from `startApi`.
 */
export async function signup(api, name) {
  const email = `${name}@example.test`;
  const password = 'long-e2e-test-password';
  const response = await api.request('/auth/sign-up/email', {
    method: 'POST',
    body: {
      name,
      email,
      password,
      dataRegion: globalThis.process.env.LUMA_REGION ?? 'AU',
    },
  });
  assert.strictEqual(
    response.headers.getSetCookie().length,
    0,
    'Signup must not issue a session before the email is confirmed',
  );
  await verifyEmail(api.db.owner, email);
  const signedIn = await api.request('/auth/sign-in/email', {
    method: 'POST',
    body: { email, password },
  });
  const cookie = signedIn.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  assert.ok(cookie, 'Sign-in must issue a session cookie');

  return { cookie, userId: response.body.user.id };
}

/**
 * Creates an account through the web sign-up form, confirms its email address in the database
 * and signs in through the sign-in form. The page then shows what follows sign-in, such as
 * workspace creation for a new account.
 */
export async function createAccount(
  page,
  db,
  { name, email, password, region = /Australia/ },
) {
  await page.goto('/sign-up');
  await page.getByRole('radio', { name: region }).check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  const registered = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/auth/sign-up/email') &&
      response.request().method() === 'POST',
  );
  await page
    .getByRole('button', { name: 'Create account', exact: true })
    .click();
  const response = await registered;
  assert.strictEqual(response.status(), 200, await response.text());
  await confirmAndSignIn(page, db, email, password);
}

/**
 * Confirms a registered account's email address in the database and signs in through the web
 * sign-in form, returning to the application.
 */
export async function confirmAndSignIn(page, db, email, password) {
  await verifyEmail(db.owner, email);
  await page.goto('/sign-in');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

/** Reserves and releases a loopback port for a test server to bind. */
export async function availablePort() {
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));

  return port;
}

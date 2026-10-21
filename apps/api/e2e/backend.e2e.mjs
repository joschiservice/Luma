import { randomUUID } from 'node:crypto';
import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
} from 'node:fs/promises';
import { join } from 'node:path';

import { assert, test } from 'vitest';

import {
  apiDirectory,
  database,
  runtimeDirectory,
  secret,
  signup,
  startApi,
  startProcess,
} from './helpers.mjs';

async function temporaryDirectory(t) {
  // Keeping copies under the API package preserves the migration runner's pg resolution.
  const directory = await mkdtemp(join(apiDirectory, '.e2e-'));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));

  return directory;
}

async function provision(t) {
  const db = await database(t);
  await db.migrate();
  await db.grantRuntime();

  return db;
}

test('built API supports the identity lifecycle over HTTP and survives restart', async (t) => {
  const db = await provision(t);
  const [first, second] = await Promise.all([startApi(t, db), startApi(t, db)]);
  assert.notStrictEqual(first.origin, second.origin);
  second.process.child.kill('SIGTERM');
  assert.deepStrictEqual(await second.process.wait(), {
    code: 0,
    signal: null,
  });
  let api = first;
  assert.deepStrictEqual((await api.request('/health')).body, { status: 'ok' });
  await api.request('/v1/organizations', { status: 401 });
  const alice = await signup(api, 'alice');
  const organization = (
    await api.request('/v1/organizations', {
      method: 'POST',
      cookie: alice.cookie,
      body: { name: 'E2E organization', slug: 'e2e-organization' },
      status: 201,
    })
  ).body;
  assert.strictEqual(
    organization.dataRegion,
    globalThis.process.env.LUMA_REGION ?? 'AU',
  );
  const contextPath = `/v1/organizations/${organization.id}/context`;
  const context = (await api.request(contextPath, { cookie: alice.cookie }))
    .body;
  assert.strictEqual(context.tenantId, organization.id);
  assert.strictEqual(context.actor.id, alice.userId);
  assert.strictEqual(context.actor.role.key, 'owner');
  const bob = await signup(api, 'bob');
  assert.deepStrictEqual(
    (await api.request('/v1/organizations', { cookie: bob.cookie })).body.items,
    [],
  );
  await api.request(contextPath, { cookie: bob.cookie, status: 404 });

  api.process.child.kill('SIGTERM');
  assert.deepStrictEqual(await api.process.wait(), { code: 0, signal: null });
  api = await startApi(t, db);
  assert.deepStrictEqual(
    (await api.request('/v1/organizations', { cookie: alice.cookie })).body
      .items,
    // The list adds the caller's membership status to each workspace; an open workspace has
    // no deletion date.
    [
      {
        ...organization,
        membershipStatus: 'active',
        dataDeletionAt: null,
        dataDeletedAt: null,
      },
    ],
  );
  await api.request(contextPath, { cookie: alice.cookie });
  await api.request('/auth/sign-out', {
    method: 'POST',
    cookie: alice.cookie,
    body: {},
  });
  await api.request(contextPath, { cookie: alice.cookie, status: 401 });
  await api.request('/v1/organizations', {
    cookie: alice.cookie,
    status: 401,
  });
  api.process.child.kill('SIGTERM');
  assert.deepStrictEqual(await api.process.wait(), { code: 0, signal: null });
});

test('migration command installs, reruns unchanged, and rejects a changed applied migration atomically', async (t) => {
  const db = await database(t, { empty: true });
  const names = (await readdir(join(runtimeDirectory, 'migrations')))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  // Installed apps ship their own migrations, recorded under the app's name.
  const appsDirectory = join(runtimeDirectory, '../apps');
  const appNames = [];
  for (const app of (await readdir(appsDirectory)).sort())
    appNames.push(
      ...(await readdir(join(appsDirectory, app, 'migrations')).catch(() => []))
        .filter((name) => name.endsWith('.sql'))
        .sort()
        .map((name) => `app:${app}/${name}`),
    );
  const output = await db.migrate();
  for (const name of [...names, ...appNames])
    assert.ok(output.includes(`Applied ${name}`));
  const before = (
    await db.owner.query('SELECT * FROM identity_migrations ORDER BY name')
  ).rows;
  assert.deepStrictEqual(
    before.map((row) => row.name).sort(),
    [...names, ...appNames].sort(),
  );
  await db.owner.query(
    "INSERT INTO users(id, name, email, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000001', 'Migration user', 'migration@example.test', now(), now())",
  );
  assert.strictEqual(await db.migrate(), '');
  assert.deepStrictEqual(
    (await db.owner.query('SELECT * FROM identity_migrations ORDER BY name'))
      .rows,
    before,
  );
  assert.strictEqual(
    (
      await db.owner.query(
        "SELECT id FROM users WHERE id='00000000-0000-4000-8000-000000000001'",
      )
    ).rowCount,
    1,
  );

  const directory = await temporaryDirectory(t);
  await mkdir(join(directory, 'scripts'));
  await cp(
    join(runtimeDirectory, 'scripts/migrate.mjs'),
    join(directory, 'scripts/migrate.mjs'),
  );
  await cp(
    join(runtimeDirectory, 'migrations'),
    join(directory, 'migrations'),
    {
      recursive: true,
    },
  );
  // Sort a pending migration before the checksum failure to prove transaction rollback.
  await appendFile(
    join(directory, 'migrations/0000_e2e_pending.sql'),
    'CREATE TABLE e2e_migration_probe (id integer);\n',
  );
  await appendFile(
    join(directory, 'migrations', names[0]),
    '\n-- Changed applied migration fixture.\n',
  );
  const failure = await db.migrate(join(directory, 'scripts/migrate.mjs'), 1);
  assert.ok(failure.includes(`Applied migration changed: ${names[0]}`));
  assert.deepStrictEqual(
    (await db.owner.query('SELECT * FROM identity_migrations ORDER BY name'))
      .rows,
    before,
  );
  assert.strictEqual(
    (
      await db.owner.query(
        "SELECT to_regclass('e2e_migration_probe') AS table_name",
      )
    ).rows[0].table_name,
    null,
  );
  assert.strictEqual(
    (
      await db.owner.query(
        "SELECT id FROM users WHERE id='00000000-0000-4000-8000-000000000001'",
      )
    ).rowCount,
    1,
  );
  assert.strictEqual(await db.migrate(), '');
});

test('SIGKILL after a committed effect recovers in a fresh worker without redelivery', async (t) => {
  const db = await provision(t);
  const api = await startApi(t, db);
  const actor = await signup(api, 'worker-owner');
  const organization = (
    await api.request('/v1/organizations', {
      method: 'POST',
      cookie: actor.cookie,
      body: { name: 'Worker organization', slug: 'worker-organization' },
      status: 201,
    })
  ).body;
  // This journey exercises a provider write; new workspaces otherwise stay observe-only.
  await api.request(
    `/v1/organizations/${organization.id}/settings/write-mode`,
    {
      method: 'PATCH',
      cookie: actor.cookie,
      body: {
        commandId: randomUUID(),
        revision: 0,
        writeMode: 'writes_enabled',
      },
    },
  );
  const directory = await temporaryDirectory(t);
  const ledger = join(directory, 'provider-effects.jsonl');
  const action = {
    schemaVersion: 1,
    id: randomUUID(),
    tenantId: organization.id,
    capability: 'stock.correct',
    capabilityVersion: '1',
    connectionId: randomUUID(),
    target: { kind: 'sku', id: randomUUID() },
    parameters: { quantity: 3 },
    preconditions: {
      evidenceRefs: [randomUUID()],
      validUntil: new Date(Date.now() + 120_000).toISOString(),
    },
    expectedPostcondition: { quantity: 3 },
    risk: 'low',
    proposedBy: { kind: 'user', id: actor.userId },
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
  };
  const input = {
    databaseUrl: db.runtimeUrl,
    secret,
    origin: api.origin,
    cookie: actor.cookie,
    action,
    ledger,
  };
  const worker = startProcess(t, 'e2e/execution-worker.mjs', {}, true);
  worker.child.send({ ...input, mode: 'interrupt' });
  await worker.message('effect-committed');
  const records = async () =>
    (
      await db.owner.query(
        'SELECT document FROM executed_actions WHERE tenant_id=$1 AND proposal_id=$2',
        [organization.id, action.id],
      )
    ).rows.map((row) => row.document);
  const prepared = await records();
  assert.strictEqual(prepared.length, 1);
  assert.strictEqual(prepared[0].state, 'prepared');
  assert.strictEqual(prepared[0].attempt.finishedAt, undefined);
  worker.child.kill('SIGKILL');
  assert.deepStrictEqual(await worker.wait(), {
    code: null,
    signal: 'SIGKILL',
  });

  const recovery = startProcess(t, 'e2e/execution-worker.mjs', {}, true);
  recovery.child.send({ ...input, mode: 'recover' });
  const result = await recovery.message('recovered');
  assert.deepStrictEqual(
    await recovery.wait(),
    { code: 0, signal: null },
    recovery.output,
  );
  assert.strictEqual(result.replay.state, 'reconciliation_required');
  assert.strictEqual(result.reconciled.state, 'succeeded');
  assert.strictEqual(result.repeated.state, 'succeeded');
  const completed = await records();
  assert.strictEqual(completed.length, 1);
  assert.strictEqual(completed[0].state, 'succeeded');
  assert.strictEqual(completed[0].attempt.id, prepared[0].attempt.id);
  assert.strictEqual(completed[0].attempt.number, 1);
  assert.strictEqual(completed[0].attempt.verification.outcome, 'passed');
  const effects = (await readFile(ledger, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepStrictEqual(effects, [
    { proposalId: action.id, key: `v0:${action.id}`, quantity: 3 },
  ]);
  const events = (
    await db.owner.query(
      'SELECT document FROM audit_entries WHERE tenant_id=$1 AND proposal_id=$2 ORDER BY created_at',
      [organization.id, action.id],
    )
  ).rows.map((row) => row.document.eventType);
  assert.deepStrictEqual(events, [
    'policy.evaluated',
    'execution.prepared',
    'execution.reconciled',
  ]);
  assert.strictEqual(
    (
      await db.owner.query(
        'SELECT count(*)::int AS count FROM execution_outbox WHERE tenant_id=$1 AND proposal_id=$2 AND delivered_at IS NULL',
        [organization.id, action.id],
      )
    ).rows[0].count,
    0,
  );
});

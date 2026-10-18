import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Pool } from 'pg';
import { afterAll, beforeAll, expect, onTestFinished, test } from 'vitest';

import {
  respond,
  startJourney,
  waitFor,
} from '../../../tooling/pilot/journey.mjs';
import { mutateProviderState } from '../../../tooling/pilot/provider-state.mjs';
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

test('concurrent pilot processes preserve provider updates and bound diagnostics', async (t) => {
  const f = await setup(t, 'diagnosis-pending');
  const path = join(f.directory, `provider-${f.manifest.runId}.json`);
  const pools = [0, 1].map(
    () => new Pool({ connectionString: f.env.WORKFLOW_DATABASE_URL }),
  );
  t.onTestFinished(() => Promise.all(pools.map((pool) => pool.end())));

  await Promise.all(
    Array.from({ length: 240 }, (_, index) =>
      mutateProviderState(pools[index % 2], path, (state) => {
        state.patchRequests = (state.patchRequests ?? 0) + 1;
        state.observations.push({ index });
        (state.capabilityEvents ??= []).push({ index });
      }),
    ),
  );

  const state = await f.pilot.provider();
  expect(state.patchRequests).toBe(240);
  expect(state.observations).toHaveLength(200);
  expect(state.capabilityEvents).toHaveLength(200);
  expect(new Set(state.observations.map((item) => item.index)).size).toBe(200);
});

test('serves persisted activity through the pilot API', async (t) => {
  const f = await setup(t, 'diagnosis-pending');
  const request = await operatorRequest(f);
  const query = new URLSearchParams({
    from: new Date(Date.now() - 86400000).toISOString(),
    to: new Date(Date.now() + 86400000).toISOString(),
  });
  const response = await request(
    `/v1/organizations/${f.manifest.organizationId}/activity?${query}`,
  );
  expect(response.statusCode).toBe(200);
  expect(response.json().items.length).toBeGreaterThan(0);
});

test('serves persisted playbooks through the pilot API', async (t) => {
  const f = await setup(t, 'diagnosis-pending');
  const request = await operatorRequest(f);
  const base = `/v1/organizations/${f.manifest.organizationId}/playbooks`;
  const list = await request(base);
  expect(list.statusCode).toBe(200);
  expect(list.json().items).toEqual([
    expect.objectContaining({
      id: 'shipping-method-correction',
      activeVersions: ['0.1.0'],
    }),
  ]);
  const detail = await request(`${base}/shipping-method-correction`);
  expect(detail.statusCode).toBe(200);
  expect(detail.json().activations).toEqual([
    expect.objectContaining({ id: f.manifest.proposalId, active: true }),
  ]);
  const runs = await request(`${base}/shipping-method-correction/runs`);
  expect(runs.statusCode).toBe(200);
  expect(runs.json().items).toEqual([]);
  const activation = detail.json().activations[0];
  const revoked = await request(
    `${base}/shipping-method-correction/activations/${activation.id}/revoke`,
    { artifactDigest: activation.artifactDigest },
  );
  expect(revoked.statusCode).toBe(200);
  expect(revoked.json().active).toBe(false);
  const restarted = await createPilot(f.env, f.directory, f.manifest, null);
  t.onTestFinished(() => restarted.close());
  const reread = await (
    await operatorRequest({ ...f, pilot: restarted })
  )(`${base}/shipping-method-correction`);
  expect(reread.statusCode).toBe(200);
  expect(reread.json().activations[0].active).toBe(false);
});

test.each([false, true])(
  'binds a replacement activation for new runs (restart: %s)',
  async (restart) => {
    const t = { onTestFinished };
    const f = await setup(t, 'approval-required');
    const actor = await f.pilot.context();
    await f.pilot.playbooks.revoke(actor, f.manifest.proposalId);
    const replacement = await f.pilot.playbooks.activate(actor, {
      id: randomUUID(),
      definitionId: 'shipping-method-correction',
      version: '0.1.0',
      policyVersion: 'v0.1',
      grants: {
        principalIds: [actor.actor.id],
        connectionIds: [f.manifest.connections.jtl],
        targetIds: [f.manifest.subjects.workflow_failure],
      },
    });
    const pilot = restart
      ? await createPilot(f.env, f.directory, f.manifest, {
          address: temporal.address,
          namespace: 'default',
          taskQueue: `luma-pilot-${f.manifest.runId}`,
          dataRegion: globalThis.process.env.LUMA_REGION ?? 'AU',
        })
      : f.pilot;
    if (restart) t.onTestFinished(() => pilot.close());
    const id = f.manifest.incidents.workflow_failure;
    const input = {
      tenantId: actor.tenantId,
      userId: actor.actor.id,
      requestId: actor.requestId,
      source: { kind: 'incident', id },
    };
    const diagnosis = await pilot.detection.diagnoses.get(actor, id);
    const proposal = await pilot.runtime.activities.propose(
      input,
      id,
      diagnosis.revision,
    );
    expect(
      (await pilot.playbooks.get(actor, proposal.id)).run.activationId,
    ).toBe(replacement.id);
    expect(
      await pilot.runtime.activities.execute(input, id, proposal),
    ).toMatchObject({ state: 'approval_required' });
    await pilot.playbooks.revoke(actor, replacement.id);
    await expect(
      pilot.runtime.activities.propose(input, id, diagnosis.revision),
    ).rejects.toThrow();
    expect(
      (await pilot.playbooks.get(actor, proposal.id)).run.activationId,
    ).toBe(replacement.id);
  },
);

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
      // Every read and receipt the correction's attempt cites is stored by the JTL app.
      const evidence = (
        await f.db.owner.query(
          'SELECT id::text,kind,document FROM jtl_shipping_method_evidence WHERE tenant_id=$1',
          [f.manifest.organizationId],
        )
      ).rows;
      const stored = new Map(evidence.map((row) => [row.id, row]));
      const attempts = (
        await f.db.owner.query(
          "SELECT document->'attempt' AS attempt FROM executed_actions WHERE tenant_id=$1",
          [f.manifest.organizationId],
        )
      ).rows.map((row) => row.attempt);
      const receipts = attempts.flatMap((a) => a.effectEvidenceRefs ?? []);
      const reads = attempts.flatMap(
        (a) => a.verification?.observationRefs ?? [],
      );
      expect(receipts.length).toBeGreaterThan(0);
      expect(reads.length).toBeGreaterThan(0);
      for (const ref of receipts)
        expect(stored.get(ref)).toMatchObject({
          kind: 'write_receipt',
          document: {
            adapterVersion: expect.any(String),
            dispatchIdentity: expect.any(String),
            records: [{ resource: 'order', externalId: '10' }],
          },
        });
      for (const ref of reads)
        expect(stored.get(ref)).toMatchObject({
          kind: 'read',
          document: {
            adapterVersion: expect.any(String),
            completeness: 'complete',
          },
        });
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

test('refreshes expired approval evidence without resetting the case and preserves the independent decision', async (t) => {
  const f = await setup(t, 'approval-required', { proposalFreshnessMs: 2000 });
  const actor = await f.pilot.context();
  const operator = await f.pilot.operator();
  const id = f.manifest.incidents.workflow_failure;
  const input = {
    tenantId: actor.tenantId,
    userId: actor.actor.id,
    requestId: actor.requestId,
    source: { kind: 'incident', id },
  };
  const diagnosis = await f.pilot.detection.diagnoses.get(actor, id);
  const original = await f.pilot.runtime.activities.propose(
    input,
    id,
    diagnosis.revision,
  );
  await f.pilot.runtime.activities.execute(input, id, original);
  await new Promise((resolve) => setTimeout(resolve, 2100));
  await f.pilot.desk.refresh(operator, id);
  const review = await f.pilot.desk.review(operator, id);
  expect(review.proposal.id).not.toBe(original.id);
  expect(review.permittedDecisions).toContain('approve');
  expect((await f.pilot.provider()).patchRequests ?? 0).toBe(0);
  expect(
    await f.pilot.runtime.activities.execute(input, id, original),
  ).toMatchObject({ state: 'proposal_changed' });
  const receipt = await f.pilot.desk.decide(operator, id, {
    commandId: randomUUID(),
    kind: 'approve',
    caseRevision: review.caseRevision,
    diagnosisRevision: review.diagnosisRevision,
    proposalId: review.proposal.id,
    proposalVersion: review.proposal.version,
    decisionId: review.proposal.policy.id,
    reason: 'Checked current order',
  });
  await f.pilot.desk.refresh(operator, id);
  expect((await f.pilot.desk.review(operator, id)).proposal.approval.id).toBe(
    receipt.approvalId,
  );
});

test('refresh refuses changed or completed orders and can recover after a failed read', async (t) => {
  const f = await setup(t, 'approval-required');
  const actor = await f.pilot.context();
  const operator = await f.pilot.operator();
  const id = f.manifest.incidents.workflow_failure;
  const input = {
    tenantId: actor.tenantId,
    userId: actor.actor.id,
    requestId: actor.requestId,
    source: { kind: 'incident', id },
  };
  const diagnosis = await f.pilot.detection.diagnoses.get(actor, id);
  const original = await f.pilot.runtime.activities.propose(
    input,
    id,
    diagnosis.revision,
  );
  await f.pilot.runtime.activities.execute(input, id, original);
  const path = join(f.directory, `provider-${f.manifest.runId}.json`);
  const state = await f.pilot.provider();
  for (const change of [
    { shippingMethodId: '9' },
    { isCancelled: true },
    { shippingDetails: { shippingDate: new Date().toISOString() } },
  ]) {
    await writeFile(
      path,
      JSON.stringify({ ...state, order: { ...state.order, ...change } }),
    );
    await expect(f.pilot.desk.refresh(operator, id)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect((await f.pilot.desk.review(operator, id)).proposal.id).toBe(
      original.id,
    );
    expect((await f.pilot.provider()).patchRequests ?? 0).toBe(0);
  }
  await writeFile(path, '{');
  await expect(f.pilot.desk.refresh(operator, id)).rejects.toMatchObject({
    statusCode: 503,
  });
  await writeFile(path, JSON.stringify(state));
  await expect(f.pilot.desk.refresh(operator, id)).resolves.toBeUndefined();
  expect(
    (await f.pilot.desk.review(operator, id)).permittedDecisions,
  ).toContain('approve');
});

test('execution waits for renewal to publish the replacement diagnosis and proposal', async (t) => {
  const f = await setup(t, 'approval-required', {
    proposalFreshnessMs: 30_000,
  });
  const actor = await f.pilot.context();
  const id = f.manifest.incidents.workflow_failure;
  const input = {
    tenantId: actor.tenantId,
    userId: actor.actor.id,
    requestId: actor.requestId,
    source: { kind: 'incident', id },
  };
  const diagnosis = await f.pilot.detection.diagnoses.get(actor, id);
  const original = await f.pilot.runtime.activities.propose(
    input,
    id,
    diagnosis.revision,
  );
  await f.pilot.runtime.activities.execute(input, id, original);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const diagnose = f.pilot.detection.diagnoses.run;
  f.pilot.detection.diagnoses.run = async (...args) => {
    const result = await diagnose.apply(f.pilot.detection.diagnoses, args);
    entered.resolve();
    await release.promise;

    return result;
  };
  const refresh = f.pilot.desk.refresh(await f.pilot.operator(), id);
  await Promise.race([
    entered.promise,
    refresh.then(() => {
      throw new Error('Renewal completed without running diagnosis');
    }),
  ]);
  let execution;
  try {
    execution = f.pilot.runtime.activities.execute(input, id, original);
    await until(
      async () =>
        (
          await f.db.owner.query(
            "SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted",
          )
        ).rowCount > 0,
      'execution waiting for renewal',
    );
  } finally {
    release.resolve();
    f.pilot.detection.diagnoses.run = diagnose;
    await refresh;
  }
  expect(await execution).toMatchObject({ state: 'proposal_changed' });
  expect((await f.pilot.provider()).patchRequests ?? 0).toBe(0);
});

test('renews an approval that expired while the worker was offline and requires a new decision', async (t) => {
  const f = await setup(t, 'approval-required', { proposalFreshnessMs: 4000 });
  const actor = await f.pilot.context();
  const operator = await f.pilot.operator();
  const id = f.manifest.incidents.workflow_failure;
  const input = {
    tenantId: actor.tenantId,
    userId: actor.actor.id,
    requestId: actor.requestId,
    source: { kind: 'incident', id },
  };
  const diagnosis = await f.pilot.detection.diagnoses.get(actor, id);
  const original = await f.pilot.runtime.activities.propose(
    input,
    id,
    diagnosis.revision,
  );
  await f.pilot.runtime.activities.execute(input, id, original);
  const approve = async (review) =>
    f.pilot.desk.decide(operator, id, {
      commandId: randomUUID(),
      kind: 'approve',
      caseRevision: review.caseRevision,
      diagnosisRevision: review.diagnosisRevision,
      proposalId: review.proposal.id,
      proposalVersion: review.proposal.version,
      decisionId: review.proposal.policy.id,
      reason: 'Checked current order',
    });
  const receipt = await approve(await f.pilot.desk.review(operator, id));
  await f.client.start(actor, input.source);
  await until(
    () => Date.now() > Date.parse(original.expiresAt),
    'approval expiry',
  );
  const worker = await f.pilot.runtime.createWorker();
  const running = worker.run();
  t.onTestFinished(async () => {
    worker.shutdown();
    await running;
    await worker.close();
  });
  await until(
    async () =>
      (await f.pilot.desk.review(operator, id)).proposal.id !== original.id,
    'fresh proposal after expired approval',
  );
  const renewed = await f.pilot.desk.review(operator, id);
  expect(renewed.proposal.approval).toBeNull();
  expect((await f.pilot.provider()).patchRequests ?? 0).toBe(0);
  expect(
    (
      await f.db.owner.query('SELECT id FROM policy_approvals WHERE id=$1', [
        receipt.approvalId,
      ])
    ).rowCount,
  ).toBe(1);
  await until(
    async () =>
      (await f.pilot.desk.review(operator, id)).permittedDecisions.includes(
        'approve',
      ),
    'new independent approval',
  );
  await until(async () => {
    try {
      await approve(await f.pilot.desk.review(operator, id));

      return true;
    } catch (error) {
      if (error.statusCode !== 409) throw error;

      return false;
    }
  }, 'approval against the current policy revision');
  await until(
    async () =>
      (await f.pilot.desk.progress(operator, id)).state === 'resolved',
    'approved renewed execution',
  );
  expect((await f.pilot.provider()).patchRequests).toBe(1);
});

test('closing a workspace after a full journey purges its commerce data and keeps what stays with it', async (t) => {
  const f = await setup(t, 'resolved');
  const worker = await f.pilot.runtime.createWorker();
  const running = worker.run();
  try {
    await startJourney(f.pilot, f.manifest, f.client);
    const actor = await f.pilot.context();
    const source = {
      kind: 'incident',
      id: f.manifest.incidents.workflow_failure,
    };
    await waitFor(
      async () =>
        (await f.client.progress(actor, source))?.phase === 'resolved',
    );
  } finally {
    // Nothing writes to the workspace while it is purged.
    worker.shutdown();
    await running;
    await worker.close();
  }
  const tenant = f.manifest.organizationId;
  const counts = async () => {
    const tables = await f.db.owner.query(
      `SELECT c.relname AS name,r.class FROM pg_class c
       JOIN pg_namespace s ON s.oid=c.relnamespace AND s.nspname='public'
       JOIN data_retention_classes r ON r.table_name=c.relname
       WHERE c.relkind='r' AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid
        AND a.attname='tenant_id' AND NOT a.attisdropped)`,
    );
    const result = {};
    for (const { name, class: kind } of tables.rows) {
      const { rows } = await f.db.owner.query(
        `SELECT count(*)::int AS n FROM "${name}" WHERE tenant_id=$1`,
        [tenant],
      );
      if (rows[0].n) result[name] = { kind, n: rows[0].n };
    }

    return result;
  };
  const before = await counts();
  const purgeable = Object.entries(before).filter(
    ([, value]) => value.kind === 'purge_on_closure',
  );
  // A full journey leaves data across many owners: cases, evidence, workflow runs, execution.
  expect(purgeable.length).toBeGreaterThan(20);
  expect(before.audit_entries?.n).toBeGreaterThan(0);

  await f.db.owner.query(
    "UPDATE organizations SET status='closed' WHERE id=$1",
    [tenant],
  );
  await f.db.owner.query(
    "UPDATE organizations SET data_deletion_at=now()-interval '1 second' WHERE id=$1",
    [tenant],
  );
  // Small batches split every reference cycle across calls, as a busy worker would.
  let done = false;
  for (let pass = 0; pass < 2000 && !done; pass++) {
    const { rows } = await f.db.owner.query(
      'SELECT * FROM purge_closed_workspace_data(50)',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenant_id: tenant, blocked: null });
    done = rows[0].done;
  }
  expect(done).toBe(true);

  const after = await counts();
  expect(
    Object.entries(after).filter(
      ([, value]) => value.kind === 'purge_on_closure',
    ),
  ).toEqual([]);
  // Organization records and audit entries stay; audit has its own retention pass.
  for (const [name, value] of Object.entries(before))
    if (value.kind !== 'purge_on_closure') expect(after[name]).toEqual(value);
  const organization = await f.db.owner.query(
    'SELECT data_purged_at FROM organizations WHERE id=$1',
    [tenant],
  );
  expect(organization.rows[0].data_purged_at).not.toBeNull();
  await expect(
    f.db.owner.query("UPDATE organizations SET status='active' WHERE id=$1", [
      tenant,
    ]),
  ).rejects.toThrow(/removed/);
}, 180_000);

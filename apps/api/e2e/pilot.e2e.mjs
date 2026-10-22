import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { Pool } from 'pg';
import { expect, onTestFinished, test } from 'vitest';

import { startJourney, waitFor } from '../../../tooling/pilot/journey.mjs';
import { mutateProviderState } from '../../../tooling/pilot/provider-state.mjs';
import { createPilot } from '../../../tooling/pilot/runtime.mjs';
import { seedPilot } from '../../../tooling/pilot/seed.mjs';
import { operatorRequest, pilotFixture } from './pilot-fixture.mjs';

const { setup, temporalAddress } = pilotFixture();

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
          address: temporalAddress(),
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

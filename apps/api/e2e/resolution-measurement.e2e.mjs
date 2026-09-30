import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { expect, it } from 'vitest';

import { metricStream } from './metric-stream-fixture.mjs';
import {
  resolutionMeasurementRequest as request,
  seedResolutionMeasurement,
} from './resolution-measurement-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

it('reconciles authorized incident cohorts, excludes synthetic data and retains unknown and zero-denominator states', async (t) => {
  const f = await settingsFixture(t);
  const endpoint = `/v2/organizations/${f.org.id}/metrics/query`;
  const query = (body = {}) =>
    f.request(f.member, endpoint, 'POST', { ...request, ...body });
  expect((await query()).metrics[0]).toMatchObject({
    population: 0,
    coverage: 'unavailable',
    value: 0,
    dataThrough: null,
  });
  const a = await seedResolutionMeasurement(f);
  const pending = await seedResolutionMeasurement(f, { verified: false });
  await seedResolutionMeasurement(f, { synthetic: true });
  await seedResolutionMeasurement(f, { simulationConnection: true });
  await seedResolutionMeasurement(f, { environment: null });
  const recurrence = await seedResolutionMeasurement(f, {
    previousIncidentId: a.id,
  });
  let result = await query({ limit: 1 });
  const m = (id) =>
    result.metrics.find((m) => m.definition.id === `resolution.${id}`);
  expect(m('eligible')).toMatchObject({ value: 3, population: 3, total: null });
  expect(m('verified')).toMatchObject({ value: 2 });
  expect(m('autonomous')).toMatchObject({
    value: 2,
    total: null,
    unknownCount: 1,
    coverage: 'partial',
  });
  expect(m('unknown').value).toBe(1);
  expect(m('pending').items.map((i) => i.id)).toEqual([pending.id]);
  expect(m('recurrent').items[0].previousIncidentId).toBe(a.id);
  const second = await query({
    limit: 1,
    offset: 1,
    asOf: result.asOf,
    snapshot: result.snapshot,
  });
  expect(
    new Set([m('verified').items[0].id, second.metrics[1].items[0].id]).size,
  ).toBe(2);
  await f.request(f.outsider, endpoint, 'POST', request, 404);
  await f.request(null, endpoint, 'POST', request, 401);
  await f.request(
    f.owner,
    endpoint,
    'POST',
    { ...request, scope: { connectionId: randomUUID() } },
    400,
  );
  await f.request(
    f.owner,
    endpoint,
    'POST',
    { ...request, scope: { environment: 'live', window: '30d' } },
    400,
  );
  const overview = await f.request(
    f.owner,
    `${f.base}/operations/overview?window=7d`,
  );
  expect(overview).toMatchObject({
    automaticallyResolved: null,
    automation: null,
    measurement: {
      eligible: 3,
      verified: 2,
      autonomous: 2,
      unknownAttribution: 1,
      unknownEnvironment: 1,
    },
  });
  const synthetic = await query({
    scope: { environment: 'synthetic', window: '7d' },
  });
  expect(synthetic.metrics[1]).toMatchObject({ value: 2, population: 2 });
  // A newer eligibility assessment invalidates pagination and keeps the original record.
  await recurrence.record({
    kind: 'eligibility',
    status: 'ineligible',
    ruleVersion: 'partner-rule/2',
    reasonCode: 'outside_scope',
  });
  await f.request(
    f.member,
    endpoint,
    'POST',
    { ...request, asOf: result.asOf, snapshot: result.snapshot, offset: 1 },
    409,
  );
  expect((await f.request(f.member, recurrence.path)).items).toHaveLength(4);
  result = await query();
  expect(m('eligible').value).toBe(2);
});

it('serializes concurrent assessments, preserves retries and rejects foreign evidence, actors and roles', async (t) => {
  const f = await settingsFixture(t);
  const a = await seedResolutionMeasurement(f);
  const other = await seedResolutionMeasurement(f);
  const command = {
    id: randomUUID(),
    expectedRevision: a.revision,
    fact: {
      kind: 'attribution',
      involvement: 'manual_repair',
      complete: false,
      from: a.detectedAt,
      through: a.verifiedAt,
      evidenceRefs: [a.evidence],
    },
  };
  const responses = await Promise.all(
    Array.from({ length: 4 }, () =>
      f.request(f.owner, a.path, 'POST', command),
    ),
  );
  expect(new Set(responses.map((r) => r.revision)).size).toBe(1);
  expect(await f.request(f.owner, a.path, 'POST', command)).toEqual(
    responses[0],
  );
  await f.request(
    f.member,
    a.path,
    'POST',
    { ...command, id: randomUUID() },
    403,
  );
  await f.request(f.outsider, a.path, 'GET', undefined, 404);
  await f.request(f.owner, other.path, 'POST', command, 409);
  await f.request(
    f.owner,
    a.path,
    'POST',
    { ...command, fact: { ...command.fact, involvement: 'unknown' } },
    409,
  );
  await f.request(
    f.owner,
    a.path,
    'POST',
    {
      ...command,
      id: randomUUID(),
      expectedRevision: a.revision + 1,
      fact: { ...command.fact, evidenceRefs: [other.evidence] },
    },
    404,
  );
  const attempts = await Promise.all(
    [0, 1].map(() =>
      f.app.inject({
        method: 'POST',
        url: a.path,
        headers: { cookie: f.owner.cookie, origin: 'http://localhost:3000' },
        payload: {
          ...command,
          id: randomUUID(),
          expectedRevision: a.revision + 1,
        },
      }),
    ),
  );
  expect(attempts.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  await f.request(
    f.owner,
    a.path,
    'POST',
    {
      id: randomUUID(),
      expectedRevision: a.revision + 2,
      fact: {
        kind: 'environment',
        environment: 'shadow',
        evidenceRefs: [a.evidence],
      },
    },
    409,
  );
  const history = await f.request(f.member, a.path);
  expect(history.items).toHaveLength(5);
  expect(history.revision).toBe(5);
  const endpoint = `/v2/organizations/${f.org.id}/metrics/query`;
  const result = await f.request(f.member, endpoint, 'POST', request);
  expect(result.metrics[2]).toMatchObject({ value: 1, total: 1 });
  const baseline = await f.request(f.owner, a.path, 'POST', {
    id: randomUUID(),
    expectedRevision: history.revision,
    fact: {
      kind: 'baseline',
      partnerReference: 'partner-process-study',
      processVersion: 'repair/1',
      sampleSize: 2,
      measuredSeconds: 60,
      from: a.detectedAt,
      through: a.verifiedAt,
      evidenceRefs: [a.evidence],
    },
  });
  expect((await f.request(f.member, a.path)).items.at(-1)).toEqual(baseline);
  expect(
    (await f.request(f.member, endpoint, 'POST', request)).metrics[2],
  ).toMatchObject({ value: 1, total: 1 });
  // Access loss is checked on each ledger and metric read.
  await f.request(
    f.owner,
    `${f.base}/members/${f.membership.id}`,
    'DELETE',
    undefined,
    204,
  );
  await f.request(f.member, a.path, 'GET', undefined, 404);
  await f.request(f.member, endpoint, 'POST', request, 404);
  const runtime = new Pool({ connectionString: f.db.runtimeUrl });
  const client = await runtime.connect();
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [
      randomUUID(),
    ]);
    expect(
      (await client.query('SELECT * FROM resolution_measurement_facts')).rows,
    ).toEqual([]);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await runtime.end();
  }
});

it('keeps approvals across attempts, reopening, late verification and incorrect action assessments authoritative', async (t) => {
  const f = await settingsFixture(t);
  const a = await seedResolutionMeasurement(f);
  const proposalId = randomUUID();
  await f.db.owner.query(
    'INSERT INTO case_proposals(tenant_id,id,exception_id,diagnosis_revision,action_hash,document) VALUES($1,$2,$3,1,$4,$5)',
    [
      f.org.id,
      proposalId,
      a.id,
      'a'.repeat(64),
      { id: proposalId, tenantId: f.org.id },
    ],
  );
  const endpoint = `/v2/organizations/${f.org.id}/metrics/query`;
  const query = () => f.request(f.owner, endpoint, 'POST', request);
  for (let i = 0; i < 2; i++) {
    const id = randomUUID();
    await f.db.owner.query(
      'INSERT INTO policy_approvals(id,tenant_id,proposal_id,action_hash,policy_version,document) VALUES($1,$2,$3,$4,$5,$6)',
      [
        id,
        f.org.id,
        proposalId,
        'a'.repeat(64),
        `policy/${i}`,
        {
          id,
          tenantId: f.org.id,
          outcome: 'approved',
          approverId: f.member.id,
          requesterId: f.owner.id,
        },
      ],
    );
  }
  let result = await query();
  expect(result.metrics[2]).toMatchObject({ value: 0, total: 0 });
  expect(result.metrics[3]).toMatchObject({ value: 1 });
  expect(
    result.metrics[3].items[0].evidenceRefs.filter((r) =>
      r.startsWith('approval:'),
    ),
  ).toHaveLength(2);
  await a.record({
    kind: 'incorrect_action',
    proposalId,
    reasonCode: 'wrong_quantity',
  });
  await f.request(
    f.owner,
    a.path,
    'POST',
    {
      id: randomUUID(),
      expectedRevision: a.revision,
      fact: {
        kind: 'incorrect_action',
        proposalId: randomUUID(),
        reasonCode: 'unlinked',
        evidenceRefs: [a.evidence],
      },
    },
    404,
  );
  result = await query();
  expect(result.metrics[8].items[0].incorrectActionIds).toEqual([proposalId]);
  const reopened = await seedResolutionMeasurement(f, {
    verified: false,
    previousIncidentId: a.id,
  });
  result = await query();
  expect(result.metrics[1].value).toBe(1);
  expect(result.metrics[6].value).toBe(1);
  expect(result.metrics[7].items[0].previousIncidentId).toBe(a.id);
  expect(result.metrics[3].value).toBe(1);
  const newer = new Date(Date.now() - 1000).toISOString();
  const resolution = { ...a.document.resolution, at: newer };
  await f.db.owner.query(
    "UPDATE exceptions SET state='resolved',document=jsonb_set(jsonb_set(document,'{state}','\"resolved\"'),'{resolution}',$2::jsonb) WHERE id=$1",
    [reopened.id, resolution],
  );
  result = await query();
  expect(result.metrics[1].value).toBe(2);
  expect(result.metrics[2].value).toBe(0);
  expect(result.metrics[4].items[0].id).toBe(reopened.id);
});

it('publishes committed measurement invalidation and suppresses rolled-back facts', async (t) => {
  const f = await settingsFixture(t);
  const a = await seedResolutionMeasurement(f);
  const origin = await f.app.listen({ host: '127.0.0.1', port: 0 });
  const endpoint = `/v2/organizations/${f.org.id}/metrics/query`;
  const stream = await metricStream(t, origin, f, f.owner, true, {
    path: endpoint,
    body: request,
  });
  const before = stream.events.length;
  await a.record({
    kind: 'eligibility',
    status: 'ineligible',
    ruleVersion: 'rule/2',
    reasonCode: 'excluded',
  });
  await expect
    .poll(() => stream.events.length, { timeout: 5000 })
    .toBeGreaterThan(before);
  expect(
    (await f.request(f.owner, endpoint, 'POST', request)).metrics[0].value,
  ).toBe(0);
  const id = randomUUID();
  const client = await f.db.owner.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "INSERT INTO resolution_measurement_facts(tenant_id,id,incident_id,revision,kind,actor_id,document,request) SELECT tenant_id,$2::uuid,incident_id,revision+1,kind,actor_id,jsonb_set(jsonb_set(document,'{id}',to_jsonb(($2::uuid)::text)),'{revision}',to_jsonb(revision+1)),request FROM resolution_measurement_facts WHERE tenant_id=$1 AND incident_id=$3 ORDER BY revision DESC LIMIT 1",
      [f.org.id, id, a.id],
    );
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  expect(
    (await f.request(f.owner, a.path)).items.some((e) => e.id === id),
  ).toBe(false);
});

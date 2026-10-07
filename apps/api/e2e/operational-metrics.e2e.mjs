import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import {
  operationalEndpoint,
  operationalRequest,
  seedOperationalMetrics,
} from './operational-metrics-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

it('reconciles all domain cohorts, stock expiry, lifecycle transitions, scopes and snapshot conflicts', async (t) => {
  const f = await settingsFixture(t);
  const endpoint = operationalEndpoint(f);
  const query = (body = {}) =>
    f.request(f.owner, endpoint, 'POST', { ...operationalRequest, ...body });
  const empty = await query();
  expect(empty.metrics.map((m) => m.value)).toEqual([
    0,
    0,
    null,
    0,
    0,
    0,
    0,
    0,
  ]);
  expect(empty.metrics[3].coverage).toBe('unavailable');
  await f.request(f.outsider, endpoint, 'POST', operationalRequest, 404);
  await f.request(null, endpoint, 'POST', operationalRequest, 401);
  await f.request(
    f.owner,
    endpoint,
    'POST',
    { ...operationalRequest, scope: { supplierId: randomUUID() } },
    400,
  );
  await f.request(
    f.owner,
    endpoint,
    'POST',
    { ...operationalRequest, scope: { updatedFrom: new Date().toISOString() } },
    400,
  );
  const seed = await seedOperationalMetrics(f, 2);
  const first = await query({ limit: 1 });
  expect(first.metrics.map((m) => m.observedCount)).toEqual([
    2, 2, 1, 2, 0, 0, 0, 1,
  ]);
  expect(first.metrics[1].breakdown).toContainEqual({
    reason: 'uncertainty',
    count: 2,
  });
  const second = await query({
    limit: 1,
    offset: 1,
    asOf: first.asOf,
    snapshot: first.snapshot,
  });
  expect(
    new Set([first.metrics[0].items[0].id, second.metrics[0].items[0].id]).size,
  ).toBe(2);
  const inbox = await f.request(f.owner, `${f.base}/exceptions?view=needs_you`);
  expect(inbox.totalCount).toBe(first.metrics[1].value);
  const created = await seed.createOrder();
  await f.request(
    f.owner,
    `${f.base}/procurement/purchase-orders`,
    'POST',
    created.input,
  );
  await f.request(
    f.owner,
    endpoint,
    'POST',
    {
      ...operationalRequest,
      asOf: first.asOf,
      snapshot: first.snapshot,
      offset: 1,
    },
    409,
  );
  let current = await query();
  expect(current.metrics[5].value).toBe(1);
  expect(current.metrics[3].breakdown).toEqual([
    { reason: 'existing_commitment', count: 1 },
    { reason: 'no_commitment', count: 1 },
  ]);
  expect(
    current.metrics[3].items.find((i) => i.sku === seed.rows[0].sku)
      .commitmentIds,
  ).toEqual([created.order.id]);
  const procurement = {
    definitionVersion: 2,
    metrics: ['procurement.purchase_orders.draft'],
    scope: { supplierId: seed.supplierId, authority: 'external' },
  };
  expect(
    (await f.request(f.member, endpoint, 'POST', procurement)).metrics[0].value,
  ).toBe(0);
  for (const [status, revision, values] of [
    ['open', 1, [0, 1]],
    ['closed', 2, [0, 0]],
  ]) {
    await f.request(
      f.owner,
      `${f.base}/procurement/purchase-orders/${created.order.id}/transitions`,
      'POST',
      {
        id: randomUUID(),
        expectedRevision: revision,
        status,
        reason: 'Reviewed',
      },
    );
    current = await query();
    expect(current.metrics.slice(5, 7).map((m) => m.value)).toEqual(values);
  }
  expect(current.metrics[3].breakdown[0].count).toBe(0);
  const cancelled = await seed.createOrder();
  await f.request(
    f.owner,
    `${f.base}/procurement/purchase-orders/${cancelled.order.id}/transitions`,
    'POST',
    {
      id: randomUUID(),
      expectedRevision: 1,
      status: 'cancelled',
      reason: 'No longer needed',
    },
  );
  expect((await query()).metrics[5].value).toBe(0);
  // The exact configured source disappears; the active rule must remain an unknown position.
  await f.db.owner.query(
    'DELETE FROM inventory_projections WHERE tenant_id=$1 AND entity_id=$2',
    [f.org.id, seed.rows[0].positionId],
  );
  current = await query();
  expect(current.metrics[4].items[0].reason).toBe('missing');
  expect(current.metrics[3]).toMatchObject({
    value: 1,
    total: null,
    unknownCount: 1,
  });
  await f.db.owner.query(
    'UPDATE replenishment_activations SET active=false WHERE tenant_id=$1 AND id=$2',
    [f.org.id, seed.rows[0].ruleId],
  );
  expect((await query()).metrics[4].value).toBe(0);
  // A five-minute boundary is returned before an observation expires without a write.
  const nearExpiry = new Date(Date.now() - 299500).toISOString();
  await f.db.owner.query(
    "UPDATE inventory_snapshots SET document=jsonb_set(document,'{observedAt}',to_jsonb($2::text)) WHERE id=$1",
    [seed.rows[1].snapshotId, nearExpiry],
  );
  current = await query();
  expect(current.metrics[3].nextRefreshAt).toBe(
    new Date(Date.parse(nearExpiry) + 300000).toISOString(),
  );
  await expect.poll(async () => (await query()).metrics[4].value).toBe(1);
  const registry = await f.request(
    f.member,
    `/v2/organizations/${f.org.id}/metrics`,
  );
  expect(registry).toHaveLength(22);
  expect(
    registry.filter((definition) => definition.family === 'resolution'),
  ).toHaveLength(11);
  expect(await f.request(f.member, `${f.base}/metrics`)).toHaveLength(3);
});

it('reuses permitted-read health through failure, recovery, revocation and disconnection', async (t) => {
  const f = await settingsFixture(t);
  const seed = await seedOperationalMetrics(f);
  const request = {
    definitionVersion: 2,
    metrics: ['connections.needing_attention'],
    scope: { connectionId: seed.connectionId },
  };
  const read = async () =>
    (await f.request(f.member, operationalEndpoint(f), 'POST', request))
      .metrics[0];
  expect((await read()).items[0].reasons).toEqual(['unobserved']);
  const record = async (succeeded) =>
    f.db.owner.query(
      'INSERT INTO connector_read_checks(tenant_id,connection_id,capability,observed_at,succeeded,document) VALUES($1,$2,$3,clock_timestamp(),$4,$5)',
      [f.org.id, seed.connectionId, 'orders.read', succeeded, {}],
    );
  await record(true);
  expect((await read()).value).toBe(0);
  await record(false);
  expect((await read()).items[0].reasons).toEqual(['degraded']);
  await record(true);
  expect((await read()).value).toBe(0);
  for (const status of ['pending', 'revoked', 'disconnected', 'active']) {
    await f.db.owner.query(
      "UPDATE connector_installations SET document=jsonb_set(document,'{status}',to_jsonb($2::text)),secret=CASE WHEN $2 IN ('revoked','disconnected') THEN NULL ELSE 'fixture' END WHERE id=$1",
      [seed.connectionId, status],
    );
    expect((await read()).value).toBe(
      ['pending', 'revoked'].includes(status) ? 1 : 0,
    );
  }
  await f.db.owner.query(
    "UPDATE connector_installations SET document=jsonb_set(document,'{granted}','[]') WHERE id=$1",
    [seed.connectionId],
  );
  expect((await read()).items[0].reasons).toEqual(['unobserved']);
});

it('reads several metric views in one summary and keeps a failed part to itself', async (t) => {
  const f = await settingsFixture(t);
  await seedOperationalMetrics(f);
  const summary = `/v2/organizations/${f.org.id}/metrics/summary`;
  const parts = [
    { kind: 'operational', request: operationalRequest },
    { kind: 'orders', request: {} },
  ];
  const read = await f.request(f.owner, summary, 'POST', { parts });
  expect(read.parts.map((part) => [part.kind, part.status])).toEqual([
    ['operational', 200],
    ['orders', 200],
  ]);
  const direct = await f.request(
    f.owner,
    operationalEndpoint(f),
    'POST',
    operationalRequest,
  );
  // Ages grow between the two reads; counts must match.
  const counts = (metrics) =>
    metrics
      .filter((m) => m.definition.unit !== 'second')
      .map((m) => [m.definition.id, m.value]);
  expect(counts(read.parts[0].body.metrics)).toEqual(counts(direct.metrics));
  expect(read.parts[1].body.metrics.map((m) => m.definition.id)).toEqual([
    'orders.open',
    'orders.overdue',
    'orders.attention',
  ]);
  const boundaries = read.parts
    .map((part) => part.body.nextRefreshAt)
    .filter(Boolean)
    .map(Date.parse);
  expect(read.nextRefreshAt && Date.parse(read.nextRefreshAt)).toBe(
    boundaries.length ? Math.min(...boundaries) : null,
  );

  // A changed order snapshot fails only its part.
  const stale = await f.request(f.owner, summary, 'POST', {
    parts: [
      parts[0],
      {
        kind: 'orders',
        request: {
          asOf: new Date().toISOString(),
          snapshot: '0'.repeat(64),
          offset: 20,
        },
      },
    ],
  });
  expect(stale.parts[0].status).toBe(200);
  expect(stale.parts[1]).toMatchObject({
    kind: 'orders',
    status: 409,
    error: { code: 'CONFLICT' },
  });

  await f.request(f.owner, summary, 'POST', { parts: [] }, 400);
  await f.request(f.outsider, summary, 'POST', { parts }, 404);
  await f.request(null, summary, 'POST', { parts }, 401);
});

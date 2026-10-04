import { randomUUID } from 'node:crypto';

import { expect, test } from 'vitest';

import { until } from './helpers.mjs';
import { metricStream } from './metric-stream-fixture.mjs';
import { setupSimulator } from './simulator-fixture.mjs';

test('pilot projects observed orders, serves live metrics and releases its listener on shutdown', async (t) => {
  const f = await setupSimulator(t);
  const base = `/v1/organizations/${f.manifest.organizationId}`;
  const signIn = await f.pilot.app.inject({
    method: 'POST',
    url: '/auth/sign-in/email',
    headers: { origin: 'http://127.0.0.1:3000' },
    payload: {
      email: 'pilot-operator@example.test',
      password: f.password,
    },
  });
  expect(signIn.statusCode).toBe(200);
  const cookie = signIn.cookies
    .map(({ name, value }) => `${name}=${value}`)
    .join('; ');
  const sync = await f.pilot.app.inject({
    method: 'GET',
    url: `${base}/sync`,
    headers: { cookie },
  });
  expect(sync.statusCode).toBe(200);
  expect(sync.json().connections).toHaveLength(2);
  const streams = await Promise.all(
    Array.from({ length: 2 }, () =>
      metricStream(t, f.apiOrigin, {
        base,
        org: { id: f.manifest.organizationId },
        owner: { cookie },
      }),
    ),
  );
  await until(
    () => streams.every((stream) => stream.events.at(-1)?.connected),
    'pilot metric listener connected',
  );
  const before = streams.map((stream) => stream.events.length);
  await f.pilot.observe();
  const metrics = async () => {
    const response = await f.pilot.app.inject({
      method: 'POST',
      url: `${base}/metrics/query`,
      headers: { cookie, origin: 'http://127.0.0.1:3000' },
      payload: {},
    });
    expect(response.statusCode).toBe(200);

    return response.json();
  };
  const initial = await metrics();
  expect(initial.coverage).toBe('partial');
  expect(initial.observedAt).not.toBeNull();
  // The two explicitly mirrored provider orders share canonical identities.
  // Adapter cancellation quantities remain unknown, so open classification stays unknown.
  expect(initial.metrics[0].unknownCount).toBe(2);
  const canonicalOrders = async () =>
    (
      await f.db.owner.query(
        "SELECT p.entity_id,count(DISTINCT p.connection_id)::int AS sources FROM orders_projections p JOIN orders_snapshots s ON s.id=p.snapshot_id WHERE s.kind='order' GROUP BY p.entity_id",
      )
    ).rows;
  expect(await canonicalOrders()).toEqual([
    { entity_id: expect.any(String), sources: 2 },
    { entity_id: expect.any(String), sources: 2 },
  ]);
  await f.pilot.observe();
  expect((await metrics()).metrics[0].unknownCount).toBe(2);
  // Matching display numbers on manual orders do not establish a cross-provider mapping.
  for (const instance of ['jtl', 'shopify'])
    await f.call('runs/operations/control', {
      action: 'command',
      instance,
      command: { kind: 'order', id: '100', quantity: 5 },
    });
  await f.pilot.observe();
  expect(await canonicalOrders()).toHaveLength(4);
  expect((await metrics()).metrics[0].unknownCount).toBe(4);
  for (const instance of ['jtl', 'shopify'])
    await f.call('runs/operations/control', {
      action: 'command',
      instance,
      command: { kind: 'ship', id: '100' },
    });
  await f.pilot.observe();
  expect((await metrics()).metrics[0].unknownCount).toBe(2);
  await until(
    () =>
      streams.every((stream, index) =>
        stream.events.slice(before[index]).some((event) => event.refetch),
      ),
    'provider observations invalidate both Insights subscriptions',
  );
  const listeners = async () =>
    (
      await f.db.owner.query(
        "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name='luma-metric-listener'",
      )
    ).rows.length;
  expect(await listeners()).toBe(1);
  await f.pilot.close();
  await until(() => streams.every((stream) => stream.ended), 'streams closed');
  await expect.poll(listeners).toBe(0);
});

test('projects orders and fulfillments beyond the first provider page', async (t) => {
  const f = await setupSimulator(t);
  for (let index = 0; index < 101; index++) {
    const id = String(100 + index);
    for (const kind of ['order', 'ship'])
      await f.call('runs/operations/control', {
        action: 'command',
        instance: 'jtl',
        command: { kind, id, ...(kind === 'order' ? { quantity: 1 } : {}) },
      });
  }
  // Each pass advances one page; another pass retries fulfillments whose parents arrived later.
  await f.pilot.observe();
  await f.pilot.observe();
  await f.pilot.observe();
  const projected = await f.db.owner.query(
    'SELECT s.kind,count(*)::int AS count FROM orders_projections p JOIN orders_snapshots s ON s.id=p.snapshot_id WHERE p.connection_id=$1 GROUP BY s.kind ORDER BY s.kind',
    [f.manifest.connections.jtl],
  );
  expect(projected.rows).toEqual([
    { kind: 'fulfillment', count: 101 },
    { kind: 'order', count: 103 },
  ]);
});

test('inventory scenario detects, verifies and recurs through the same HTTP APIs used by the panel', async (t) => {
  const f = await setupSimulator(t);
  const check = () => f.call('runs/operations/operations/check', {});
  const status = () => f.call('runs/operations/operations');
  const id = randomUUID();
  expect(await check()).toMatchObject({
    connected: true,
    incident: null,
    lastCheck: { outcome: 'clear' },
  });
  const injected = await f.call('runs/operations/scenarios', {
    id,
    kind: 'inventory-mismatch',
  });
  expect(
    await f.call('runs/operations/scenarios', {
      id,
      kind: 'inventory-mismatch',
    }),
  ).toEqual(injected);
  await f.call('runs/operations/control', {
    action: 'command',
    instance: 'jtl',
    command: { kind: 'order', id: '100', quantity: 5 },
  });
  const detected = await check();
  expect(detected.lastCheck, JSON.stringify(detected)).toMatchObject({
    outcome: 'detect',
  });
  expect(detected.incident).toMatchObject({
    occurrenceCount: 1,
    previousExceptionId: null,
  });
  const firstId = detected.incident.id;
  const actor = await f.pilot.operator();
  const sources = await f.pilot.detection.exceptions.evidence(actor, firstId);
  expect(sources).toHaveLength(3);
  expect(sources.map((item) => item.adapterVersion).sort()).toEqual([
    'canonical-mapping-v1',
    'jtl/4',
    'shopify/3',
  ]);
  expect((await check()).incident).toMatchObject({
    id: firstId,
    occurrenceCount: 2,
  });
  await f.call('runs/operations/scenarios/' + id + '/recover', {});
  expect((await status()).incident.state).not.toBe('resolved');
  await f.call('runs/operations/control', {
    action: 'service-health',
    instance: 'shopify',
    status: 'unavailable',
  });
  expect((await check()).lastCheck.outcome).toBe('unavailable');
  expect((await status()).incident.state).not.toBe('resolved');
  await f.call('runs/operations/control', {
    action: 'service-health',
    instance: 'shopify',
    status: 'healthy',
  });
  const recovered = await check();
  expect(recovered.lastCheck, JSON.stringify(recovered)).toMatchObject({
    outcome: 'clear',
  });
  expect(recovered.incident).toMatchObject({ id: firstId, state: 'resolved' });
  const resolved = await f.pilot.detection.exceptions.get(actor, firstId);
  expect(resolved.resolution).toMatchObject({
    kind: 'verification',
    outcome: 'passed',
    authoritative: true,
    complete: true,
  });
  expect(resolved.resolution.evidence).toHaveLength(2);
  expect(
    resolved.resolution.evidence.every(
      (item) => !sources.some((source) => source.key === item.key),
    ),
  ).toBe(true);
  expect(
    resolved.resolution.bindings.every(
      (item) => item.postcondition === 'equivalent_inventory_agrees',
    ),
  ).toBe(true);
  const next = randomUUID();
  await f.call('runs/operations/scenarios', {
    id: next,
    kind: 'inventory-mismatch',
  });
  const recurrence = await check();
  expect(recurrence.incident).toMatchObject({
    previousExceptionId: firstId,
    occurrenceCount: 1,
  });
  expect(recurrence.incident.id).not.toBe(firstId);
  await f.call('runs/operations/scenarios/' + id + '/recover', {});
  expect((await check()).lastCheck.outcome).toBe('detect');
  await f.call('runs', { id: 'unbound', scenario: 'manual' });
  expect(await f.call('runs/unbound/operations/check', {})).toEqual({
    connected: false,
  });
  expect(
    (await f.call('runs')).find((run) => run.id === 'unbound')
      .operationalScenarios,
  ).toEqual([]);
  await f.call('runs/operations/control', { action: 'reset' });
  expect((await check()).incident).toMatchObject({
    id: recurrence.incident.id,
    state: 'resolved',
  });
  const finalScenarioId = randomUUID();
  await f.call('runs/operations/scenarios', {
    id: finalScenarioId,
    kind: 'inventory-mismatch',
  });
  expect((await check()).lastCheck.outcome).toBe('detect');
  for (const quantity of [90, 95])
    await f.call('runs/operations/control', {
      action: 'command',
      instance: 'jtl',
      command: { kind: 'stock', id: '2', quantity },
    });
  expect((await check()).lastCheck.outcome).toBe('detect');
  await f.call(`runs/operations/scenarios/${finalScenarioId}/recover`, {});
  const matched = await check();
  expect(matched.lastCheck, JSON.stringify(matched)).toMatchObject({
    outcome: 'clear',
  });
  expect(matched.incident.state).toBe('resolved');
  await f.call('runs/operations/control', { action: 'reset' });
  expect((await check()).lastCheck.outcome).toBe('clear');
  const unauthenticated = await fetch(
    `${f.apiOrigin}/v1/organizations/${f.manifest.organizationId}/simulator/inventory`,
  );
  expect(unauthenticated.status).toBe(401);
});

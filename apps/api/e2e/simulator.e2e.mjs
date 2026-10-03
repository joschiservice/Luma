import { randomUUID } from 'node:crypto';

import { expect, test } from 'vitest';

import { until } from './helpers.mjs';
import { metricStream } from './metric-stream-fixture.mjs';
import { setupSimulator } from './simulator-fixture.mjs';

/** Signs in as the pilot operator on the in-process pilot API. */
async function operatorCookie(f) {
  const response = await f.pilot.app.inject({
    method: 'POST',
    url: '/auth/sign-in/email',
    headers: { origin: 'http://127.0.0.1:3000' },
    payload: { email: 'pilot-operator@example.test', password: f.password },
  });
  expect(response.statusCode).toBe(200);

  return response.cookies
    .map(({ name, value }) => `${name}=${value}`)
    .join('; ');
}

test('pilot imports simulated history through commerce sync, serves live metrics and releases its listener on shutdown', async (t) => {
  const f = await setupSimulator(t);
  const base = `/v1/organizations/${f.manifest.organizationId}`;
  const cookie = await operatorCookie(f);
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
  const sync = await f.pilot.app.inject({
    method: 'GET',
    url: `${base}/sync`,
    headers: { cookie },
  });
  expect(sync.statusCode).toBe(200);
  expect(sync.json().connections).toHaveLength(2);
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
  expect(initial.observedAt).not.toBeNull();
  const canonicalOrders = async () =>
    (
      await f.db.owner.query(
        "SELECT p.entity_id,count(DISTINCT p.connection_id)::int AS sources FROM orders_projections p JOIN orders_snapshots s ON s.id=p.snapshot_id WHERE s.kind='order' GROUP BY p.entity_id",
      )
    ).rows;
  // Imports bind each source order only to itself; people link orders across sources.
  expect(await canonicalOrders()).toHaveLength(4);
  expect((await canonicalOrders()).every((row) => row.sources === 1)).toBe(
    true,
  );
  await f.call('runs/operations/control', {
    action: 'order',
    lines: [{ sku: 'LUMA-001', quantity: 5 }],
  });
  await f.call('runs/operations/control', {
    action: 'advance',
    milliseconds: 60_000,
  });
  await f.pilot.observe();
  expect(await canonicalOrders()).toHaveLength(6);
  await until(
    () =>
      streams.every((stream, index) =>
        stream.events.slice(before[index]).some((event) => event.refetch),
      ),
    'provider imports invalidate both Insights subscriptions',
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

test('signed Shopify webhooks reach the real change route and schedule early reads', async (t) => {
  const f = await setupSimulator(t);
  await f.pilot.observe();
  const hints = async () =>
    (
      await f.db.owner.query(
        'SELECT capabilities FROM connector_refresh_hints WHERE connection_id=$1',
        [f.manifest.connections.shopify],
      )
    ).rows;
  const already = (await hints()).length;
  await f.call('runs/operations/control', {
    action: 'order',
    lines: [{ sku: 'LUMA-001', quantity: 1 }],
  });
  await until(
    async () => (await hints()).length > already,
    'webhook stored a refresh hint',
    20_000,
  );
  expect((await hints()).flatMap((row) => row.capabilities)).toContain(
    'orders.read',
  );
});

test('projects orders and fulfillments beyond the first provider page', async (t) => {
  const f = await setupSimulator(t);
  await f.call('runs/operations/control', {
    action: 'command',
    instance: 'jtl',
    command: { kind: 'stock', itemId: '1', warehouse: '1', quantity: 500 },
  });
  for (let index = 0; index < 101; index++)
    await f.call('runs/operations/control', {
      action: 'order',
      lines: [{ sku: 'LUMA-001', quantity: 1 }],
    });
  await f.call('runs/operations/control', {
    action: 'advance',
    milliseconds: 60_000,
  });
  const open = [];
  let after;
  do {
    const page = await f.call(
      `runs/operations/records/jtl?kind=sales-order&limit=100${after ? `&after=${after}` : ''}`,
    );
    open.push(...page.items.filter((item) => !['1', '10'].includes(item.id)));
    after = page.next;
  } while (after);
  expect(open).toHaveLength(101);
  for (const order of open)
    await f.call('runs/operations/control', {
      action: 'command',
      instance: 'jtl',
      command: { kind: 'ship', id: order.id, warehouse: '1' },
    });
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

test('inventory drift is detected, verified, scored and recurs through the same HTTP APIs as the panel', async (t) => {
  const f = await setupSimulator(t);
  const check = () => f.call('runs/operations/operations/check', {});
  const status = () => f.call('runs/operations/operations');
  const inject = (id) =>
    f.call('runs/operations/incidents', {
      id,
      kind: 'inventory-drift',
      target: 'LUMA-SCENARIO-001',
    });
  const recover = (id) => f.call(`runs/operations/incidents/${id}/recover`, {});
  expect(await check()).toMatchObject({
    connected: true,
    incident: null,
    lastCheck: { outcome: 'clear' },
  });
  const id = randomUUID();
  const injected = await inject(id);
  expect(injected).toMatchObject({ id, status: 'active', origin: 'injected' });
  expect((await inject(id)).id).toBe(id);
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
  expect((await check()).incident).toMatchObject({
    id: firstId,
    occurrenceCount: 2,
  });
  const scored = await f.call('runs/operations/scorecard');
  expect(scored.luma).toEqual({ connected: true, error: null });
  expect(
    scored.byKind.find((row) => row.kind === 'inventory-drift'),
  ).toMatchObject({
    total: 1,
    detected: 1,
  });
  const view = (await f.call('runs/operations/incidents')).find(
    (incident) => incident.id === id,
  );
  expect(view.detection).toMatchObject({ state: 'detected', caseId: firstId });
  await recover(id);
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
  expect(
    resolved.resolution.evidence.every(
      (item) => !sources.some((source) => source.key === item.key),
    ),
  ).toBe(true);
  const next = randomUUID();
  await inject(next);
  const recurrence = await check();
  expect(recurrence.incident).toMatchObject({
    previousExceptionId: firstId,
    occurrenceCount: 1,
  });
  // An old recovery request leaves the new occurrence intact.
  await recover(id);
  expect((await check()).lastCheck.outcome).toBe('detect');
  await recover(next);
  expect((await check()).incident).toMatchObject({
    id: recurrence.incident.id,
    state: 'resolved',
  });
  await f.call('runs/operations/control', { action: 'reset' });
  await f.ready();
  expect((await check()).lastCheck.outcome).toBe('clear');
  const unauthenticated = await fetch(
    `${f.apiOrigin}/v1/organizations/${f.manifest.organizationId}/simulator/inventory`,
  );
  expect(unauthenticated.status).toBe(401);
});

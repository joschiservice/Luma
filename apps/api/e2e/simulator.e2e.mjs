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
  expect(sync.json().connections).toHaveLength(3);
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
  // Exact references link the shop, ERP and shipping views without manual steps.
  expect(await canonicalOrders()).toHaveLength(2);
  expect((await canonicalOrders()).every((row) => row.sources === 3)).toBe(
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
  expect(await canonicalOrders()).toHaveLength(3);
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
}, 120_000);

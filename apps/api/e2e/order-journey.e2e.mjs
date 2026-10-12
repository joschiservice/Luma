import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { Pool } from 'pg';
import { test } from 'vitest';

import { performanceReport } from '../../../tooling/performance/report.mjs';
import { fulfillmentFixture } from './fulfillment-fixture.mjs';
import { returnsFixture } from './returns-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

const ago = (hours) => new Date(Date.now() - hours * 3600000).toISOString();

test('split journeys retain exact source milestone times, unknowns, immutable references and tenant-scoped comparisons', async (t) => {
  const f = await settingsFixture(t),
    records = await fulfillmentFixture(t, f);
  const order = await records.order({
    external: 'journey-order',
    key: 'journey-order',
    updatedAt: ago(6),
    data: { displayNumber: '#JOURNEY', placedAt: ago(12) },
    lines: [{ external: 'journey-line', quantity: '4' }],
  });
  const shippedAt = ago(5),
    deliveredAt = ago(3);
  const first = await records.fulfillment({
    external: 'journey-first',
    order: 'journey-order',
    lines: [{ external: 'journey-line', quantity: '1' }],
    status: 'shipped',
    time: ago(4),
    facts: { kind: 'shipment', milestones: { shippedAt } },
  });
  const second = await records.fulfillment({
    external: 'journey-second',
    order: 'journey-order',
    lines: [{ external: 'journey-line', quantity: '2' }],
    status: 'delivered',
    time: ago(1),
    facts: {
      kind: 'shipment',
      milestones: { shippedAt: ago(4), deliveredAt: ago(2) },
    },
  });
  await records.fulfillment({
    external: 'journey-first',
    order: 'journey-order',
    lines: [{ external: 'journey-line', quantity: '1' }],
    status: 'delivered',
    time: ago(0.5),
    facts: { kind: 'shipment', milestones: { deliveredAt } },
  });
  const detail = await f.request(f.owner, `${f.base}/orders/${order}`);
  const journey = detail.journey;
  assert.equal(
    journey.events.filter((e) => e.partId === first && e.stage === 'shipped')
      .length,
    1,
  );
  assert.equal(
    journey.events.find((e) => e.partId === first && e.stage === 'shipped')
      .occurredAt,
    shippedAt,
  );
  assert.equal(
    journey.events.find((e) => e.partId === first && e.stage === 'delivered')
      .occurredAt,
    deliveredAt,
  );
  assert.equal(
    journey.events.find((e) => e.partId === second && e.stage === 'delivered')
      .quantity,
    '2.000000',
  );
  assert.equal(journey.events.find((e) => e.stage === 'paid').occurredAt, null);
  assert.ok(
    journey.events.every(
      (e) =>
        e.references.some((r) => r.kind === 'snapshot') &&
        e.references.some((r) => r.kind === 'observation'),
    ),
  );
  assert.ok(
    journey.candidates.some((c) => c.code === 'paid_without_reservation'),
  );
  assert.ok(
    journey.candidates.some((c) => c.code === 'shipped_without_reservation'),
  );
  const normal = journey.comparisons.find(
    (c) => c.from === 'shipped' && c.to === 'delivered',
  );
  assert.equal(normal.count, 2);
  assert.ok(Math.abs(normal.medianMs - 7200000) < 50);
  const found = await f.request(
    f.owner,
    `${f.base}/orders?view=stuck&q=JOURNEY`,
  );
  assert.deepEqual(
    found.items.map((x) => x.id),
    [order],
  );
  await f.request(
    f.outsider,
    `${f.base}/orders/${order}`,
    'GET',
    undefined,
    404,
  );
  const pool = new Pool({ connectionString: f.db.runtimeUrl });
  t.onTestFinished(() => pool.end());
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE luma_case_reader');
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [
      randomUUID(),
    ]);
    assert.equal(
      (
        await client.query(
          'SELECT count(*)::int count FROM orders_journey_events',
        )
      ).rows[0].count,
      0,
    );
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  const returned = await returnsFixture(t, f);
  await returned.returnRecord(
    1001,
    { receivedAt: ago(1) },
    { receivedQuantity: '1', restockedQuantity: '0' },
    ago(0.5),
  );
  const partial = await f.request(
    f.owner,
    `${f.base}/orders/${returned.orders[1001]}`,
  );
  assert.ok(
    partial.journey.events.some(
      (e) => e.stage === 'returned' && e.quantity === '1.000000',
    ),
  );
  assert.ok(
    partial.journey.events
      .filter((e) => e.stage === 'returned')
      .every((e) => e.references.some((r) => r.kind === 'return')),
  );
});

test('large order journeys bound payload work and measure the indexed read cost', async (t) => {
  const f = await settingsFixture(t),
    records = await fulfillmentFixture(t, f);
  const order = await records.order({
    external: 'large-journey',
    key: 'large-journey',
    updatedAt: ago(6),
    data: { displayNumber: '#LARGE-JOURNEY', placedAt: ago(12) },
    lines: Array.from({ length: 1000 }, (_, i) => ({
      external: `large-${i}`,
      quantity: '1',
    })),
  });
  const elapsed = [];
  let detail;
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    detail = await f.request(f.owner, `${f.base}/orders/${order}`);
    elapsed.push(performance.now() - start);
  }
  assert.equal(detail.journey.events.length, 500);
  assert.equal(detail.journey.truncated, true);
  const explain = await f.db.owner.query(
    'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT * FROM orders_journey_events WHERE tenant_id=$1 AND order_id=$2 ORDER BY observed_at,id LIMIT 501',
    [f.org.id, order],
  );
  const plan = explain.rows[0]['QUERY PLAN'][0];
  await performanceReport(
    'order-journey',
    {
      lineCount: 1000,
      retainedMilestones: 2000,
      returnedMilestones: 500,
      detailReadMs: Math.min(...elapsed),
      journeyQueryMs: plan['Execution Time'],
      sharedBlocks:
        plan.Plan['Shared Hit Blocks'] + plan.Plan['Shared Read Blocks'],
    },
    { detailReadMs: 2000, journeyQueryMs: 100 },
  );
  console.log(
    'Order journey query measurements',
    JSON.stringify({
      detailReadMs: Math.min(...elapsed),
      journeyQueryMs: plan['Execution Time'],
      sharedBlocks:
        plan.Plan['Shared Hit Blocks'] + plan.Plan['Shared Read Blocks'],
    }),
  );
});

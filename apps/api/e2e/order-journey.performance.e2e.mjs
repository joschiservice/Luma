import assert from 'node:assert/strict';

import { test } from 'vitest';

import { performanceReport } from '../../../tooling/performance/report.mjs';
import { fulfillmentFixture } from './fulfillment-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

const ago = (hours) => new Date(Date.now() - hours * 3600000).toISOString();

test('reads a 1,000-line order journey and its indexed query within budget', async (t) => {
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
});

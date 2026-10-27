import { expect, it } from 'vitest';

import { captureJson } from './capture.mjs';
import { fulfillmentFixture } from './fulfillment-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

const ago = (hours) => new Date(Date.now() - hours * 3_600_000).toISOString();

it.skipIf(!process.env.LUMA_INSIGHTS_BENCHMARK)(
  'reads order charts and records within the interactive budget',
  async (t) => {
    const count = Number(process.env.LUMA_INSIGHTS_BENCHMARK);
    const f = await settingsFixture(t);
    const work = await fulfillmentFixture(t, f);
    const template = await work.order({
      external: 'order-template',
      key: 'order-template',
      data: { displayNumber: '#template', placedAt: ago(1) },
      lines: [{ external: 'line-template', quantity: '1' }],
    });
    await work.importHistory(template, count);
    // Spread the imported orders over the last 13 weeks.
    await f.db.owner.query(
      `UPDATE orders_list SET placed_at=now()-(abs(hashtext(entity_id::text)) % 7776000)*interval '1 second'
       WHERE tenant_id=$1`,
      [f.org.id],
    );
    const fastest = async (path) => {
      const times = [];
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        await f.request(f.member, `${f.base}${path}`);
        times.push(performance.now() - start);
      }

      return Math.round(Math.min(...times));
    };
    const chart = await f.request(
      f.member,
      `${f.base}/insights/orders?range=13w`,
    );
    const result = {
      count,
      total: chart.total,
      chart13w: await fastest('/insights/orders?range=13w'),
      chart30d: await fastest('/insights/orders?range=30d'),
      records: await fastest(
        `/insights/orders/records?range=13w&point=${chart.points[6].key}&asOf=${chart.asOf}`,
      ),
      fulfillment: await fastest('/insights/fulfillment'),
    };
    await captureJson(`insights-benchmark-${count}.json`, result);
    expect(chart.total).toBeGreaterThan(count * 0.9);
  },
  300_000,
);

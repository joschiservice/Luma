import { performanceReport } from '../../../tooling/performance/report.mjs';
import { expect, test } from './browser-fixtures.mjs';
import { liveInsights } from './live-insights-fixture.mjs';
import { metricStream } from './metric-stream-fixture.mjs';
import {
  operationalEndpoint,
  operationalRequest,
  seedOperationalMetrics,
  summaryStatements,
} from './operational-metrics-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

test('measures commit-to-visible latency of cross-domain counts with concurrent readers', async ({
  resources: t,
  web,
}) => {
  const f = await settingsFixture(t, web.origin);
  const seed = await seedOperationalMetrics(f, 200);
  for (let i = 0; i < 40; i++) await seed.createOrder(seed.rows[i].sku);
  const { subscriptions: streams, context } = await liveInsights(
    t,
    web,
    f,
    { width: 1440, height: 1100 },
    (origin) =>
      metricStream(t, origin, f, f.member, true, {
        path: operationalEndpoint(f),
        body: operationalRequest,
      }),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(`/app/${f.org.id}/insights`);
  const section = page.getByRole('region', { name: 'Where work is waiting' });
  const count = async (id, n) =>
    expect
      .poll(
        () =>
          section
            .locator(`[data-metric="${id}"] .operational-value`)
            .textContent(),
        { interval: 20, timeout: 10000 },
      )
      .toBe(String(n));
  await count('cases.active', 200);
  await count('procurement.purchase_orders.draft', 40);
  await page
    .locator('.insights-live')
    .getByText('Live updates', { exact: true })
    .waitFor();

  const durations = [];
  for (let i = 0; i < 20; i++) {
    await seed.createOrder(seed.rows[40 + i].sku);
    const committed = performance.now();
    await count('procurement.purchase_orders.draft', 41 + i);
    durations.push(performance.now() - committed);
  }

  expect(streams.flatMap((s) => s.readErrors)).toEqual([]);
  const plans = await summaryStatements(f, { explain: true });
  const ordered = [...durations].sort((a, b) => a - b);
  await performanceReport('operational-metrics', {
    dataset: {
      cases: 200,
      positions: 200,
      activeRules: 200,
      purchaseOrders: 60,
      connections: 1,
    },
    subscribers: 6,
    crossDomainReaders: 6,
    changes: durations.length,
    p50Ms: ordered[Math.floor(ordered.length * 0.5)],
    p95Ms: ordered[Math.ceil(ordered.length * 0.95) - 1],
    maxMs: ordered.at(-1),
    durations,
    readCosts: streams.flatMap((s) => s.readCosts),
    plans,
    queryCount: plans.length,
  });
});

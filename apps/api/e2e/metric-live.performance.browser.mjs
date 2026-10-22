import { performanceReport } from '../../../tooling/performance/report.mjs';
import { expect, test } from './browser-fixtures.mjs';
import { liveInsights } from './live-insights-fixture.mjs';
import { metricStream } from './metric-stream-fixture.mjs';
import { seedMetricOrders } from './metrics-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

const p95 = (values) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];

test('measures commit-to-visible latency and delivery recovery with six subscribers on two API processes', async ({
  resources: t,
  web,
}) => {
  const f = await settingsFixture(t, web.origin);
  const seed = await seedMetricOrders(t, f);
  for (let i = 0; i < 200; i++) await seed(i);
  // Five additional real streams across two API processes; the browser is the sixth.
  const { subscriptions, context } = await liveInsights(
    t,
    web,
    f,
    { width: 1440, height: 1050 },
    (origin, i) => metricStream(t, origin, f, i < 2 ? f.member : f.owner, true),
  );
  const page = await context.newPage();
  await page.goto(`/app/${f.org.id}/insights`);
  const live = page.locator('.insights-live');
  const values = page
    .getByRole('region', { name: 'Orders', exact: true })
    .locator('.operational-value');
  const hasCount = async (count) =>
    expect
      .poll(() => values.first().textContent(), {
        interval: 20,
        timeout: 10000,
      })
      .toBe(String(count));
  await hasCount(200);
  await live.getByText('Live updates', { exact: true }).waitFor();
  const rows = await f.db.owner.query(
    "SELECT id FROM orders_snapshots WHERE tenant_id=$1 AND kind='order' ORDER BY entity_id LIMIT 1",
    [f.org.id],
  );
  const setStatus = (status) =>
    f.db.owner.query(
      "UPDATE orders_snapshots SET document=jsonb_set(document,'{data,status}',to_jsonb($2::text)) WHERE id=$1",
      [rows.rows[0].id, status],
    );

  const durations = [];
  const queryCosts = [];
  const started = performance.now();
  for (let i = 0; i < 20; i++) {
    await setStatus(i % 2 === 0 ? 'cancelled' : 'open');
    const committed = performance.now();
    await hasCount(i % 2 === 0 ? 199 : 200);
    durations.push(performance.now() - committed);
    const read = performance.now();
    await f.request(f.owner, `${f.base}/metrics/query`, 'POST', {});
    queryCosts.push(performance.now() - read);
  }
  const workloadMs = performance.now() - started;

  await context.setOffline(true);
  await live.getByText('Offline', { exact: true }).waitFor();
  await setStatus('cancelled');
  const recoveryStart = performance.now();
  await context.setOffline(false);
  await hasCount(199);
  await live.getByText('Live updates', { exact: true }).waitFor();
  const browserRecoveryMs = performance.now() - recoveryStart;

  expect(subscriptions.flatMap((s) => s.readErrors)).toEqual([]);
  // Each subscriber kept reading through the measured writes.
  expect(subscriptions.every((s) => s.readCosts.length >= 20)).toBe(true);
  const latest = await f.request(
    f.owner,
    `${f.base}/metrics/query`,
    'POST',
    {},
  );
  await performanceReport(
    'metric-live',
    {
      datasetOrders: 200,
      subscriptions: 6,
      apiInstances: 2,
      mutations: 20,
      writesPerSecond: 20 / (workloadMs / 1000),
      commitToVisibleP95Ms: p95(durations),
      metricHttpReadP95Ms: p95(queryCosts),
      subscriberReadP95Ms: p95(subscriptions.flatMap((s) => s.readCosts)),
      browserRecoveryMs,
      latestSourceObservationAgeMs:
        Date.parse(latest.readAt) - Date.parse(latest.observedAt),
      durations,
      subscriberBytes: subscriptions.reduce(
        (sum, s) => sum + s.receivedBytes,
        0,
      ),
      maxFrameBytes: Math.max(...subscriptions.map((s) => s.maxFrameBytes)),
    },
    {
      // Dashboards refresh at most every two seconds (liveRefreshMs).
      commitToVisibleP95Ms: 3000,
      subscriberBytes: 128 * 1024,
    },
  );
});

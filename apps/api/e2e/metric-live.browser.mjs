import { mkdir, writeFile } from 'node:fs/promises';

import { buildRuntimeApp } from '@luma/application-runtime';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';

import { availablePort, startProcess } from './helpers.mjs';
import { metricStream } from './metric-stream-fixture.mjs';
import { seedMetricFulfillment, seedMetricOrders } from './metrics-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

it('updates visible totals and cohorts, crosses deadlines, and measures delivery and recovery', async (t) => {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const f = await settingsFixture(t, origin);
  const seed = await seedMetricOrders(t, f);
  for (let i = 0; i < 200; i++) await seed(i);
  const api = await f.app.listen({ host: '127.0.0.1', port: 0 });
  const second = await buildRuntimeApp(f.config);
  t.onTestFinished(() => second.close());
  const other = await second.listen({ host: '127.0.0.1', port: 0 });
  // Five additional real streams across two API processes; the browser is the sixth.
  const subscriptions = await Promise.all([
    metricStream(t, api, f, f.member, true),
    metricStream(t, api, f, f.member, true),
    metricStream(t, other, f, f.owner, true),
    metricStream(t, other, f, f.owner, true),
    metricStream(t, other, f, f.owner, true),
  ]);
  const web = startProcess(
    t,
    'e2e/web-server.mjs',
    { TEST_API_ORIGIN: api, TEST_WEB_PORT: String(port) },
    true,
  );
  await web.message('listening');
  const browser = await chromium.launch();
  t.onTestFinished(() => browser.close());
  const context = await browser.newContext({
    baseURL: origin,
    viewport: { width: 1440, height: 1050 },
  });
  await context.addCookies(
    f.owner.cookie.split('; ').map((value) => {
      const [name, ...rest] = value.split('=');

      return { name, value: rest.join('='), url: origin };
    }),
  );
  const page = await context.newPage();
  await page.goto(`/app/${f.org.id}/overview`);
  const section = page.getByRole('region', {
    name: 'The work behind the numbers',
  });
  const values = section.locator('.order-metric-value');
  const hasCount = async (index, count) =>
    expect
      .poll(() => values.nth(index).textContent(), {
        interval: 20,
        timeout: 10000,
      })
      .toMatch(new RegExp(`^${count}observed`));
  await hasCount(0, 200);
  await section.getByText('Live updates', { exact: true }).waitFor();
  const rows = await f.db.owner.query(
    "SELECT id,entity_id FROM orders_snapshots WHERE tenant_id=$1 AND kind='order' ORDER BY entity_id",
    [f.org.id],
  );
  const target = rows.rows[0].id;
  const setStatus = (status) =>
    f.db.owner.query(
      "UPDATE orders_snapshots SET document=jsonb_set(document,'{data,status}',to_jsonb($2::text)) WHERE id=$1",
      [target, status],
    );
  let held = false;
  let released = false;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(
    '**/metrics/query',
    async (route) => {
      const response = await route.fetch();
      held = true;
      await gate;
      try {
        await route.fulfill({ response });
      } catch {
        /* The replaced query has already been aborted. */
      } finally {
        released = true;
      }
    },
    { times: 1 },
  );
  await section
    .getByRole('button', { name: 'Refresh orders', exact: true })
    .click();
  await expect.poll(() => held).toBe(true);
  await setStatus('cancelled');
  await hasCount(0, 199);
  release();
  await expect.poll(() => released).toBe(true);
  await hasCount(0, 199);
  await setStatus('open');
  await hasCount(0, 200);
  const durations = [];
  const queryCosts = [];
  const started = performance.now();
  for (let i = 0; i < 20; i++) {
    await setStatus(i % 2 === 0 ? 'cancelled' : 'open');
    const committed = performance.now();
    await hasCount(0, i % 2 === 0 ? 199 : 200);
    durations.push(performance.now() - committed);
    const read = performance.now();
    await f.request(f.owner, `${f.base}/metrics/query`, 'POST', {});
    queryCosts.push(performance.now() - read);
  }
  const workloadMs = performance.now() - started;
  await seed(200);
  await hasCount(0, 201);
  await f.db.owner.query(
    "DELETE FROM orders_projections p USING orders_snapshots s WHERE p.snapshot_id=s.id AND s.tenant_id=$1 AND s.display_number='#1200'",
    [f.org.id],
  );
  await hasCount(0, 200);
  await section
    .getByRole('button', { name: 'Inspect orders & definition' })
    .first()
    .click();
  const dialog = page.getByRole('dialog');
  const orderNumber = await dialog
    .locator('.order-cohort-list strong')
    .first()
    .textContent();
  await setStatus('completed');
  await expect
    .poll(() => dialog.locator('.order-cohort-list').textContent())
    .not.toContain(orderNumber);
  await page.keyboard.press('Escape');
  await setStatus('open');
  await hasCount(0, 200);
  const fulfillment = await seedMetricFulfillment(f, target);
  await hasCount(0, 199);
  await f.db.owner.query(
    'DELETE FROM orders_projections WHERE tenant_id=$1 AND entity_id=$2',
    [f.org.id, fulfillment.id],
  );
  await hasCount(0, 200);
  await f.db.owner.query('DELETE FROM orders_snapshots WHERE id=$1', [
    fulfillment.snapshotId,
  ]);
  // All deadlines move into the future. The next boundary includes orders beyond page one.
  const due = new Date(Date.now() + 2000).toISOString();
  await f.db.owner.query(
    "UPDATE orders_snapshots SET document=jsonb_set(document,'{data,dueAt}',to_jsonb($2::text)) WHERE tenant_id=$1 AND kind='order'",
    [f.org.id, due],
  );
  await hasCount(1, 0);
  await hasCount(1, 200);
  await context.setOffline(true);
  await section.getByText('Offline', { exact: true }).waitFor();
  await setStatus('cancelled');
  const recoveryStart = performance.now();
  await context.setOffline(false);
  await hasCount(0, 199);
  await section.getByText('Live updates', { exact: true }).waitFor();
  const browserRecoveryMs = performance.now() - recoveryStart;
  // Degraded connector observation state remains separate from live internal delivery.
  await f.db.owner.query(
    "UPDATE connector_installations SET document=jsonb_set(document,'{status}','\"degraded\"') WHERE tenant_id=$1",
    [f.org.id],
  );
  await section.getByText('Stale observations', { exact: true }).waitFor();
  await section.getByText('Live updates', { exact: true }).waitFor();
  await mkdir('/tmp/luma85-ui', { recursive: true });
  await section.screenshot({ path: '/tmp/luma85-ui/desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await section.screenshot({ path: '/tmp/luma85-ui/mobile.png' });
  const p95 = (values) =>
    [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
  expect(subscriptions.flatMap((s) => s.readErrors)).toEqual([]);
  expect(subscriptions.every((s) => s.readCosts.length >= 20)).toBe(true);
  const latest = await f.request(
    f.owner,
    `${f.base}/metrics/query`,
    'POST',
    {},
  );
  const measurements = {
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
  };
  await writeFile(
    '/tmp/luma85-load.json',
    JSON.stringify(measurements, null, 2),
  );
  console.log(JSON.stringify(measurements));
  expect(measurements.commitToVisibleP95Ms).toBeLessThan(1000);
  // Session loss clears the visible private result and stops further live reads.
  await f.db.owner.query('DELETE FROM sessions WHERE user_id=$1', [f.owner.id]);
  await expect.poll(() => values.count(), { timeout: 10000 }).toBe(0);
});

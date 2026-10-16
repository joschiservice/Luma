/* global document, window */
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

import { buildRuntimeApp } from '@luma/application-runtime';
import { createConnectionCoverage } from '@luma/connections/composition';
import { createCaseMetricReader } from '@luma/exceptions/composition';
import { builtInMembership, makeTenantContext } from '@luma/identity';
import { createTenantDatabase } from '@luma/platform/composition';
import { createProcurementMetricReader } from '@luma/procurement/composition';
import { createOperationalSummary } from '@luma/read-models/composition';

import { performanceReport } from '../../../tooling/performance/report.mjs';
import { expect, test } from './browser-fixtures.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { metricStream } from './metric-stream-fixture.mjs';
import {
  operationalEndpoint,
  operationalRequest,
  seedOperationalMetrics,
} from './operational-metrics-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

test('keeps cross-domain cohorts live, recovers races and measures committed changes with concurrent readers', async ({
  resources: t,
}) => {
  const port = await availablePort(),
    origin = `http://127.0.0.1:${port}`;
  const f = await settingsFixture(t, origin);
  const seed = await seedOperationalMetrics(f, 200);
  for (let i = 0; i < 40; i++) await seed.createOrder(seed.rows[i].sku);
  const api = await f.app.listen({ host: '127.0.0.1', port: 0 });
  const second = await buildRuntimeApp(f.config);
  t.onTestFinished(() => second.close());
  const other = await second.listen({ host: '127.0.0.1', port: 0 });
  const streams = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      metricStream(t, i < 2 ? api : other, f, f.member, true, {
        path: operationalEndpoint(f),
        body: operationalRequest,
      }),
    ),
  );
  const web = startProcess(
    t,
    'e2e/web-server.mjs',
    { TEST_API_ORIGIN: api, TEST_WEB_PORT: String(port) },
    true,
  );
  await web.message('listening');
  const context = await t.newContext({
    baseURL: origin,
    viewport: { width: 1440, height: 1100 },
  });
  await context.addCookies(
    f.owner.cookie.split('; ').map((value) => {
      const [name, ...rest] = value.split('=');

      return { name, value: rest.join('='), url: origin };
    }),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/app/${f.org.id}/insights`);
  const section = page.getByRole('region', { name: 'Where work is waiting' });
  const value = (id) =>
    section.locator(`[data-metric="${id}"] .operational-value`);
  const count = async (id, n) =>
    expect
      .poll(() => value(id).textContent(), { interval: 20, timeout: 10000 })
      .toBe(String(n));
  await count('cases.active', 200);
  await count('inventory.below_minimum', 200);
  await count('procurement.purchase_orders.draft', 40);
  // Insights shows the live status once for the page.
  await page
    .locator('.insights-live')
    .getByText('Live updates', { exact: true })
    .waitFor();
  await section.locator('[data-metric="cases.attention"]').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('Outcome unclear · 200').waitFor();
  await dialog.getByRole('button', { name: 'Next', exact: true }).click();
  await dialog.getByText('21–40 of 200', { exact: false }).waitFor();
  await page.keyboard.press('Escape');
  await expect
    .poll(() =>
      section
        .locator('[data-metric="cases.attention"]')
        .evaluate((el) => el === document.activeElement),
    )
    .toBe(true);
  // A held response must not overwrite a committed case update.
  let release,
    held = false;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(
    '**/v2/organizations/*/metrics/summary',
    async (route) => {
      const response = await route.fetch();
      held = true;
      await gate;
      try {
        await route.fulfill({ response });
      } catch {
        /* The superseded request was aborted. */
      }
    },
    { times: 1 },
  );
  await page.getByRole('button', { name: 'Refresh insights' }).click();
  await expect.poll(() => held).toBe(true);
  await f.db.owner.query(
    "UPDATE exceptions SET state='detected',document=jsonb_set(document,'{state}','\"detected\"') WHERE id=$1",
    [seed.rows[0].id],
  );
  await count('cases.attention', 199);
  release();
  await count('cases.attention', 199);
  const durations = [];
  for (let i = 0; i < 20; i++) {
    const created = await seed.createOrder(seed.rows[40 + i].sku);
    const committed = performance.now();
    await count('procurement.purchase_orders.draft', 41 + i);
    durations.push(performance.now() - committed);
    if (i === 0) {
      await section.locator('[data-metric="inventory.below_minimum"]').click();
      await dialog.getByText('Already ordered · 41').waitFor();
      await dialog
        .getByRole('link', { name: /Purchase order/ })
        .first()
        .waitFor();
      await page.keyboard.press('Escape');
      await f.request(
        f.owner,
        `${f.base}/procurement/purchase-orders/${created.order.id}/transitions`,
        'POST',
        {
          id: randomUUID(),
          expectedRevision: 1,
          status: 'open',
          reason: 'Reviewed',
        },
      );
      await count('procurement.purchase_orders.open', 1);
      await f.request(
        f.owner,
        `${f.base}/procurement/purchase-orders/${created.order.id}/transitions`,
        'POST',
        {
          id: randomUUID(),
          expectedRevision: 2,
          status: 'cancelled',
          reason: 'Cancelled',
        },
      );
      // Add a replacement so each iteration still increases drafts by one.
      await seed.createOrder(seed.rows[40 + i].sku);
      await count('procurement.purchase_orders.draft', 41);
    }
  }
  await f.db.owner.query(
    'UPDATE replenishment_activations SET active=false WHERE id=$1',
    [seed.rows[199].ruleId],
  );
  await count('inventory.below_minimum', 199);
  await f.db.owner.query(
    'DELETE FROM inventory_projections WHERE entity_id=$1',
    [seed.rows[198].positionId],
  );
  await count('inventory.below_minimum', 198);
  await count('inventory.replenishment_unknown', 1);
  // Near-expiry stock moves to unknown without a subsequent write.
  await f.db.owner.query(
    "UPDATE inventory_snapshots SET document=jsonb_set(document,'{observedAt}',to_jsonb($2::text)) WHERE id=$1",
    [seed.rows[197].snapshotId, new Date(Date.now() - 299000).toISOString()],
  );
  await count('inventory.replenishment_unknown', 2);
  await context.setOffline(true);
  await page
    .locator('.insights-live')
    .getByText('Offline', { exact: true })
    .waitFor();
  await context.setOffline(false);
  await count('inventory.replenishment_unknown', 2);
  await mkdir('/tmp/luma87-ui', { recursive: true });
  await section.scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/luma87-ui/desktop.png', fullPage: true });
  await section
    .locator('[data-metric="inventory.replenishment_unknown"]')
    .click();
  await dialog.getByText('Stock not reported · 1').waitFor();
  await expect
    .poll(() => dialog.evaluate((el) => window.getComputedStyle(el).opacity))
    .toBe('1');
  await page.screenshot({ path: '/tmp/luma87-ui/cohort.png', fullPage: true });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await section.scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/luma87-ui/mobile.png', fullPage: true });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const plans = [];
  const db = createTenantDatabase(f.db.owner);
  const measured = {
    transaction: (tenant, operation, options) =>
      db.transaction(
        tenant,
        (tx) =>
          operation({
            query: async (sql, values) => {
              if (/^\s*(SELECT|WITH)/i.test(sql))
                plans.push({
                  sql,
                  plan: (
                    await tx.query(
                      `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`,
                      values,
                    )
                  ).rows[0]['QUERY PLAN'],
                });

              return tx.query(sql, values);
            },
          }),
        options,
      ),
  };
  const actor = makeTenantContext(
    { userId: f.owner.id, sessionId: 'fixture' },
    { ...f.org, status: 'active', dataRegion: 'AU' },
    builtInMembership(
      { id: randomUUID(), organizationId: f.org.id, userId: f.owner.id },
      'owner',
    ),
    randomUUID(),
  );
  await createOperationalSummary(measured, {
    cases: createCaseMetricReader,
    procurement: createProcurementMetricReader,
    coverage: createConnectionCoverage,
  })(actor, operationalRequest);
  const ordered = [...durations].sort((a, b) => a - b);
  const report = {
    dataset: {
      cases: 200,
      positions: 200,
      activeRules: 199,
      purchaseOrders: 61,
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
  };
  await performanceReport('operational-metrics', report, { queryCount: 12 });
  console.log(
    'LUMA-87 latency',
    JSON.stringify({
      p50Ms: report.p50Ms,
      p95Ms: report.p95Ms,
      maxMs: report.maxMs,
    }),
  );
  expect(streams.flatMap((s) => s.readErrors)).toEqual([]);
  expect(errors).toEqual([]);
  // Access loss hides all previously visible private records.
  await f.db.owner.query('DELETE FROM sessions WHERE user_id=$1', [f.owner.id]);
  await expect
    .poll(() => section.locator('.operational-value').count(), {
      timeout: 20000,
    })
    .toBe(0);
});

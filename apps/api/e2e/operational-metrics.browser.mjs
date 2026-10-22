/* global document, window */
import { randomUUID } from 'node:crypto';

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

test('keeps cross-domain cohorts live and recovers races with concurrent readers', async ({
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
  const created = await seed.createOrder(seed.rows[40].sku);
  await count('procurement.purchase_orders.draft', 41);
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
  await seed.createOrder(seed.rows[40].sku);
  await count('procurement.purchase_orders.draft', 41);
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
  await section.scrollIntoViewIfNeeded();
  await section
    .locator('[data-metric="inventory.replenishment_unknown"]')
    .click();
  await dialog.getByText('Stock not reported · 1').waitFor();
  await expect
    .poll(() => dialog.evaluate((el) => window.getComputedStyle(el).opacity))
    .toBe('1');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await section.scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  // One summary read across its six domain readers stays within its statement budget.
  expect((await summaryStatements(f)).length).toBeLessThanOrEqual(12);
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

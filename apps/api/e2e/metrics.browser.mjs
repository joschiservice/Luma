/* global document, window */
import { mkdir } from 'node:fs/promises';

import { expect, test } from './browser-fixtures.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { seedMetricOrders } from './metrics-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

test('explains unknown order totals, opens accessible cohorts and recovers from errors on desktop and mobile', async ({
  resources: t,
}) => {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const f = await settingsFixture(t, origin);
  const endpoint = `${f.base}/metrics/query`;
  const empty = await f.request(f.member, endpoint, 'POST', {});
  expect(empty.coverage).toBe('unavailable');
  expect(
    empty.metrics.every((m) => m.total === null && m.observedCount === 0),
  ).toBe(true);
  await f.request(f.outsider, endpoint, 'POST', {}, 404);
  await f.request(null, endpoint, 'POST', {}, 401);
  const apiOrigin = await f.app.listen({ host: '127.0.0.1', port: 0 });
  const web = startProcess(
    t,
    'e2e/web-server.mjs',
    { TEST_API_ORIGIN: apiOrigin, TEST_WEB_PORT: String(port) },
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
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/app/${f.org.id}/insights`);
  // Insights shows orders as one group of the Now view.
  const section = page.getByRole('region', { name: 'Orders', exact: true });
  const refresh = page.getByRole('button', {
    name: 'Refresh insights',
    exact: true,
  });
  await section.getByText('No order data yet').first().waitFor();
  expect(await section.getByText('No order data yet').count()).toBe(3);
  await section.locator('[data-metric="orders.open"]').click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByRole('heading', { name: 'Open orders', exact: true })
    .waitFor();
  await dialog.getByText('No matching orders found').waitFor();
  expect(
    await dialog
      .getByRole('button', { name: 'Next', exact: true })
      .isDisabled(),
  ).toBe(true);
  await mkdir('/tmp/luma84-ui', { recursive: true });
  await expect
    .poll(() => dialog.evaluate((el) => window.getComputedStyle(el).opacity))
    .toBe('1');
  await page.screenshot({ path: '/tmp/luma84-ui/desktop.png', fullPage: true });
  await page.keyboard.press('Escape');
  await expect
    .poll(() =>
      section
        .locator('[data-metric="orders.open"]')
        .evaluate((el) => el === document.activeElement),
    )
    .toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await section.scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/luma84-ui/mobile.png', fullPage: true });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  // The page reads every metric view in one summary; only the order part fails.
  await page.route(
    '**/v2/organizations/*/metrics/summary',
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        response,
        json: {
          ...body,
          parts: body.parts.map((part) =>
            part.kind === 'orders'
              ? {
                  kind: 'orders',
                  status: 503,
                  error: {
                    code: 'SERVICE_UNAVAILABLE',
                    message: 'Unavailable',
                    requestId: 'test',
                  },
                }
              : part,
          ),
        },
      });
    },
    { times: 1 },
  );
  await refresh.click();
  await section
    .getByText('Order counts unavailable', { exact: true })
    .waitFor();
  expect(await section.getByText('No order data yet').count()).toBe(0);
  await refresh.click();
  await section.getByText('No order data yet').first().waitFor();
  const seed = await seedMetricOrders(t, f);
  for (let i = 0; i < 25; i++) await seed(i);
  await refresh.click();
  await expect(
    section.locator('[data-metric="orders.open"] .operational-value'),
  ).toHaveText('25');
  await section.locator('[data-metric="orders.open"]').click();
  await dialog.getByText('1–20 of 25 matching orders').waitFor();
  expect(
    await dialog
      .getByRole('list', { name: 'Matching orders' })
      .locator('li')
      .count(),
  ).toBe(20);
  await dialog.getByRole('button', { name: 'Next', exact: true }).click();
  await dialog.getByText('21–25 of 25 matching orders').waitFor();
  await expect
    .poll(() => dialog.evaluate((el) => window.getComputedStyle(el).opacity))
    .toBe('1');
  await page.screenshot({
    path: '/tmp/luma84-ui/mobile-cohort.png',
    fullPage: true,
  });
  // A live change keeps the page in place until the person asks for the latest records.
  await seed(26);
  await dialog.getByText('The matching orders changed').waitFor();
  await dialog.getByText('21–25 of 25 matching orders').waitFor();
  await dialog.getByRole('button', { name: 'Show latest' }).click();
  await dialog.getByText('1–20 of 26 matching orders').waitFor();
  expect(await dialog.getByText('The matching orders changed').count()).toBe(0);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await section.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: '/tmp/luma84-ui/populated.png',
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

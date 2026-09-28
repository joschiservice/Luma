/* global document, window */
import { mkdir } from 'node:fs/promises';

import { chromium } from 'playwright';
import { expect, it } from 'vitest';

import { availablePort, startProcess } from './helpers.mjs';
import { seedMetricOrders } from './metrics-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

it('explains unknown order totals, opens accessible cohorts and recovers from errors on desktop and mobile', async (t) => {
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
  const browser = await chromium.launch();
  t.onTestFinished(() => browser.close());
  const context = await browser.newContext({
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
  const section = page.getByRole('region', {
    name: 'The work behind the numbers',
  });
  await section.getByText('Awaiting order observations').first().waitFor();
  expect(await section.getByText('Awaiting order observations').count()).toBe(
    3,
  );
  await section
    .getByRole('button', { name: 'Inspect orders & definition' })
    .first()
    .click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByRole('heading', { name: 'Open orders', exact: true })
    .waitFor();
  await dialog.getByText('No observed matches').waitFor();
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
        .getByRole('button', { name: 'Inspect orders & definition' })
        .first()
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
  await page.route(
    '**/v1/organizations/*/metrics/query',
    (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'SERVICE_UNAVAILABLE',
          message: 'Unavailable',
          requestId: 'test',
        }),
      }),
    { times: 1 },
  );
  await section
    .getByRole('button', { name: 'Refresh orders', exact: true })
    .click();
  await section
    .getByText('Order metrics unavailable', { exact: true })
    .waitFor();
  expect(await section.getByText('Awaiting order observations').count()).toBe(
    0,
  );
  await section
    .getByRole('button', { name: 'Refresh orders', exact: true })
    .click();
  await section.getByText('Awaiting order observations').first().waitFor();
  const seed = await seedMetricOrders(t, f);
  for (let i = 0; i < 25; i++) await seed(i);
  await section
    .getByRole('button', { name: 'Refresh orders', exact: true })
    .click();
  await section.getByText('observed orders', { exact: true }).first().waitFor();
  await section
    .getByRole('button', { name: 'Inspect orders & definition' })
    .first()
    .click();
  await dialog.getByText('1–20 of 25 known matches').waitFor();
  expect(
    await dialog
      .getByRole('list', { name: 'Matching orders' })
      .locator('li')
      .count(),
  ).toBe(20);
  await dialog.getByRole('button', { name: 'Next', exact: true }).click();
  await dialog.getByText('21–25 of 25 known matches').waitFor();
  await expect
    .poll(() => dialog.evaluate((el) => window.getComputedStyle(el).opacity))
    .toBe('1');
  await page.screenshot({
    path: '/tmp/luma84-ui/mobile-cohort.png',
    fullPage: true,
  });
  await seed(26);
  await dialog.getByText('1–20 of 26 known matches').waitFor();
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

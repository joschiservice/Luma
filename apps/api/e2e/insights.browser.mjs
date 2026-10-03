/* global document, window */
import { expect, test } from './browser-fixtures.mjs';
import { fulfillmentFixture } from './fulfillment-fixture.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { settingsFixture } from './settings-fixture.mjs';

test('opens the exact records behind a chart point and returns to them', async ({
  resources: t,
}) => {
  const port = await availablePort(),
    origin = `http://127.0.0.1:${port}`;
  const f = await settingsFixture(t, origin);
  const work = await fulfillmentFixture(t, f);
  await work.issue();
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
    viewport: { width: 1440, height: 1000 },
  });
  await context.addCookies(
    f.member.cookie.split('; ').map((value) => {
      const [name, ...rest] = value.split('=');

      return { name, value: rest.join('='), url: origin };
    }),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto(`/app/${f.org.id}/insights?range=7d`);
  await page.getByRole('heading', { name: 'Operational trends' }).waitFor();
  const orders = page.getByRole('group', {
    name: 'Orders placed, last 7 days',
  });
  await orders.waitFor();
  // Sources without an import are named, and unknown history is never shown as complete.
  const card = page.locator('section[data-chart="orders"]');
  await expect(card).toContainText('Partial coverage');
  await expect(card).toContainText('Observed records only');
  // Without replenishment rules, stock risk says why instead of showing zeros.
  await expect(page.locator('section[data-chart="stock"]')).toContainText(
    'stock risk is unknown, not zero',
  );

  // The keyboard reaches the chart in one stop and opens the latest day with orders.
  const bars = orders.getByRole('button');
  const names = await bars.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('aria-label')),
  );
  const day = names.findLastIndex((name) => !/: 0 orders\.$/.test(name));
  expect(day).toBeGreaterThanOrEqual(0);
  await bars.first().focus();
  await page.keyboard.press('End');
  for (let index = names.length - 1; index > day; index--)
    await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('heading', { name: /^Orders · / }).waitFor();
  await expect(sheet).toContainText('matches the chart');
  const total = Number(/: (\d+) orders?/.exec(names[day])[1]);
  expect(await sheet.getByRole('listitem').count()).toBe(total);
  await page.screenshot({ path: '/tmp/luma107-sheet-light.png' });

  // A record opens with a way back to these records.
  const drill = page.url();
  expect(new URL(drill).searchParams.get('chart')).toBe('orders');
  await sheet.getByRole('link', { name: /^#\d+/ }).first().click();
  await page.getByRole('link', { name: 'Back to context' }).click();
  await page.waitForURL(drill);
  await sheet.getByRole('heading', { name: /^Orders · / }).waitFor();

  // The Orders workspace opens with the same filters and the same count.
  await sheet
    .getByRole('link', { name: 'Open these orders in Orders' })
    .click();
  await page.waitForURL(`**/app/${f.org.id}/orders?**`);
  await expect(page.getByRole('link', { name: /^#\d+/ })).toHaveCount(total);
  await page.goBack();
  await sheet.waitFor();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  expect(new URL(page.url()).searchParams.get('chart')).toBeNull();

  // The table view opens the same records as the bars.
  const backlog = page.locator('section[data-chart="fulfillment"]');
  await backlog.getByRole('button', { name: 'Table', exact: true }).click();
  await backlog
    .getByRole('table', { name: 'Fulfillment backlog' })
    .getByRole('button', { name: /No progress\. Show the records\.$/ })
    .click();
  await sheet
    .getByRole('heading', { name: /No progress · 2–7 days$/ })
    .waitFor();
  await expect(sheet.getByRole('link', { name: /^#201/ })).toBeVisible();
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.screenshot({ path: '/tmp/luma107-sheet-dark.png' });
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  await page.keyboard.press('Escape');

  await page.setViewportSize({ width: 390, height: 844 });
  await orders.waitFor();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: '/tmp/luma107-narrow.png', fullPage: true });
  expect(errors).toEqual([]);
});

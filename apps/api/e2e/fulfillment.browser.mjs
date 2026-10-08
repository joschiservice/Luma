/* global document */
import { expect, test } from './browser-fixtures.mjs';
import { fulfillmentFixture } from './fulfillment-fixture.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { settingsFixture } from './settings-fixture.mjs';

test('finds a held fulfillment, explains the next safe step and follows its order', async ({
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

  // G then F opens the workspace on what needs attention, longest wait first.
  await page.goto(`/app/${f.org.id}/home`);
  await page.getByRole('heading', { level: 1 }).first().waitFor();
  await page.keyboard.press('g');
  await page.keyboard.press('f');
  await page.waitForURL(`**/app/${f.org.id}/fulfillment`);
  await page
    .getByRole('heading', { name: 'Fulfillment', exact: true })
    .waitFor();
  const table = page.getByRole('table', { name: /^Needs attention/ });
  await table.getByRole('link', { name: '#201', exact: true }).waitFor();
  expect(await table.getByRole('row').count()).toBe(4);
  await expect(table).toContainText('Held: Incorrect address.');
  await expect(table).toContainText('Delivery attempted · 4521-8876-0012.');
  await page.screenshot({
    path: '/tmp/luma102-list-light.png',
    fullPage: true,
  });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.screenshot({ path: '/tmp/luma102-list-dark.png', fullPage: true });
  await page.evaluate(() => document.documentElement.classList.remove('dark'));

  // A tracking number search keeps the view in the address.
  await page.getByRole('tab', { name: /^All/ }).click();
  await page
    .getByRole('searchbox', { name: 'Search fulfillment' })
    .fill('4521-8876');
  await page.keyboard.press('Enter');
  await page.getByRole('link', { name: '#202', exact: true }).waitFor();
  const url = new URL(page.url());
  expect(url.searchParams.get('view')).toBe('all');
  expect(url.searchParams.get('q')).toBe('4521-8876');

  // The held work explains its cause, the next step and what counts as progress.
  await page.getByRole('tab', { name: /^On hold/ }).click();
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await page.getByRole('link', { name: '#200', exact: true }).click();
  await page
    .getByRole('heading', { name: 'On hold: Incorrect address' })
    .waitFor();
  await page
    .getByRole('heading', { name: 'Resolve the hold in Tokyo store' })
    .waitFor();
  await expect(page.getByText('Hold added: Incorrect address')).toHaveCount(2);
  await page.getByRole('link', { name: 'stuck fulfillment' }).waitFor();
  await page.screenshot({
    path: '/tmp/luma102-detail-light.png',
    fullPage: true,
  });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.screenshot({
    path: '/tmp/luma102-detail-dark.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: '/tmp/luma102-detail-mobile.png',
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  await page.setViewportSize({ width: 1440, height: 1000 });

  // The order links back to the same fulfillment.
  await page.getByRole('link', { name: '#200', exact: true }).click();
  await page.waitForURL(`**/orders/*`);
  await page.getByRole('link', { name: /^Open fulfillment: / }).click();
  await page.waitForURL(`**/fulfillment/${work.ids.held}*`);
  await page
    .getByRole('heading', { name: 'On hold: Incorrect address' })
    .waitFor();
  await page.getByRole('link', { name: 'Back to previous page' }).click();
  await page.waitForURL(`**/orders/*`);
  expect(errors).toEqual([]);
});

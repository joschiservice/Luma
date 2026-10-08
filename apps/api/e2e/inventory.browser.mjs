/* global document */
import { expect, test } from './browser-fixtures.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { inventoryFixture } from './inventory-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

test('investigates stock differences, follows affected orders and preserves filters', async ({
  resources: t,
}) => {
  const port = await availablePort(),
    origin = `http://127.0.0.1:${port}`;
  const f = await settingsFixture(t, origin);
  const stock = await inventoryFixture(t, f);
  const issueId = await stock.issue();
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
  await page.goto(`/app/${f.org.id}/exceptions/${issueId}/detail`);
  await page.getByRole('link', { name: 'Inspect inventory' }).click();
  await page.getByRole('heading', { name: 'Inventory', exact: true }).waitFor();
  await page
    .getByRole('tab', { name: 'Source differences', exact: true })
    .click();
  const search = page.getByRole('searchbox', { name: 'Search inventory' });
  await search.fill('77');
  await search.press('Enter');
  await page.waitForURL((url) => url.searchParams.get('q') === '"77"');
  await page.getByRole('link', { name: 'SKU-100', exact: true }).waitFor();
  await page.screenshot({
    path: '/tmp/luma99-inventory-light.png',
    fullPage: true,
  });
  await page.getByRole('link', { name: 'SKU-100', exact: true }).click();
  await page
    .getByRole('heading', {
      name: 'Same position. Different source quantities.',
    })
    .waitFor();
  await page.getByRole('heading', { name: 'Recent readings' }).waitFor();
  await page.getByRole('link', { name: '#100', exact: true }).waitFor();
  expect(
    await page
      .getByRole('table', { name: 'Source quantity comparison' })
      .innerText(),
  ).toContain('Not reported');
  await page.screenshot({
    path: '/tmp/luma99-detail-light.png',
    fullPage: true,
  });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.screenshot({
    path: '/tmp/luma99-detail-dark.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: '/tmp/luma99-detail-mobile.png',
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  // Opened from an issue, the detail page links back to that issue; history returns to the list.
  await page.getByRole('link', { name: 'Back to previous page' }).waitFor();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goBack();
  await page.getByRole('link', { name: 'SKU-100', exact: true }).waitFor();
  expect(JSON.parse(new URL(page.url()).searchParams.get('q'))).toBe('77');
  expect(new URL(page.url()).searchParams.get('view')).toBe('differs');
  await search.fill('does-not-exist');
  await search.press('Enter');
  await page.getByRole('heading', { name: 'No stock matches' }).waitFor();
  await page.goto(`/app/${f.org.id}/inventory/${stock.position.id}`);
  await page.getByRole('link', { name: '#100', exact: true }).click();
  await page.waitForURL(`**/orders/${stock.orderId}*`);
  expect(errors).toEqual([]);
});

/* global document */
import { expect, test } from './browser-fixtures.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { transfersFixture } from './shopify-transfers-fixture.mjs';

test('investigates exact transfer and receiving evidence in light, dark and narrow layouts', async ({
  resources: t,
}) => {
  const port = await availablePort(),
    origin = `http://127.0.0.1:${port}`;
  const { f, item, mutations } = await transfersFixture(t, origin);
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
    viewport: { width: 1280, height: 900 },
  });
  await context.addCookies(
    f.owner.cookie.split('; ').map((value) => {
      const [name, ...rest] = value.split('=');

      return { name, value: rest.join('='), url: origin };
    }),
  );
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/app/${f.org.id}/inventory`);
  await page.getByRole('button', { name: 'Transfers', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Transfers and receiving' }),
  ).toBeVisible();
  const link = page.getByRole('link', {
    name: 'Move to retired depot',
    exact: true,
  });
  await link.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Historical location snapshots' }),
  ).toBeVisible();
  await expect(page.getByText('Retired depot', { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      'Live location identity unavailable. The historical name does not establish a stock pool.',
    ),
  ).toBeVisible();
  await page.screenshot({
    path: '/tmp/luma-218-transfer-light.png',
    fullPage: true,
  });
  await page
    .getByRole('link', { name: 'Receiving shipment', exact: true })
    .click();
  await expect(
    page
      .getByText(
        'Receipt remains unconfirmed after the estimated arrival. This does not establish physical loss.',
      )
      .first(),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(
    page.getByRole('heading', { name: 'Exact source lines' }),
  ).toBeVisible();
  const exportButton = page.getByRole('button', {
    name: 'Download receiving evidence',
  });
  await exportButton.scrollIntoViewIfNeeded();
  await exportButton.focus();
  const download = page.waitForEvent('download');
  await page.keyboard.press('Enter');
  expect((await download).suggestedFilename()).toMatch(/^receiving-.*\.json$/);
  const history = page
    .locator('summary')
    .filter({ hasText: 'Observed history' });
  await history.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('table', { name: 'Observed history' }),
  ).toBeVisible();
  await page.screenshot({
    path: '/tmp/luma-218-shipment-dark-mobile.png',
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  expect(mutations).toHaveLength(0);
  expect(item.connectionId).toBeTruthy();
});

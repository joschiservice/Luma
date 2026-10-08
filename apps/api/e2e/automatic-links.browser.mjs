/* global document */
import { automaticLinksFixture } from './automatic-links-fixture.mjs';
import { expect, test } from './browser-fixtures.mjs';
import { availablePort, startProcess } from './helpers.mjs';

test('previews and enables SKU and order rules, disables linking and keeps narrow layouts accessible', async ({
  resources: t,
}) => {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const f = await automaticLinksFixture(t, origin);
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
    f.owner.cookie.split('; ').map((value) => {
      const [name, ...rest] = value.split('=');

      return { name, value: rest.join('='), url: origin };
    }),
  );
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/app/${f.org.id}/sync`);
  await page.getByRole('button', { name: 'Add linking rule' }).click();
  await page.getByRole('combobox', { name: 'Link to connection' }).click();
  await page.getByRole('option', { name: 'Tokyo store' }).click();
  await page.getByRole('combobox', { name: 'Other connection' }).click();
  await page.getByRole('option', { name: 'JTL-Wawi' }).click();
  expect(
    await page
      .getByRole('button', { name: 'Enable automatic linking' })
      .count(),
  ).toBe(0);
  await page.getByRole('button', { name: 'Preview matches' }).click();
  await expect(
    page.getByText('1 match can be linked', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('auto-1', { exact: true })).toBeVisible();
  await page.screenshot({
    path: '/tmp/luma140-auto-link-preview-light.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Enable automatic linking' }).click();
  await expect(
    page.getByText('Unique SKU code', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Disable', exact: true }).click();
  await expect(page.getByText('Disabled', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add linking rule' }).click();
  await page.getByRole('combobox', { name: 'Record type' }).click();
  await page
    .getByRole('option', { name: 'Orders: JTL reference to Shopify' })
    .click();
  await page.getByRole('combobox', { name: 'Shopify store' }).click();
  await page.getByRole('option', { name: 'Tokyo store' }).click();
  await page.getByRole('combobox', { name: 'JTL connection' }).click();
  await page.getByRole('option', { name: 'JTL-Wawi' }).click();
  await page.getByRole('button', { name: 'Preview matches' }).click();
  await expect(
    page.getByText('Waiting for both connections', { exact: false }),
  ).toBeVisible();
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.screenshot({
    path: '/tmp/luma140-auto-link-preview-dark.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Preview matches' }).focus();
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('button', { name: 'Enable automatic linking' }),
  ).toBeFocused();
  expect(
    await page
      .getByRole('dialog')
      .evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth),
  ).toBe(true);
  await page.screenshot({
    path: '/tmp/luma140-auto-link-preview-mobile.png',
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.getByRole('button', { name: 'Enable automatic linking' }).click();
  await expect(
    page.getByText('JTL order reference', { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

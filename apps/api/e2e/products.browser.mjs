/* global document */
import { expect, test } from './browser-fixtures.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { productsFixture } from './products-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

test('finds a SKU, compares its store and ERP listings and follows affected orders and stock', async ({
  resources: t,
}) => {
  const port = await availablePort(),
    origin = `http://127.0.0.1:${port}`;
  const f = await settingsFixture(t, origin);
  const catalog = await productsFixture(t, f);
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

  // An order line leads to the product and back.
  await page.goto(`/app/${f.org.id}/orders/${catalog.soldOrderId}`);
  await page.getByRole('link', { name: 'Product and stock' }).first().click();
  await page
    .getByRole('heading', { name: 'Same SKU. Different listings.' })
    .waitFor();
  const comparison = page.getByRole('table', {
    name: 'Listing comparison by source',
  });
  const text = await comparison.innerText();
  expect(text).toContain('Tokyo store');
  expect(text).toContain('JTL-Wawi');
  expect(text).toContain('Canvas tote bag');
  expect(text).toContain('26.00, currency not reported');
  await page.getByRole('link', { name: '#101', exact: true }).waitFor();
  await page
    .getByRole('img', { name: /Tokyo store: 3 units in 1 order/ })
    .waitFor();
  await page.screenshot({
    path: '/tmp/luma101-detail-light.png',
    fullPage: true,
  });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.screenshot({
    path: '/tmp/luma101-detail-dark.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: '/tmp/luma101-detail-mobile.png',
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
  await page.getByRole('link', { name: 'Back to context' }).click();
  await page.waitForURL(`**/orders/${catalog.soldOrderId}*`);

  // The catalog finds missing listings and unlinked matches, and keeps filters.
  await page.goto(`/app/${f.org.id}/products`);
  await page.getByRole('heading', { name: 'Products', exact: true }).waitFor();
  await page.getByRole('link', { name: 'SKU-100', exact: true }).waitFor();
  await page.screenshot({
    path: '/tmp/luma101-list-light.png',
    fullPage: true,
  });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.screenshot({ path: '/tmp/luma101-list-dark.png', fullPage: true });
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  await page.getByRole('tab', { name: /Not in every source/ }).click();
  await page.getByRole('button', { name: 'Add Missing from filter' }).click();
  await page.getByRole('button', { name: 'JTL-Wawi', exact: true }).click();
  await page
    .getByRole('button', { name: 'Edit Missing from filter: JTL-Wawi' })
    .waitFor();
  await page.getByRole('link', { name: 'APR-M', exact: true }).waitFor();
  expect(
    await page.getByRole('link', { name: 'SKU-100', exact: true }).count(),
  ).toBe(0);
  await page
    .getByRole('link', { name: 'Same code, not linked: GIFT-BOX' })
    .click();
  await page.getByRole('link', { name: 'Compare gift-box' }).waitFor();
  await page.getByRole('link', { name: 'Back to products' }).click();
  const url = new URL(page.url());
  expect(url.searchParams.get('view')).toBe('missing');
  expect(url.searchParams.get('missingFrom')).toBe(catalog.erp);
  await page
    .getByRole('searchbox', { name: 'Search products' })
    .fill('nothing');
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'No products match' }).waitFor();

  // Stock detail leads to the product, and the product leads to inventory.
  await page.goto(`/app/${f.org.id}/inventory/${catalog.position.id}`);
  await page
    .getByRole('link', { name: 'Product listings for this SKU' })
    .click();
  await page.getByRole('link', { name: 'Open in Inventory' }).click();
  await page.waitForURL(`**/inventory?skuId=*`);
  expect(errors).toEqual([]);
});

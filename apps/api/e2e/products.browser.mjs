/* global document */
import { createObservability } from '@luma/platform/composition';

import { expect, rememberedView, test } from './browser-fixtures.mjs';
import { productsFixture } from './products-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

test('finds a SKU, compares its store and ERP listings and follows affected orders and stock', async ({
  resources: t,
  web,
}) => {
  const origin = web.origin;
  // Saved views are behind a release flag.
  const observability = createObservability({
    environment: 'test',
    release: 'test',
    sampleRate: 0,
    featureFlagOverrides: { 'adaptive-saved-views': true },
  });
  const f = await settingsFixture(t, origin, { observability });
  const catalog = await productsFixture(t, f);
  const apiOrigin = await f.app.listen({ host: '127.0.0.1', port: 0 });
  await web.route(apiOrigin);
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
  // The line's item name opens its product.
  await page
    .getByRole('table', { name: /^Lines reported by / })
    .getByRole('link')
    .first()
    .click();
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
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('link', { name: 'Back to previous page' }).click();
  await page.waitForURL(`**/orders/${catalog.soldOrderId}*`);

  // The catalog finds missing listings and unlinked matches, and keeps filters.
  await page.goto(`/app/${f.org.id}/products`);
  await page.getByRole('heading', { name: 'Products', exact: true }).waitFor();
  await page.getByRole('link', { name: 'SKU-100', exact: true }).waitFor();
  await page.getByRole('tab', { name: /Not in every source/ }).click();
  await page.waitForURL((url) => url.searchParams.get('view') === 'missing');

  // A "Missing from" link from before views becomes the same condition.
  await page.goto(
    `/app/${f.org.id}/products?view=missing&missingFrom=${catalog.erp}`,
  );
  await page.waitForURL((url) => url.searchParams.has('where'));
  expect(new URL(page.url()).searchParams.has('missingFrom')).toBe(false);
  expect(JSON.parse(new URL(page.url()).searchParams.get('where'))).toEqual({
    match: 'all',
    conditions: [{ field: 'missing', op: 'any_of', value: [catalog.erp] }],
  });
  await page.getByRole('link', { name: 'APR-M', exact: true }).waitFor();
  expect(
    await page.getByRole('link', { name: 'SKU-100', exact: true }).count(),
  ).toBe(0);
  await page
    .getByRole('link', { name: 'Same code, not linked: GIFT-BOX' })
    .click();
  await page.getByRole('link', { name: 'Compare gift-box' }).waitFor();
  await page
    .getByRole('navigation', { name: 'Breadcrumb' })
    .getByRole('link', { name: 'Products' })
    .click();
  await page.getByRole('link', { name: 'APR-M', exact: true }).waitFor();
  const url = new URL(page.url());
  expect(url.searchParams.get('view')).toBe('missing');
  expect(url.searchParams.get('where')).toContain(catalog.erp);
  await page
    .getByRole('searchbox', { name: 'Search products' })
    .fill('nothing');
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'No products match' }).waitFor();

  // A per-source condition, a sort and a grouping become a personal view that opens again.
  await page.goto(`/app/${f.org.id}/products?view=all`);
  await page.getByRole('link', { name: 'APR-M', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Add a filter' }).click();
  const picker = page.getByRole('dialog', { name: 'Add a filter' });
  await picker.getByRole('searchbox', { name: 'Find a field' }).fill('Vendor');
  await picker.getByRole('button', { name: 'Vendor', exact: true }).click();
  const vendor = page.getByRole('dialog', { name: 'Vendor' });
  await vendor.getByRole('combobox', { name: 'Condition' }).click();
  await page.getByRole('option', { name: 'is not empty' }).click();
  await vendor.getByRole('button', { name: 'Apply filter' }).click();
  await page.getByRole('button', { name: /^Edit filter: Vendor/ }).waitFor();
  await expect(
    page.getByRole('link', { name: 'APR-M', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('link', { name: 'SKU-100', exact: true }).waitFor();
  const skuHeader = page.getByRole('columnheader', { name: /^SKU/ }).first();
  await skuHeader.getByRole('button', { name: 'SKU', exact: true }).click();
  await expect(skuHeader).toHaveAttribute('aria-sort', 'ascending');
  expect(new URL(page.url()).searchParams.get('sort')).toBe('sku');
  await page.getByRole('button', { name: 'Display' }).click();
  await page.getByRole('combobox', { name: 'Group by' }).click();
  await page.getByRole('option', { name: 'Status', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Active/ }).waitFor();
  const remembered = rememberedView(page, 'products');
  await page.getByRole('button', { name: 'Save as new view' }).click();
  const save = page.getByRole('dialog', { name: 'Save as new view' });
  await save.getByLabel('Name').fill('Vendor listings');
  await save.getByRole('button', { name: 'Save', exact: true }).click();
  await page
    .getByRole('tab', { name: 'Vendor listings', exact: true, selected: true })
    .waitFor();
  await page.waitForURL((url) =>
    /^[0-9a-f-]{36}$/.test(url.searchParams.get('view') ?? ''),
  );
  const viewId = new URL(page.url()).searchParams.get('view');
  expect(await remembered).toBe(viewId);
  await page.goto(`/app/${f.org.id}/products`);
  await page.waitForURL((link) => link.searchParams.get('view') === viewId);
  await page.getByRole('button', { name: /^Edit filter: Vendor/ }).waitFor();
  await page.getByRole('button', { name: /^Active/ }).waitFor();

  // Stock detail leads to the product, and the product leads to inventory.
  await page.goto(`/app/${f.org.id}/inventory/${catalog.position.id}`);
  await page
    .getByRole('link', { name: 'Product listings for this SKU' })
    .click();
  await page.getByRole('link', { name: 'Open in Inventory' }).click();
  await page.waitForURL(`**/inventory?skuId=*`);
  expect(errors).toEqual([]);
});

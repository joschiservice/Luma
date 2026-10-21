/* global document */
import { createObservability } from '@luma/platform/composition';

import { expect, rememberedView, test } from './browser-fixtures.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { inventoryFixture } from './inventory-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

test('investigates stock differences, follows affected orders and preserves filters', async ({
  resources: t,
}) => {
  const port = await availablePort(),
    origin = `http://127.0.0.1:${port}`;
  // Saved views are behind a release flag.
  const observability = createObservability({
    environment: 'test',
    release: 'test',
    sampleRate: 0,
    featureFlagOverrides: { 'adaptive-saved-views': true },
  });
  const f = await settingsFixture(t, origin, { observability });
  const stock = await inventoryFixture(t, f);
  await stock.stock({
    onHand: '3',
    reserved: '1',
    amount: '-2',
    states: {
      committed: '5',
      incoming: '7',
      damaged: '0',
      qualityControl: '2',
      safetyStock: '3',
      locationActive: true,
      itemActive: false,
      tracked: true,
      inventorySemantics: 'shopify/1',
    },
  });
  // The same SKU at a second warehouse, for grouping one product across locations.
  await stock.stock({ location: 'Osaka', amount: '5' });
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
  // Built-in views are tabs.
  await page.getByRole('tab', { name: 'Source differences' }).click();
  await page.waitForURL((url) => url.searchParams.get('view') === 'differs');
  const search = page.getByRole('searchbox', { name: 'Search inventory' });
  await search.fill('77');
  await search.press('Enter');
  await page.waitForURL((url) => url.searchParams.get('q') === '"77"');
  // The previous rows stay until the view's rows arrive: only Tokyo's sources differ.
  await expect(
    page.getByRole('link', { name: 'SKU-100', exact: true }),
  ).toHaveCount(1);
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
  const disclosure = page
    .locator('summary')
    .filter({ hasText: 'Unavailable stock and activation' });
  await disclosure.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('table', { name: 'Unavailable stock and activation' }),
  ).toBeVisible();
  await expect(
    page.getByRole('columnheader', { name: 'Committed', exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole('table', { name: 'Unavailable stock and activation' }),
  ).toContainText('No');
  await page.setViewportSize({ width: 390, height: 844 });
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

  // A sort, a grouping by SKU and a condition on the lowest source become a view that opens again.
  await page.goto(`/app/${f.org.id}/inventory?view=all`);
  const skuLinks = page.getByRole('link', { name: 'SKU-100', exact: true });
  await expect(skuLinks).toHaveCount(2);
  const available = page
    .getByRole('columnheader', { name: /^Available/ })
    .first();
  await available
    .getByRole('button', { name: 'Available', exact: true })
    .click();
  await expect(available).toHaveAttribute('aria-sort', 'ascending');
  expect(new URL(page.url()).searchParams.get('sort')).toBe('available');
  await page.getByRole('button', { name: 'Display' }).click();
  await page.getByRole('combobox', { name: 'Group by' }).click();
  await page.getByRole('option', { name: 'SKU', exact: true }).click();
  await page.keyboard.press('Escape');
  // One product across warehouses.
  await page.getByRole('button', { name: /^SKU-100/ }).waitFor();
  await expect(skuLinks).toHaveCount(2);
  await page.getByRole('button', { name: 'Add a filter' }).click();
  const picker = page.getByRole('dialog', { name: 'Add a filter' });
  await picker
    .getByRole('searchbox', { name: 'Find a field' })
    .fill('Available');
  await picker.getByRole('button', { name: 'Available', exact: true }).click();
  const condition = page.getByRole('dialog', { name: 'Available' });
  await condition.getByRole('combobox', { name: 'Condition' }).click();
  await page.getByRole('option', { name: 'is less than' }).click();
  await condition.getByRole('combobox', { name: 'Source' }).click();
  await page.getByRole('option', { name: 'Lowest across sources' }).click();
  await condition.getByLabel('Value').fill('0');
  await condition.getByRole('button', { name: 'Apply filter' }).click();
  await page.getByRole('button', { name: /^Edit filter: Available/ }).waitFor();
  await expect(skuLinks).toHaveCount(1);
  expect(JSON.parse(new URL(page.url()).searchParams.get('where'))).toEqual({
    match: 'all',
    conditions: [{ field: 'available', op: 'lt', value: 0, source: 'lowest' }],
  });
  const remembered = rememberedView(page, 'inventory');
  await page.getByRole('button', { name: 'Save as new view' }).click();
  const save = page.getByRole('dialog', { name: 'Save as new view' });
  await save.getByLabel('Name').fill('Oversold by SKU');
  await save.getByRole('button', { name: 'Save', exact: true }).click();
  await page
    .getByRole('tab', { name: 'Oversold by SKU', exact: true, selected: true })
    .waitFor();
  await page.waitForURL((url) =>
    /^[0-9a-f-]{36}$/.test(url.searchParams.get('view') ?? ''),
  );
  const viewId = new URL(page.url()).searchParams.get('view');
  expect(await remembered).toBe(viewId);
  await page.goto(`/app/${f.org.id}/inventory`);
  await page.waitForURL((url) => url.searchParams.get('view') === viewId);
  await page.getByRole('button', { name: /^Edit filter: Available/ }).waitFor();
  await page.getByRole('button', { name: /^SKU-100/ }).waitFor();
  await expect(skuLinks).toHaveCount(1);

  // Transfers keep their own view, conditions and paging.
  await page.getByRole('button', { name: 'Transfers', exact: true }).click();
  await page
    .getByRole('heading', { name: 'Transfers and receiving', level: 1 })
    .waitFor();
  await page
    .getByRole('heading', { name: 'No transfers or shipments in this view' })
    .waitFor();
  expect(errors).toEqual([]);
});

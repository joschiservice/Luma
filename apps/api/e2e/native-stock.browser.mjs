/* global document */
import { createObservability } from '@luma/platform/composition';

import { expect, test } from './browser-fixtures.mjs';
import { nativeStockFixture } from './native-stock-fixture.mjs';

test('allocates and releases native stock through operator controls in light, dark and narrow layouts', async ({
  resources: t,
  web,
}) => {
  const origin = web.origin;
  const observability = createObservability({
    environment: 'test',
    release: 'test',
    sampleRate: 0,
    featureFlagOverrides: { 'luma-erp-orders': true },
  });
  const f = await nativeStockFixture(t, { origin, observability });
  const apiOrigin = await f.f.app.listen({ host: '127.0.0.1', port: 0 });
  await web.route(apiOrigin);
  const context = await t.newContext({
    baseURL: origin,
    viewport: { width: 1280, height: 900 },
  });
  await context.addCookies(
    f.f.owner.cookie.split('; ').map((value) => {
      const [name, ...rest] = value.split('=');

      return { name, value: rest.join('='), url: origin };
    }),
  );
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(
    `/app/${f.owner.tenantId}/inventory/${f.snapshot.document.entityId}`,
  );
  await expect(
    page.getByRole('heading', { name: 'Native stock', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', {
      name: 'Read stock source independently',
      exact: true,
    })
    .click();
  const stock = page.getByRole('table', { name: 'Native stock', exact: true });
  await expect(stock).toContainText('12');
  await page.goto(`/app/${f.owner.tenantId}/orders/${f.orderId}`);
  const section = page.getByRole('region', {
    name: 'Stock reservations',
    exact: true,
  });
  // Nothing is reserved yet, so the section is its header with a badge and its actions.
  await expect(section.getByRole('heading', { name: /None$/ })).toBeVisible();
  const actions = section.getByRole('button', {
    name: 'Stock reservation actions',
  });
  // The shipment read and reservation work by keyboard alone.
  await actions.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('menuitem', { name: 'Read shipments independently' }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(
    page.getByText(
      'Fresh shipment read retained. Preparation does not dispatch stock.',
      { exact: false },
    ),
  ).toBeVisible();
  await actions.click();
  await page.getByRole('menuitem', { name: 'Reserve stock…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Reserve stock' });
  await dialog
    .getByRole('combobox', { name: 'Order line', exact: true })
    .click();
  await page.getByRole('option').filter({ hasText: 'LUMA-001' }).click();
  await dialog
    .getByRole('combobox', { name: 'Stock location', exact: true })
    .click();
  await page
    .getByRole('option', { name: 'Main warehouse', exact: true })
    .click();
  await dialog
    .getByRole('textbox', { name: 'Quantity', exact: true })
    .fill('3.125001');
  await dialog
    .getByRole('button', { name: 'Reserve stock', exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  const reservations = section.getByRole('table', {
    name: 'Stock held for this order, by line and location',
  });
  await expect(reservations).toContainText('3.125001');
  await expect(
    page.getByText('Unallocated demand: 0.874999', { exact: true }),
  ).toBeVisible();
  await reservations
    .getByRole('button', { name: 'Actions for LUMA-001', exact: true })
    .click();
  await page
    .getByRole('menuitem', { name: 'Release remaining hold', exact: true })
    .click();
  await expect(reservations).toContainText('Released');
  await expect(
    reservations.getByRole('button', { name: 'Actions for LUMA-001' }),
  ).toHaveCount(0);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(section.getByRole('heading', { level: 2 })).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth + 1,
    ),
  ).toBe(true);
  await page.goto(
    `/app/${f.owner.tenantId}/inventory/${f.snapshot.document.entityId}`,
  );
  await expect(
    page.getByRole('table', { name: 'Native stock', exact: true }),
  ).toContainText('12');
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth + 1,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  expect(f.mutations).toHaveLength(0);
});

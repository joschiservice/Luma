/* global document */
import { createObservability } from '@luma/platform/composition';

import { expect, test } from './browser-fixtures.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { nativeStockFixture } from './native-stock-fixture.mjs';

test('allocates and releases native stock through operator controls in light, dark and narrow layouts', async ({
  resources: t,
}) => {
  const port = await availablePort(),
    origin = `http://127.0.0.1:${port}`;
  const observability = createObservability({
    environment: 'test',
    release: 'test',
    sampleRate: 0,
    featureFlagOverrides: { 'luma-erp-orders': true },
  });
  const f = await nativeStockFixture(t, { origin, observability });
  const apiOrigin = await f.f.app.listen({ host: '127.0.0.1', port: 0 });
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
  await expect(
    page.getByRole('heading', {
      name: 'Native order reservations',
      exact: true,
    }),
  ).toBeVisible();
  const read = page.getByRole('button', {
    name: 'Read shipments independently',
    exact: true,
  });
  await read.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByText(
      'Fresh shipment read retained. Preparation does not dispatch stock.',
      { exact: false },
    ),
  ).toBeVisible();
  await page.getByRole('combobox', { name: 'Order line', exact: true }).click();
  await page.getByRole('option').filter({ hasText: 'LUMA-001' }).click();
  await page
    .getByRole('combobox', { name: 'Stock location', exact: true })
    .click();
  await page
    .getByRole('option', { name: 'Main warehouse', exact: true })
    .click();
  await page
    .getByRole('textbox', { name: 'Quantity', exact: true })
    .fill('3.125001');
  await page
    .getByRole('button', { name: 'Reserve stock', exact: true })
    .click();
  const reservations = page.getByRole('table', {
    name: 'Native order reservations',
    exact: true,
  });
  await expect(reservations).toContainText('3.125001');
  await expect(
    page.getByText('Unallocated demand: 0.874999', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Release remaining hold', exact: true })
    .click();
  await expect(reservations).toContainText('3.125001');
  await expect(
    page.getByRole('button', { name: 'Release remaining hold', exact: true }),
  ).toHaveCount(0);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole('heading', {
      name: 'Native order reservations',
      exact: true,
    }),
  ).toBeVisible();
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

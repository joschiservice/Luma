import { createObservability } from '@luma/platform/composition';

import { expect, test } from './browser-fixtures.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { ordersFixture } from './orders-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

test('authors reviewed live views and business fields with search, history and responsive keyboard access', async ({
  resources: t,
}) => {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const observability = createObservability({
    environment: 'test',
    release: 'test',
    sampleRate: 0,
    featureFlagOverrides: {
      'adaptive-custom-fields': true,
      'adaptive-saved-views': true,
      'adaptive-view-generation': false,
      'adaptive-view-actions': true,
      'adaptive-operational-packages': true,
    },
  });
  const f = await settingsFixture(t, origin, { observability });
  const orders = await ordersFixture(t, f);
  const recordId = await orders.order({
    external: 'gid://shopify/Order/adaptive',
    key: 'adaptive-browser-order',
    updatedAt: new Date().toISOString(),
    data: {
      displayNumber: '#ADAPTIVE',
      total: { amount: '20', currency: 'EUR' },
    },
    lines: [
      { external: 'adaptive-line', skuCode: 'ADAPTIVE-SKU', quantity: '2' },
    ],
  });
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
    f.owner.cookie.split('; ').map((cookie) => {
      const [name, ...value] = cookie.split('=');

      return { name, value: value.join('='), url: origin };
    }),
  );
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto(`/app/${f.org.id}/views/fields`);
  await page.getByRole('button', { name: 'Create field', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Stable key').fill('buyer_note');
  await dialog.getByLabel('English label').fill('Buyer note');
  await dialog.getByLabel('German label').fill('Einkaufsnotiz');
  await dialog
    .getByRole('button', { name: 'Save custom fields', exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole('rowheader', { name: 'Buyer note', exact: true }),
  ).toBeVisible();
  await page.goto(`/app/${f.org.id}/orders/${recordId}`);
  await page
    .getByLabel('Buyer note', { exact: true })
    .fill('Priority shipment');
  await page
    .getByRole('button', { name: 'Save custom fields', exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (
          await f.request(
            f.owner,
            `${f.base}/adaptive/fields/records/order/${recordId}`,
          )
        ).values[0]?.value,
    )
    .toBe('Priority shipment');

  await page.goto(`/app/${f.org.id}/views`);
  await page
    .getByRole('button', { name: 'Create view', exact: true })
    .first()
    .click();
  await page.getByLabel('Name', { exact: true }).fill('Priority orders');
  await page
    .getByLabel('Description', { exact: true })
    .fill('Orders with a buyer note.');
  await page.getByLabel('Buyer note', { exact: true }).check();
  await page
    .getByRole('button', { name: 'Preview records', exact: true })
    .click();
  await expect(
    page.getByRole('link', { name: '#ADAPTIVE', exact: true }),
  ).toBeVisible();
  const sharing = page.getByRole('combobox', { name: 'Sharing', exact: true });
  await sharing.click();
  await page.getByRole('option', { name: 'Workspace', exact: true }).click();
  await page.getByLabel('I reviewed the fields, filters and sharing.').check();
  await page
    .getByRole('button', { name: 'Save reviewed view', exact: true })
    .click();
  await expect(page).toHaveURL(/\/views\/[0-9a-f-]+\?manage=true$/);
  await expect(
    page.getByText('Priority shipment', { exact: true }),
  ).toBeVisible();
  const saved = (
    await f.request(f.owner, `${f.base}/adaptive/views`)
  ).items.find((item) => item.name === 'Priority orders');
  expect(saved.sharing.scope).toBe('workspace');
  expect(
    saved.query.state.columns.some((column) => column.id.startsWith('custom:')),
  ).toBe(true);
  await page
    .getByRole('button', { name: 'Version history', exact: true })
    .click();
  await expect(
    page.getByRole('dialog').getByText('Version 1', { exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Edit view', exact: true }).click();
  await page
    .getByLabel('Name', { exact: true })
    .fill('Priority orders — reviewed');
  await page
    .getByRole('button', { name: 'Preview records', exact: true })
    .click();
  await page.getByLabel('I reviewed the fields, filters and sharing.').check();
  await page
    .getByRole('button', { name: 'Save reviewed view', exact: true })
    .click();
  await expect(page.getByText('Version 2', { exact: true })).toBeVisible();
  await page.keyboard.press('Control+k');
  await page.getByRole('dialog').getByRole('textbox').fill('Priority orders');
  await expect(
    page
      .getByRole('dialog')
      .getByRole('link', { name: /Priority orders — reviewed/ }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await page.screenshot({
    path: '/tmp/luma-adaptive-view-light.png',
    fullPage: true,
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({
    path: '/tmp/luma-adaptive-view-dark.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole('link', { name: '#ADAPTIVE', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).toBeVisible();
  await page.screenshot({
    path: '/tmp/luma-adaptive-view-narrow.png',
    fullPage: true,
  });
  expect(errors).toEqual([]);

  // Shared metadata never grants writes or cross-tenant record access.
  await f.request(f.member, `${f.base}/adaptive/views/${saved.id}`);
  await f.request(
    f.member,
    `${f.base}/adaptive/fields/records/order/${recordId}`,
    'PUT',
    { values: [] },
    403,
  );
  await f.request(
    f.outsider,
    `${f.base}/adaptive/views/${saved.id}`,
    'GET',
    undefined,
    404,
  );
});

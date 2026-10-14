/* global document */
import { expect, test } from './browser-fixtures.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { procurementFixture } from './procurement-fixture.mjs';

test('creates, reviews and lists procurement records with saved views and safe retries on desktop and mobile', async ({
  resources: t,
}) => {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const f = await procurementFixture(t, origin, {
    FEATURE_FLAG_OVERRIDES: 'adaptive-saved-views=true',
  });
  const web = startProcess(
    t,
    'e2e/web-server.mjs',
    { TEST_API_ORIGIN: f.api.origin, TEST_WEB_PORT: String(port) },
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
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/app/${f.org.id}/procurement`);
  await page.getByRole('heading', { name: 'No purchase orders yet' }).waitFor();
  await page
    .getByRole('button', { name: 'Add your first supplier', exact: true })
    .click();
  await page.getByLabel('Supplier name').fill('Northstar Supply');
  await page.getByText('External reference', { exact: false }).last().click();
  await page.getByLabel('System', { exact: true }).fill('JTL');
  await page.getByLabel('External ID', { exact: true }).fill('SUP-42');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Add supplier', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'New purchase order', exact: true })
    .waitFor();
  await page
    .getByRole('button', { name: 'New purchase order', exact: true })
    .click();
  await page.getByLabel('Order reference').fill('PO-2026-001');
  await page.getByLabel('SKU 1', { exact: true }).fill('TOTE-NAT');
  await page
    .getByLabel('Description 1', { exact: true })
    .fill('Organic cotton tote · Natural');
  await page.getByLabel('Quantity 1', { exact: true }).fill('120');
  await page.getByRole('button', { name: 'Add line', exact: true }).click();
  await page.getByLabel('SKU 2', { exact: true }).fill('TOTE-BLK');
  await page
    .getByLabel('Description 2', { exact: true })
    .fill('Organic cotton tote · Black');
  await page.getByLabel('Quantity 2', { exact: true }).fill('80');
  // Simulate a committed write whose response is lost. Retry must reuse the request.
  await page.route(
    '**/procurement/purchase-orders',
    async (route) => {
      if (route.request().method() === 'POST') {
        await route.fetch();
        await route.abort('failed');
      } else await route.continue();
    },
    { times: 1 },
  );
  await page.getByRole('button', { name: 'Create draft', exact: true }).click();
  await page.getByRole('button', { name: 'Retry save', exact: true }).waitFor();
  expect(await page.getByLabel('Order reference').isDisabled()).toBe(true);
  await page.getByRole('button', { name: 'Retry save', exact: true }).click();
  await page
    .getByRole('heading', { name: 'PO-2026-001', exact: true })
    .waitFor();
  expect(
    (
      await f.api.request(`${f.root}/purchase-orders`, {
        cookie: f.owner.cookie,
      })
    ).body.items,
  ).toHaveLength(1);
  await page.getByRole('button', { name: 'Mark as open', exact: true }).click();
  await page
    .getByLabel('Reason', { exact: true })
    .fill('Supplier and quantities reviewed for autumn replenishment.');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Mark as open', exact: true })
    .click();
  await page.getByText('Draft → Open', { exact: true }).waitFor();
  const detailUrl = page.url();
  await page.screenshot({
    path: '/tmp/luma69-order-desktop.png',
    fullPage: true,
  });
  await page.reload();
  await page.getByText('Draft → Open', { exact: true }).waitFor();
  await page
    .getByRole('navigation', { name: 'Breadcrumb' })
    .getByRole('link', { name: 'Procurement' })
    .click();
  await page.getByRole('link', { name: /PO-2026-001/ }).waitFor();
  await page.screenshot({
    path: '/tmp/luma69-list-desktop.png',
    fullPage: true,
  });
  await page
    .getByRole('searchbox', { name: 'Search purchase orders' })
    .fill('missing');
  await page
    .getByRole('heading', { name: 'No matching purchase orders' })
    .waitFor();
  await page
    .getByRole('button', { name: 'Clear filters', exact: true })
    .click();
  await page.getByRole('link', { name: /PO-2026-001/ }).waitFor();
  const param = (name) => new URL(page.url()).searchParams.get(name);
  // The overview's counts open built-in views; pressing one again returns to all orders.
  // An open order that was never sent is still a draft to the supplier.
  await page
    .getByRole('button', { name: 'Show draft purchase orders', exact: true })
    .click();
  await page.waitForURL((url) => url.searchParams.get('view') === 'draft');
  await page.getByRole('link', { name: /PO-2026-001/ }).waitFor();
  const waiting = page.getByRole('button', {
    name: 'Show orders waiting for the supplier to confirm',
    exact: true,
  });
  await waiting.click();
  await page.waitForURL(
    (url) => url.searchParams.get('view') === 'awaiting_confirmation',
  );
  await page
    .getByRole('heading', { name: 'No matching purchase orders' })
    .waitFor();
  await expect(waiting).toHaveAttribute('aria-pressed', 'true');
  await waiting.click();
  await page.waitForURL((url) => url.searchParams.get('view') === 'all');
  await page.getByRole('link', { name: /PO-2026-001/ }).waitFor();
  // A supplier condition is kept as a personal view and comes back when the page reopens.
  await page
    .getByRole('button', { name: 'Add Supplier filter', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: 'Supplier' })
    .getByRole('button', { name: 'Northstar Supply', exact: true })
    .click();
  await page.keyboard.press('Escape');
  await expect
    .poll(() => JSON.parse(param('where') ?? '{}').conditions?.[0]?.field)
    .toBe('supplier');
  await page.getByRole('link', { name: /PO-2026-001/ }).waitFor();
  await page.getByRole('button', { name: 'Save as new view' }).click();
  const save = page.getByRole('dialog', { name: 'Save as new view' });
  await save.getByLabel('Name').fill('Northstar orders');
  await save.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForURL((url) =>
    /^[0-9a-f-]{36}$/.test(url.searchParams.get('view') ?? ''),
  );
  const viewId = param('view');
  await expect
    .poll(
      async () =>
        (
          await f.api.request(
            `/v1/organizations/${f.org.id}/collections/procurement/state`,
            { cookie: f.owner.cookie },
          )
        ).body.state?.view,
    )
    .toBe(viewId);
  await page.goto(`/app/${f.org.id}/procurement`);
  await page.waitForURL((url) => url.searchParams.get('view') === viewId);
  await page
    .getByRole('button', {
      name: 'Edit Supplier filter: Northstar Supply',
      exact: true,
    })
    .waitFor();
  await page.getByRole('link', { name: /PO-2026-001/ }).waitFor();
  // Older links that named a stage open the same orders as conditions or built-in views.
  await page.goto(`/app/${f.org.id}/procurement?view=orders&stage=attention`);
  await page.waitForURL((url) => url.searchParams.get('view') === 'attention');
  await page.getByRole('tab', { name: /Suppliers 1/ }).click();
  await page
    .getByRole('rowheader', { name: 'Northstar Supply', exact: true })
    .waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: '/tmp/luma69-suppliers-mobile.png',
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.goto(detailUrl);
  await page
    .getByRole('heading', { name: 'PO-2026-001', exact: true })
    .waitFor();
  await page.screenshot({
    path: '/tmp/luma69-order-mobile.png',
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.getByRole('button', { name: 'Cancel order', exact: true }).click();
  await page
    .getByLabel('Reason', { exact: true })
    .fill('Replenishment no longer required.');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Cancel order', exact: true })
    .click();
  await page.getByText('Open → Canceled', { exact: true }).waitFor();
  expect(
    await page
      .getByRole('button', { name: 'Mark as open', exact: true })
      .count(),
  ).toBe(0);
  await page.goto(`/app/${f.org.id}/activity?type=procurement`);
  await page
    .getByText('Purchase order status changed', { exact: true })
    .first()
    .click();
  await page
    .getByRole('link', { name: 'Open purchase order', exact: true })
    .click();
  await page
    .getByRole('heading', { name: 'PO-2026-001', exact: true })
    .waitFor();
  expect(errors).toEqual([]);
});

/* global document, window */
import { performanceReport } from '../../../tooling/performance/report.mjs';
import { expect, test } from './browser-fixtures.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { ordersFixture } from './orders-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

test('finds an order by number or SKU, explains it and pages a historical import', async ({
  resources: t,
}) => {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const fixture = await settingsFixture(t, origin);
  const orders = await ordersFixture(t, fixture);
  const now = Date.now();
  const tote = await orders.order({
    external: 'gid://shopify/Order/2001',
    key: 'order-2001',
    updatedAt: new Date(now - 60_000).toISOString(),
    data: {
      displayNumber: '#2001',
      placedAt: '2026-09-01T09:00:00Z',
      total: { amount: '48.00', currency: 'EUR' },
    },
    lines: [
      {
        external: 'line-1',
        sku: 'gid://shopify/InventoryItem/31',
        skuKey: 'tote',
        skuCode: 'TOTE-RED',
        title: 'Canvas tote',
        quantity: '2',
        currentQuantity: '1',
        cancelledQuantity: '1',
      },
    ],
  });
  await orders.order({
    connectionId: orders.erp,
    external: '2001',
    key: 'order-2001',
    updatedAt: new Date(now - 3_600_000).toISOString(),
    data: {
      displayNumber: 'SO-2001',
      paymentStatus: 'pending',
      total: { amount: '48', currency: 'EUR' },
    },
    lines: [
      {
        external: '1',
        sku: '77',
        skuKey: 'tote',
        skuCode: 'TOTE-RED',
        quantity: '2',
      },
    ],
  });
  const mug = await orders.order({
    external: 'gid://shopify/Order/2002',
    key: 'order-2002',
    updatedAt: new Date(now - 120_000).toISOString(),
    data: { displayNumber: '#2002', status: 'completed' },
    lines: [
      { external: 'line-2', skuCode: 'MUG-BLUE', title: 'Mug', quantity: '1' },
    ],
  });
  await orders.order({
    external: 'gid://shopify/Order/2003',
    key: 'order-2003',
    updatedAt: new Date(now - 180_000).toISOString(),
    data: { displayNumber: '#2003', dueAt: '2026-01-01T00:00:00Z' },
    lines: [
      {
        external: 'line-3',
        skuCode: 'POSTER-A2',
        title: 'Poster',
        quantity: '3',
      },
    ],
  });
  await orders.importHistory(mug, 150);
  const orderPage = await fixture.request(
    fixture.member,
    `${fixture.base}/orders?limit=50`,
  );
  expect(orderPage.items).toHaveLength(50);
  await performanceReport(
    'orders-page',
    {
      datasetOrders: 153,
      pageItems: orderPage.items.length,
      payloadBytes: Buffer.byteLength(JSON.stringify(orderPage)),
    },
    { pageItems: 50, payloadBytes: 128 * 1024 },
  );

  const listed = await fixture.request(
    fixture.member,
    `${fixture.base}/orders?q=tote-red`,
  );
  expect(listed.totalCount).toBeNull();
  expect(listed.items.map((item) => item.id)).toEqual([tote]);
  await fixture.request(
    fixture.outsider,
    `${fixture.base}/orders`,
    'GET',
    undefined,
    404,
  );
  await fixture.request(
    fixture.outsider,
    `${fixture.base}/orders/${tote}`,
    'GET',
    undefined,
    404,
  );

  const apiOrigin = await fixture.app.listen({ host: '127.0.0.1', port: 0 });
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
    fixture.member.cookie.split('; ').map((value) => {
      const [name, ...rest] = value.split('=');

      return { name, value: rest.join('='), url: origin };
    }),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const url = message.location().url;
    // The settings fixture omits app catalog and connection services used by the shell.
    if (url.endsWith(`${fixture.base}/apps`) && message.text().includes('500'))
      return;
    if (
      url.endsWith(`${fixture.base}/connections`) &&
      message.text().includes('503')
    )
      return;
    errors.push(`${url}: ${message.text()}`);
  });

  // The G then O shortcut opens Orders from anywhere in the workspace.
  await page.goto(`/app/${fixture.org.id}/home`);
  await page.locator('main').first().waitFor();
  await page.keyboard.press('g');
  await page.keyboard.press('o');
  await page.getByRole('heading', { name: 'Orders', exact: true }).waitFor();
  const orderRange = page
    .getByRole('navigation', { name: 'Order pages' })
    .getByRole('status');
  await expect(orderRange).toHaveText('1–50');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(orderRange).toHaveText('51–100');
  await page
    .getByRole('navigation', { name: 'Order pages' })
    .screenshot({ path: '/tmp/luma116-order-pagination.png' });
  expect(new URL(page.url()).searchParams.get('page')).toBe('2');
  await page.getByRole('button', { name: 'Previous' }).click();
  await expect(orderRange).toHaveText('1–50');

  await page.getByRole('tab', { name: 'Overdue', exact: true }).click();
  await expect(orderRange).toHaveText('1–1');
  await page.getByRole('link', { name: '#2003' }).waitFor();
  await page.getByRole('tab', { name: 'All orders' }).click();

  await page.getByRole('button', { name: 'Add Status filter' }).click();
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await page
    .getByRole('button', { name: 'Edit Status filter: Open' })
    .waitFor();
  await page.waitForURL((url) => url.searchParams.get('status') === 'open');
  await page
    .getByRole('button', { name: 'Remove Status filter: Open' })
    .click();
  await page.waitForURL((url) => !url.searchParams.has('status'));

  await page.getByRole('searchbox', { name: 'Search orders' }).fill('TOTE-red');
  await page.keyboard.press('Enter');
  await expect(orderRange).toHaveText('1–1');
  await page.getByRole('link', { name: '#2001' }).click();
  await page.getByRole('heading', { name: '#2001', level: 1 }).waitFor();
  await page.getByRole('heading', { name: 'Current state' }).waitFor();
  await page
    .getByText(
      'Payment differs between sources: “Paid” in Tokyo store and “Payment pending” in JTL-Wawi.',
    )
    .waitFor();
  await page.getByRole('cell', { name: '2', exact: true }).first().waitFor();
  await page.getByText('Canvas tote').first().waitFor();
  await expect(
    page.getByRole('columnheader', { name: 'Current', exact: true }),
  ).toBeVisible();
  const editedLine = page
    .getByRole('row')
    .filter({ hasText: 'Canvas tote' })
    .first();
  await expect(editedLine.getByRole('cell').nth(0)).toHaveText('1');
  await expect(editedLine.getByRole('cell').nth(1)).toHaveText('2');
  await expect(editedLine.getByRole('cell').nth(2)).toHaveText('1');
  const comparisonTable = page.getByRole('table').filter({
    has: page.getByRole('columnheader', { name: 'Field', exact: true }),
  });
  const comparisonHeaders = await comparisonTable
    .getByRole('columnheader')
    .allTextContents();
  const comparedItems = comparisonTable
    .getByRole('row')
    .filter({ hasText: 'Order items' });
  for (const [source, quantity] of [
    ['Tokyo store', '1 × TOTE-RED'],
    ['JTL-Wawi', '2 × TOTE-RED'],
  ])
    await expect(
      comparedItems
        .getByRole('cell')
        .nth(comparisonHeaders.indexOf(source) - 1),
    ).toHaveText(quantity);
  const detailUrl = page.url();
  await page.screenshot({
    path: '/tmp/luma98-order-desktop.png',
    fullPage: true,
  });

  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.screenshot({
    path: '/tmp/luma170-order-dark.png',
    fullPage: true,
  });

  // Deep links reload into the same order and filters.
  await page.reload();
  await page.getByRole('heading', { name: '#2001', level: 1 }).waitFor();
  expect(page.url()).toBe(detailUrl);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: '/tmp/luma98-order-mobile.png',
    fullPage: true,
  });
  await page
    .getByRole('navigation', { name: 'Breadcrumb' })
    .getByRole('link', { name: 'Orders' })
    .click();
  await page.getByRole('heading', { name: 'Orders', exact: true }).waitFor();
  expect(
    await page.getByRole('searchbox', { name: 'Search orders' }).inputValue(),
  ).toBe('TOTE-red');
  await page.getByRole('link', { name: '#2001' }).waitFor();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/app/${fixture.org.id}/orders?sort=number&direction=asc`);
  await expect(orderRange).toHaveText('1–50');
  expect(
    await page
      .getByRole('columnheader', { name: /Order/ })
      .first()
      .getAttribute('aria-sort'),
  ).toBe('ascending');
  await page.getByRole('link', { name: '#2001' }).waitFor();
  await page.screenshot({ path: '/tmp/luma98-orders-desktop.png' });
  expect(errors).toEqual([]);
});

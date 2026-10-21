/* global document, window */
import { createObservability } from '@luma/platform/composition';

import { performanceReport } from '../../../tooling/performance/report.mjs';
import { expect, rememberedView, test } from './browser-fixtures.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { ordersFixture } from './orders-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

test('finds an order by number or SKU, explains it, pages a historical import and keeps list views', async ({
  resources: t,
}) => {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const observability = createObservability({
    environment: 'test',
    release: 'test',
    sampleRate: 0,
    featureFlagOverrides: { 'adaptive-saved-views': true },
  });
  const fixture = await settingsFixture(t, origin, { observability });
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
  expect(
    await fixture.request(fixture.owner, `${fixture.base}/sales/availability`),
  ).toEqual({ enabled: false });
  await fixture.request(
    fixture.owner,
    `${fixture.base}/sales/orders/${tote}/accept`,
    'POST',
    { connectionId: orders.store },
    404,
  );
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
    // The stale view save below is refused on purpose.
    if (url.includes('/adaptive/views/') && message.text().includes('409'))
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

  // Built-in views are tabs.
  await page.getByRole('tab', { name: 'Overdue', exact: true }).click();
  await expect(orderRange).toHaveText('1–1');
  await page.getByRole('link', { name: '#2003' }).waitFor();
  await page.getByRole('tab', { name: 'All orders', exact: true }).click();
  await page.waitForURL((url) => url.searchParams.get('view') === 'all');

  await page.getByRole('searchbox', { name: 'Search orders' }).fill('TOTE-red');
  await page.keyboard.press('Enter');
  await expect(orderRange).toHaveText('1–1');
  // Search can match customer names, so it stays out of the address.
  expect(new URL(page.url()).searchParams.has('q')).toBe(false);
  await page.getByRole('link', { name: '#2001' }).click();
  await page.getByRole('heading', { name: '#2001', level: 1 }).waitFor();
  await page.getByRole('region', { name: 'Current state' }).waitFor();
  await page
    .getByText(
      'The comparison needs fresh, complete reads and unambiguous line mappings. Unknown values do not prove a difference.',
    )
    .first()
    .waitFor();
  await page.getByText('Canvas tote').first().waitFor();
  await expect(
    page.getByRole('columnheader', { name: 'Quantity', exact: true }),
  ).toBeVisible();
  const editedLine = page
    .getByRole('row')
    .filter({ hasText: 'Canvas tote' })
    .first();
  // One current unit, with the two ordered and one reduced beneath it.
  const editedQuantity = editedLine
    .getByRole('cell')
    .filter({ hasText: '2 ordered' });
  await expect(
    editedQuantity.locator('.order-line-quantity > span').first(),
  ).toHaveText('1');
  await expect(editedQuantity).toContainText('1 reduced');
  // The comparison is inconclusive, so no fact is listed as differing until all are shown.
  await page.getByRole('button', { name: /^Show all \d+ facts$/ }).click();
  const comparisonTable = page.getByRole('table', {
    name: 'Facts reported by each source',
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
  // The search stayed on the page it was typed on; the view came back from the address.
  expect(
    await page.getByRole('searchbox', { name: 'Search orders' }).inputValue(),
  ).toBe('');
  expect(new URL(page.url()).searchParams.get('view')).toBe('all');
  await page.getByRole('link', { name: '#2001' }).waitFor();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  await page.setViewportSize({ width: 1280, height: 900 });
  // A link's search, such as a product's orders, is adopted and leaves the address.
  await page.goto(`/app/${fixture.org.id}/orders?q=tote-red`);
  await page.waitForURL((url) => !url.searchParams.has('q'));
  expect(new URL(page.url()).searchParams.get('view')).toBe('all');
  expect(
    await page.getByRole('searchbox', { name: 'Search orders' }).inputValue(),
  ).toBe('tote-red');
  await expect(orderRange).toHaveText('1–1');

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

  // Filter with the condition builder, sort, and keep it as a personal view.
  await page.goto(`/app/${fixture.org.id}/orders?view=all`);
  await expect(orderRange).toHaveText('1–50');
  await page.getByRole('button', { name: 'Add a filter' }).click();
  const picker = page.getByRole('dialog', { name: 'Add a filter' });
  await picker.getByRole('searchbox', { name: 'Find a field' }).fill('Tota');
  await picker.getByRole('button', { name: 'Total', exact: true }).click();
  const placed = page.getByRole('dialog', { name: 'Total' });
  await placed.getByRole('combobox', { name: 'Condition' }).click();
  await page.getByRole('option', { name: 'is not empty' }).click();
  await placed.getByRole('button', { name: 'Apply filter' }).click();
  await page
    .getByRole('button', { name: 'Edit filter: Total is not empty' })
    .waitFor();
  await expect(orderRange).toHaveText('1–1');
  await page.getByRole('link', { name: '#2001' }).waitFor();
  const numberHeader = page
    .getByRole('columnheader', { name: /Order/ })
    .first();
  await numberHeader
    .getByRole('button', { name: 'Order', exact: true })
    .click();
  await expect(numberHeader).toHaveAttribute('aria-sort', 'descending');
  await page.getByText('Modified', { exact: true }).waitFor();
  const remembered = rememberedView(page, 'orders');
  await page.getByRole('button', { name: 'Save as new view' }).click();
  const save = page.getByRole('dialog', { name: 'Save as new view' });
  await save.getByLabel('Name').fill('Placed orders');
  await save.getByRole('button', { name: 'Save', exact: true }).click();
  await page
    .getByRole('tab', { name: 'Placed orders', exact: true, selected: true })
    .waitFor();
  await page.waitForURL((url) =>
    /^[0-9a-f-]{36}$/.test(url.searchParams.get('view') ?? ''),
  );
  const viewId = new URL(page.url()).searchParams.get('view');
  await page.screenshot({ path: '/tmp/luma286-orders-saved-view.png' });

  // Opening Orders without a view returns to the remembered one.
  expect(await remembered).toBe(viewId);
  await page.goto(`/app/${fixture.org.id}/orders`);
  await page.waitForURL((url) => url.searchParams.get('view') === viewId);
  await page
    .getByRole('button', { name: 'Edit filter: Total is not empty' })
    .waitFor();
  await expect(orderRange).toHaveText('1–1');

  // A stale save is refused, and the member chooses what to keep.
  await numberHeader
    .getByRole('button', { name: 'Order', exact: true })
    .click();
  await page.getByText('Modified', { exact: true }).waitFor();
  const saved = await fixture.request(
    fixture.member,
    `${fixture.base}/adaptive/views/${viewId}`,
  );
  await fixture.request(
    fixture.member,
    `${fixture.base}/adaptive/views/${viewId}`,
    'PUT',
    {
      commandId: crypto.randomUUID(),
      name: 'Placed orders (renamed)',
      description: saved.description,
      sharing: saved.sharing,
      query: saved.query,
      reviewed: true,
      expectedRevision: saved.revision,
    },
  );
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page
    .getByText('Someone else saved this view after you opened it.')
    .waitFor();
  await page
    .getByRole('button', { name: 'Discard mine and load theirs' })
    .click();
  await page
    .getByRole('tab', {
      name: 'Placed orders (renamed)',
      exact: true,
      selected: true,
    })
    .waitFor();

  // Resetting the page opens the default view and can be undone.
  await page.getByRole('button', { name: 'View options' }).click();
  await page.getByRole('menuitem', { name: 'Reset page to default' }).click();
  await page
    .getByRole('tab', { name: 'All orders', exact: true, selected: true })
    .waitFor();
  await page.getByRole('button', { name: 'Undo' }).click();
  await page
    .getByRole('tab', {
      name: 'Placed orders (renamed)',
      exact: true,
      selected: true,
    })
    .waitFor();

  // List keys move through rows, and ? lists them.
  await page
    .locator('main')
    .first()
    .click({ position: { x: 4, y: 4 } });
  await page.keyboard.press('j');
  await expect(page.getByRole('link', { name: '#2001' })).toBeFocused();
  await page.keyboard.press('?');
  await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).waitFor();
  await page.keyboard.press('Escape');

  // Links from before views, such as Insights drill-downs, become conditions.
  await page.goto(`/app/${fixture.org.id}/orders?status=completed`);
  await page.waitForURL((url) => !url.searchParams.has('status'));
  expect(JSON.parse(new URL(page.url()).searchParams.get('where'))).toEqual({
    match: 'all',
    conditions: [{ field: 'status', op: 'any_of', value: ['completed'] }],
  });
  await page
    .getByRole('button', { name: 'Edit Status filter: Completed' })
    .waitFor();
  expect(errors).toEqual([]);
});

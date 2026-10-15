/* global document */
import { expect, test } from './browser-fixtures.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { ordersFixture } from './orders-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

test('reviews imported order sources, links them, follows an old URL and unlinks', async ({
  resources: t,
}) => {
  const port = await availablePort(),
    origin = `http://127.0.0.1:${port}`;
  const f = await settingsFixture(t, origin);
  const records = await ordersFixture(t, f);
  const a = await records.order({
    external: 'gid://shopify/Order/1001',
    imported: true,
    data: {
      displayNumber: '#1001',
      placedAt: '2026-09-01T09:00:00Z',
      total: { amount: '48.00', currency: 'EUR' },
    },
    lines: [
      {
        external: 'line-1',
        quantity: '2',
        skuCode: 'TOTE-RED',
        title: 'Canvas tote',
      },
    ],
  });
  const b = await records.order({
    connectionId: records.erp,
    external: '10',
    imported: true,
    data: {
      displayNumber: 'SO-10',
      externalOrderNumber: '#1001',
      placedAt: '2026-09-01T09:05:00Z',
      total: { amount: '48', currency: 'EUR' },
      paymentStatus: 'pending',
    },
    lines: [
      {
        external: '101',
        quantity: '2',
        skuCode: 'TOTE-RED',
        title: 'Canvas tote',
      },
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
    f.owner.cookie.split('; ').map((value) => {
      const [name, ...rest] = value.split('=');

      return { name, value: rest.join('='), url: origin };
    }),
  );
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/app/${f.org.id}/orders/${a}`);
  const panel = page.getByRole('dialog', { name: 'Linked sources' });
  const openLinks = async () => {
    await page.getByRole('button', { name: 'More order actions' }).click();
    await page.getByRole('menuitem', { name: 'Linked sources' }).click();
    await expect(panel).toBeVisible();
  };
  // The order's side panel points to the suggested link.
  await expect(
    page.getByText('Luma found 1 possible match in another source.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Review matches' }).click();
  await expect(
    panel.getByRole('heading', { name: 'Possibly the same order' }),
  ).toBeVisible();
  await expect(
    panel.getByText('Matching source order reference', {
      exact: false,
    }),
  ).toBeVisible();
  await panel.getByRole('button', { name: 'Link', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /^(Link|Unlink) / });
  await expect(
    dialog.getByRole('button', { name: 'Link records' }),
  ).toBeDisabled();
  await expect(dialog.getByText('External order number: #1001')).toBeVisible();
  await dialog
    .getByLabel('Why is this correct?')
    .fill('Checked the Shopify reference, dates and totals');
  await dialog.getByRole('button', { name: 'Link records' }).click();
  await expect(
    panel.getByText('Linking records.', { exact: false }),
  ).toBeVisible();
  await records.applyLinks();
  await expect(
    panel.getByRole('button', { name: 'Unlink', exact: true }),
  ).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Source comparison', exact: true }),
  ).toBeVisible();
  const listed = await f.request(f.owner, `${f.base}/orders?q=SO-10`);
  expect(listed.items.map((item) => item.id)).toEqual([a]);
  await page.screenshot({
    path: '/tmp/luma117-order-linked-light.png',
    fullPage: true,
  });
  await page.goto(`/app/${f.org.id}/orders/${b}`);
  await expect(page).toHaveURL(new RegExp(`/orders/${a}`));
  await expect(
    page.getByText('This order was linked to another source.', {
      exact: false,
    }),
  ).toBeVisible();
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await openLinks();
  await panel.screenshot({ path: '/tmp/luma117-order-linked-dark-mobile.png' });
  await panel
    .locator('li')
    .filter({ has: page.getByText('JTL-Wawi', { exact: true }) })
    .getByRole('button', { name: 'Unlink', exact: true })
    .click();
  await dialog
    .getByLabel('Why is this correct?')
    .fill('Separate source order confirmed');
  await dialog.getByRole('button', { name: 'Unlink source' }).click();
  await expect(
    panel.getByText('Unlinking records.', { exact: false }),
  ).toBeVisible();
  await records.applyLinks();
  await expect(
    panel.getByRole('button', { name: 'Unlink', exact: true }),
  ).toHaveCount(0);
  expect((await f.request(f.owner, `${f.base}/orders`)).items).toHaveLength(2);
  await page.goto(`/app/${f.org.id}/orders/${b}`);
  await expect(
    page.getByRole('heading', { name: 'SO-10', exact: true }),
  ).toBeVisible();
  await openLinks();
  await panel.getByLabel('Find another order').fill('#1001');
  await panel.getByRole('button', { name: 'Review link' }).click();
  await expect(dialog.getByText('Shopify ID 1001')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  // Members can inspect sources, but cannot link or unlink.
  await context.clearCookies();
  await context.addCookies(
    f.member.cookie.split('; ').map((value) => {
      const [name, ...rest] = value.split('=');

      return { name, value: rest.join('='), url: origin };
    }),
  );
  await page.reload();
  await openLinks();
  await expect(
    panel.getByRole('heading', { name: 'Possibly the same order' }),
  ).toBeVisible();
  await expect(
    panel.getByRole('button', { name: 'Link', exact: true }),
  ).toHaveCount(0);
  await expect(panel.getByLabel('Find another order')).toHaveCount(0);
  expect(errors).toEqual([]);
});

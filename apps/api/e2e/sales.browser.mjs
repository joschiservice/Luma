import { randomUUID } from 'node:crypto';

import { createObservability } from '@luma/platform/composition';

import { expect, test } from './browser-fixtures.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { ordersFixture } from './orders-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

test('accepts and edits a Luma order with explicit authority in both themes and narrow layouts', async ({
  resources: t,
}) => {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const observability = createObservability({
    environment: 'test',
    release: 'test',
    sampleRate: 0,
    featureFlagOverrides: { 'luma-erp-orders': true },
  });
  const f = await settingsFixture(t, origin, { observability });
  const orders = await ordersFixture(t, f);
  const id = await orders.order({
    external: 'gid://shopify/Order/176',
    key: 'native-176',
    updatedAt: new Date().toISOString(),
    data: { displayNumber: '#176', total: { amount: '20', currency: 'EUR' } },
    lines: [
      {
        external: '176-line',
        skuCode: 'MUG-176',
        quantity: '2',
        currentQuantity: '2',
        cancelledQuantity: '0',
      },
    ],
  });
  await f.request(
    f.member,
    `${f.base}/sales/orders/${id}/accept`,
    'POST',
    { connectionId: orders.store },
    403,
  );
  await f.request(
    f.outsider,
    `${f.base}/sales/orders/${id}/accept`,
    'POST',
    { connectionId: orders.store },
    404,
  );
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
    viewport: { width: 1280, height: 900 },
  });
  await context.addCookies(
    f.owner.cookie.split('; ').map((value) => {
      const [name, ...rest] = value.split('=');

      return { name, value: rest.join('='), url: origin };
    }),
  );
  const page = await context.newPage();
  await page.goto(`/app/${f.org.id}/orders/${id}`);
  await page
    .getByRole('button', { name: 'Accept into Luma', exact: true })
    .click();
  await expect(
    page.getByText(
      'Choose Luma ERP for order lines and lifecycle in workspace source authority before editing.',
    ),
  ).toBeVisible();
  const record = await f.request(f.owner, `${f.base}/sales/orders/${id}`);
  const listed = await f.request(f.owner, `${f.base}/orders?q=176`);
  expect(listed.items).toHaveLength(1);
  expect(listed.items[0].sources.map((source) => source.system).sort()).toEqual(
    ['luma-erp', 'shopify'],
  );
  for (const group of ['order_lifecycle', 'order_lines']) {
    const authority = await f.request(f.owner, `${f.base}/source-authority`);
    await f.request(f.owner, `${f.base}/source-authority`, 'POST', {
      commandId: randomUUID(),
      revision: authority.revision,
      group,
      connectionId: record.connectionId,
    });
  }
  await page.reload();
  const form = page.locator('section[aria-label="Luma order record"]');
  await expect(form.getByRole('button', { name: 'Save order' })).toBeEnabled();
  await form.getByLabel('MUG-176 · Current quantity').fill('1');
  await form.getByText('Shipping address', { exact: true }).first().click();
  const shipping = form.getByRole('group', { name: 'Shipping address' });
  await shipping.getByLabel('Street', { exact: true }).fill('Example street');
  await shipping.getByLabel('Country code').fill('DE');
  await form.getByRole('button', { name: 'Save order' }).click();
  await expect(form.getByLabel('MUG-176 · Current quantity')).toHaveValue('1');
  await expect
    .poll(
      async () =>
        (await f.request(f.owner, `${f.base}/sales/orders/${id}`)).version,
    )
    .toBe(2);
  const edited = await f.request(f.owner, `${f.base}/sales/orders/${id}`);
  expect(edited.total).toBeNull();
  expect(edited.shippingAddress.street).toBe('Example street');
  const detail = await f.request(f.owner, `${f.base}/orders/${id}`);
  expect(
    detail.sources.find((source) => source.system === 'luma-erp').lines[0]
      .currentQuantity,
  ).toBe('1');
  expect(
    detail.differences.some((difference) =>
      difference.values.some(
        (value) => value.connectionId === record.connectionId,
      ),
    ),
  ).toBe(true);
  await expect(
    page.getByText('Pending propagation', { exact: true }).first(),
  ).toBeVisible();
  await page.screenshot({
    path: '/tmp/luma176-sales-light.png',
    fullPage: true,
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({
    path: '/tmp/luma176-sales-dark.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(form.getByRole('button', { name: 'Save order' })).toBeVisible();
  await page.screenshot({
    path: '/tmp/luma176-sales-narrow.png',
    fullPage: true,
  });
});

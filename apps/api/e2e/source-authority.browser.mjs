import { randomUUID } from 'node:crypto';

import { expect, test } from './browser-fixtures.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { ordersFixture } from './orders-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

test('reviews source authority, safely retries an override and resolves each order fact from its chosen source', async ({
  resources: t,
}) => {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const f = await settingsFixture(t, origin);
  const orders = await ordersFixture(t, f);
  const id = await orders.order({
    external: 'shop-171',
    key: 'authority-order',
    updatedAt: '2026-10-01T10:00:00Z',
    data: { displayNumber: '#171' },
    lines: [{ external: 'shop-line', quantity: '2' }],
  });
  await orders.order({
    connectionId: orders.erp,
    external: 'erp-171',
    key: 'authority-order',
    updatedAt: '2026-10-02T10:00:00Z',
    data: { displayNumber: 'SO-171' },
    lines: [{ external: 'erp-line', quantity: '7' }],
  });
  const path = `${f.base}/source-authority`;
  const initial = await f.request(f.owner, path);
  expect(
    initial.groups.find((group) => group.group === 'order_lines').connectionId,
  ).toBe(orders.store);
  expect(
    initial.groups.find((group) => group.group === 'order_fulfillment')
      .connectionId,
  ).toBe(orders.erp);
  await f.request(
    f.member,
    path,
    'POST',
    {
      commandId: randomUUID(),
      revision: 0,
      group: 'order_lines',
      connectionId: orders.erp,
    },
    403,
  );
  await f.request(f.outsider, path, 'GET', undefined, 404);
  const before = await f.request(f.owner, `${f.base}/orders/${id}`);
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
  await page.goto(`/app/${f.org.id}/settings/authority`);
  await page
    .getByRole('heading', { name: 'Source authority', exact: true })
    .waitFor();
  const input = page.getByRole('combobox', {
    name: 'Order lines and quantities',
  });
  await input.fill('JTL');
  await page.getByRole('option', { name: 'JTL-Wawi', exact: true }).click();
  await page.route(
    '**/source-authority',
    async (route) => {
      if (route.request().method() === 'POST') {
        await route.fetch();
        await route.abort('failed');
      } else await route.continue();
    },
    { times: 1 },
  );
  const row = page
    .getByRole('row')
    .filter({ hasText: 'Order lines and quantities' });
  await row.getByRole('button', { name: 'Save', exact: true }).click();
  await page
    .getByRole('button', { name: 'Check status and retry', exact: true })
    .click();
  await expect(row).toContainText('JTL-Wawi (override)');
  await expect(page.getByText('Changes saved.', { exact: true })).toBeVisible();
  const history = await f.request(f.owner, `${path}/history`);
  expect(history.items).toHaveLength(1);
  expect(history.items[0]).toMatchObject({
    actorId: f.owner.id,
    previousConnectionId: null,
    connectionId: orders.erp,
  });
  const after = await f.request(f.owner, `${f.base}/orders/${id}`);
  expect(after.sources).toEqual(before.sources);
  expect(after.authority.lines).toMatchObject({
    connectionId: orders.erp,
    lines: [{ quantity: '7' }],
  });
  await page.screenshot({
    path: '/tmp/luma171-authority-desktop.png',
    fullPage: true,
  });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.screenshot({
    path: '/tmp/luma171-authority-dark.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(input).toBeVisible();
  await page.screenshot({
    path: '/tmp/luma171-authority-narrow.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/app/${f.org.id}/orders/${id}`);
  const comparison = page.getByRole('table', {
    name: 'Facts reported by each source',
  });
  await expect(
    comparison.getByRole('columnheader', { name: 'Authoritative source' }),
  ).toBeVisible();
  await expect(
    comparison.getByRole('row').filter({ hasText: 'Ordered items' }),
  ).toContainText('JTL-Wawi (override)');
  await page.screenshot({
    path: '/tmp/luma171-order-authority.png',
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

import { expect, test } from './browser-fixtures.mjs';
import { orderEditFixture } from './shopify-order-edits-fixture.mjs';

test('changes a Shopify order quantity through approval and verifies it with a fresh read', async ({
  resources: t,
  web,
}) => {
  const origin = web.origin;
  const fixture = await orderEditFixture(t, origin);
  const { f, admin, installed } = fixture;
  const order = await fixture.order();
  const apiOrigin = await f.app.listen({ host: '127.0.0.1', port: 0 });
  await web.route(apiOrigin);
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
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // The live record browser only frames the order; the edit itself reads the simulator.
  await page.route('**/apps/shopify/records', (route) =>
    route.fulfill({
      json: {
        tenantId: f.org.id,
        connectionId: installed.id,
        shop: 'edits.myshopify.com',
        kind: 'Order',
        id: order.gid,
        observedAt: new Date().toISOString(),
        apiVersion: '2026-07',
        nextCursor: null,
        sections: [],
      },
    }),
  );
  await page.goto(`/app/${f.org.id}/apps/shopify`);
  await page.getByText('Find by Shopify ID', { exact: true }).click();
  await page.getByLabel('Record type').selectOption('Order');
  await page.getByLabel('Shopify record ID').fill(order.gid);
  await page.getByRole('button', { name: 'Load record', exact: true }).click();
  await page.getByRole('button', { name: 'Change quantities…' }).click();
  const tote = page.getByRole('spinbutton', {
    name: 'New quantity for Canvas tote - Natural',
  });
  await tote.fill('1');
  await page.getByRole('button', { name: 'Preview change' }).click();
  await expect(
    page.getByText('Canvas tote - Natural: 3 → 1', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('table', { name: 'Order totals' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Send to Shopify' }),
  ).toHaveCount(0);
  expect(fixture.commits()).toBe(0);

  const base = `${f.base}/apps/shopify/order-edit`;
  const inspection = await f.request(admin, `${base}-inspect`, 'POST', {
    connectionId: installed.id,
    orderId: order.gid,
  });
  await f.request(admin, `${base}-approve`, 'POST', {
    id: inspection.runs[0].id,
    outcome: 'approved',
  });
  await page.getByRole('button', { name: 'Check approval' }).click();
  await page.getByRole('button', { name: 'Send to Shopify' }).click();
  await expect(page.getByText('Verified', { exact: true })).toBeVisible();
  expect(fixture.commits()).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(
    page.getByRole('button', { name: 'Review another change' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Review another change' }).click();
  await expect(tote).toHaveAttribute('placeholder', '1');
  expect(errors).toEqual([]);
});

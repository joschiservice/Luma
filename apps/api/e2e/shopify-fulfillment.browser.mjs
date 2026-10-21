import { expect, test } from './browser-fixtures.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { recoveryFixture } from './shopify-fulfillment-fixture.mjs';

test('reviews a held fulfillment, obtains separate approval and verifies progress', async ({
  resources: t,
}) => {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const { f, admin, installed, fulfillment, mutations } = await recoveryFixture(
    t,
    origin,
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
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/apps/shopify/records', (route) =>
    route.fulfill({
      json: {
        tenantId: f.org.id,
        connectionId: installed.id,
        shop: 'recovery.myshopify.com',
        kind: 'FulfillmentOrder',
        id: fulfillment.id,
        observedAt: new Date().toISOString(),
        apiVersion: '2026-07',
        nextCursor: null,
        sections: [
          {
            key: 'fulfillment',
            title: 'Fulfillment order',
            status: 'available',
            requiredScopes: [],
            message: null,
            rows: [
              {
                id: fulfillment.id,
                sourceUpdatedAt: fulfillment.updatedAt,
                fields: { Status: fulfillment.status },
                links: [
                  { kind: 'Order', id: fulfillment.order.id, label: 'Order' },
                ],
              },
            ],
          },
        ],
      },
    }),
  );
  await page.goto(`/app/${f.org.id}/apps/shopify`);
  await page.getByText('Find by Shopify ID', { exact: true }).click();
  await page.getByLabel('Record type').selectOption('FulfillmentOrder');
  await page.getByLabel('Shopify record ID').fill(fulfillment.id);
  await page.getByRole('button', { name: 'Load record', exact: true }).click();
  await page
    .getByRole('button', { name: 'Preview recovery', exact: true })
    .click();
  await expect(
    page.getByText('Release hold 1 only', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Send to Shopify' }),
  ).toHaveCount(0);
  const base = `${f.base}/apps/shopify/fulfillment-recovery`;
  const inspection = await f.request(admin, `${base}-inspect`, 'POST', {
    connectionId: installed.id,
    orderId: fulfillment.order.id,
    fulfillmentOrderId: fulfillment.id,
  });
  await f.request(admin, `${base}-approve`, 'POST', {
    id: inspection.runs[0].id,
    outcome: 'approved',
  });
  await page.getByRole('button', { name: 'Check approval' }).click();
  await page.getByRole('button', { name: 'Send to Shopify' }).click();
  await expect(
    page.getByText('Shopify accepted', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Progress not verified', { exact: true }),
  ).toBeVisible();
  expect(mutations).toHaveLength(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole('button', { name: 'Check fulfillment progress' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Check fulfillment progress' }),
  ).toBeEnabled();
  fulfillment.lineItems.nodes[0].remainingQuantity = 1;
  await page
    .getByRole('button', { name: 'Check fulfillment progress' })
    .click();
  await expect(
    page.getByText('Progress verified', { exact: true }),
  ).toBeVisible();
  expect(mutations).toHaveLength(1);
  await page.getByRole('button', { name: 'Review another action' }).click();
  await expect(page.getByLabel('Hold to release')).toContainText('Other · 2');
  expect(errors).toEqual([]);
});

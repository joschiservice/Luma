/* global document, window */
import { appScopes } from './app-scopes.mjs';
import { expect, test } from './browser-fixtures.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { ordersFixture } from './orders-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

test('opens the source customer from an order, resolves its Luma history and clears revoked or switched context', async ({
  resources: t,
}) => {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const f = await settingsFixture(t, origin);
  await f.db.owner.query(
    `GRANT luma_connectors TO "${new URL(f.db.runtimeUrl).username}"`,
  );
  const source = await ordersFixture(t, f);
  const orderId = await source.order({
    external: 'gid://shopify/Order/2001',
    key: 'customer-order',
    data: { displayNumber: '#2001' },
    lines: [],
  });
  const installed = await f.request(
    f.owner,
    `${f.base}/apps/shopify/install`,
    'POST',
    { version: null, scopes: appScopes.shopify },
  );
  await f.db.owner.query(
    `UPDATE connector_installations SET document=document || $3::jsonb WHERE tenant_id=$1 AND id=$2`,
    [
      f.org.id,
      source.store,
      JSON.stringify({
        appId: 'shopify',
        appInstallationVersion: installed.version,
      }),
    ],
  );
  const mapping = `${f.base}/record-source?${new URLSearchParams({ kind: 'order', connectionId: source.store, externalId: 'gid://shopify/Order/2001' })}`;
  expect(await f.request(f.member, mapping)).toEqual({ ids: [orderId] });
  expect(
    await f.request(f.member, mapping.replace(source.store, source.erp)),
  ).toEqual({ ids: [] });
  await f.request(f.outsider, mapping, 'GET', undefined, 404);
  await f.request(null, mapping, 'GET', undefined, 401);

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
    f.member.cookie.split('; ').map((value) => {
      const [name, ...rest] = value.split('=');

      return { name, value: rest.join('='), url: origin };
    }),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const customerId = 'gid://shopify/Customer/71';
  const timestamp = '2026-09-28T08:00:00Z';
  const row = (id, fields, links = []) => ({
    id,
    fields,
    links,
    sourceUpdatedAt: timestamp,
  });
  const section = (key, title, rows) => ({
    key,
    title,
    rows,
    status: 'available',
    requiredScopes: [],
    message: null,
  });
  let revoked = false;
  const requests = [];
  let hold = false;
  let release;
  let held;
  let responseSent;
  await page.route('**/apps/shopify/record-connections', (route) =>
    route.fulfill({
      json: [
        { id: source.store, label: 'Tokyo store' },
        { id: source.erp, label: 'Second store' },
      ],
    }),
  );
  await page.route('**/apps/shopify/records', async (route) => {
    const input = route.request().postDataJSON();
    requests.push(input);
    if (
      hold &&
      input.kind === 'Customer' &&
      input.connectionId === source.store
    ) {
      await new Promise((resolve) => {
        release = resolve;
        held?.();
      });
      hold = false;
    }
    if (revoked)
      return route.fulfill({ status: 403, json: { code: 'FORBIDDEN' } });
    const contact = row(
      customerId,
      {
        Name: 'Avery Tan',
        Email: 'avery@example.test',
        Phone: '+81 3 1234 5678',
        Orders: '2',
        Spent: '84.00 EUR',
      },
      [{ kind: 'Customer', id: customerId, label: 'Customer' }],
    );
    const order = row('gid://shopify/Order/2001', {
      Name: '#2001',
      Created: timestamp,
      Payment: 'PAID',
      Fulfillment: 'FULFILLED',
      Total: '84.00 EUR',
    });
    const sections =
      input.kind === 'Order'
        ? [
            section('order', 'Order', [order]),
            section('customer', 'Customer', [contact]),
            section('returns', 'Returns', []),
            section('refunds', 'Refunds', [
              row('gid://shopify/Refund/9', { Refunded: '12.00 EUR' }),
            ]),
          ]
        : input.id
          ? [
              section('contact', 'Contact', [contact]),
              section('customer', 'Customer', [contact]),
              section('orders', 'Customer orders', [order]),
            ]
          : [
              section(
                'records',
                'Customers',
                input.connectionId === source.erp
                  ? []
                  : input.search
                    ? [contact, { ...contact, id: 'gid://shopify/Customer/72' }]
                    : [contact],
              ),
            ];

    await route.fulfill({
      json: {
        tenantId: f.org.id,
        connectionId: input.connectionId,
        shop: 'tokyo.myshopify.com',
        kind: input.kind,
        id: input.id ?? '',
        observedAt: timestamp,
        apiVersion: '2026-07',
        sections,
        nextCursor: null,
      },
    });
    responseSent?.();
  });
  await page.goto(`/app/${f.org.id}/orders/${orderId}`);
  await page.getByRole('link', { name: 'Open customer workspace' }).click();
  await page.getByRole('heading', { name: 'Avery Tan' }).waitFor();
  expect(new URL(page.url()).searchParams.get('customerId')).toBe(customerId);
  await page.getByRole('button', { name: '#2001', exact: true }).click();
  await page.getByText('12.00 EUR', { exact: true }).waitFor();
  await page.getByRole('link', { name: 'Open #2001 in Luma' }).waitFor();
  await page.screenshot({
    path: '/tmp/luma100-customer-desktop.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: '/tmp/luma100-customer-mobile.png',
    fullPage: true,
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({
    path: '/tmp/luma100-customer-dark.png',
    fullPage: true,
  });
  revoked = true;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page
    .getByRole('alert')
    .filter({ hasText: 'does not have access' })
    .waitFor();
  expect(
    await page.getByText('avery@example.test', { exact: true }).count(),
  ).toBe(0);
  expect(await page.getByText('12.00 EUR', { exact: true }).count()).toBe(0);
  revoked = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByRole('heading', { name: 'Avery Tan' }).waitFor();
  await page.getByRole('link', { name: 'All customers' }).click();
  await page.getByLabel('Customer name', { exact: true }).fill('Avery');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page
    .getByText('Multiple customer identities match.', { exact: false })
    .waitFor();
  expect(page.url()).not.toContain('Avery');
  expect(requests.some((input) => input.search?.value === 'Avery')).toBe(true);
  await page.getByLabel('Source', { exact: true }).selectOption(source.erp);
  await page.getByRole('heading', { name: 'No customers found' }).waitFor();
  expect(
    await page.getByText('avery@example.test', { exact: true }).count(),
  ).toBe(0);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByLabel('Source', { exact: true }).selectOption(source.store);
  await page.getByRole('link', { name: 'Avery Tan', exact: true }).waitFor();
  await page.screenshot({
    path: '/tmp/luma100-customers-list.png',
    fullPage: true,
  });
  await page.getByLabel('Source', { exact: true }).selectOption(source.erp);
  await page.getByRole('heading', { name: 'No customers found' }).waitFor();
  hold = true;
  const waiting = new Promise((resolve) => {
    held = resolve;
  });
  await page.getByLabel('Source', { exact: true }).selectOption(source.store);
  await waiting;
  await page.getByLabel('Source', { exact: true }).selectOption(source.erp);
  await page.getByRole('heading', { name: 'No customers found' }).waitFor();
  const completed = new Promise((resolve) => {
    responseSent = resolve;
  });
  release();
  await completed;
  expect(
    await page.getByText('avery@example.test', { exact: true }).count(),
  ).toBe(0);
  const other = await f.request(
    f.owner,
    '/v1/organizations',
    'POST',
    { name: 'Other workspace', slug: `customer-other-${Date.now()}` },
    201,
  );
  await f.request(
    f.owner,
    `/v1/organizations/${other.id}/members`,
    'POST',
    { userId: f.member.id, roleId: 'member' },
    201,
  );
  await page.goto(`/app/${other.id}/customers`);
  await page
    .getByRole('heading', { name: 'Connect a customer source' })
    .waitFor();
  expect(
    await page.getByText('avery@example.test', { exact: true }).count(),
  ).toBe(0);
  await page.goto(`/app/${f.org.id}/customers`);
  await page.getByRole('link', { name: 'Avery Tan', exact: true }).waitFor();
  await context.clearCookies();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForURL('**/sign-in**');
  expect(
    await page.getByText('avery@example.test', { exact: true }).count(),
  ).toBe(0);
  expect(errors).toEqual([]);
});

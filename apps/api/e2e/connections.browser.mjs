/* global document, innerWidth, getComputedStyle */
import { readdirSync } from 'node:fs';

import { expect, test } from './browser-fixtures.mjs';
import {
  availablePort,
  createAccount,
  database,
  startApi,
  startProcess,
} from './helpers.mjs';

let origin;
// The web build names each workspace app's lazy UI chunk after the app.
const appChunk = new RegExp(
  `/assets/app-(${readdirSync(new URL('../../../packages/apps/', import.meta.url)).join('|')})-`,
);

async function fixture(t) {
  const port = await availablePort();
  origin = `http://127.0.0.1:${port}`;
  const db = await database(t);
  await db.migrate();
  await db.grantRuntime();
  const role = new URL(db.runtimeUrl).username;
  await db.owner.query(`GRANT luma_connectors TO "${role}"`);
  const api = await startApi(t, db, origin, 'e2e/connections-server.mjs');
  const web = startProcess(
    t,
    'e2e/web-server.mjs',
    { TEST_API_ORIGIN: api.origin, TEST_WEB_PORT: String(port) },
    true,
  );
  await web.message('listening');
  const context = await t.newContext({
    baseURL: origin,
    viewport: { width: 1440, height: 1100 },
  });
  const page = await context.newPage();
  const errors = [];
  const appModules = [];
  page.on('request', (request) => {
    const app = appChunk.exec(request.url())?.[1];
    if (app) appModules.push(app);
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(15_000);
  await createAccount(page, db, {
    name: 'Ada',
    email: 'ada@example.test',
    password: 'browser-test-password-123',
  });
  await page.getByLabel('Workspace name').fill('North Studio');
  await page
    .getByRole('button', { name: 'Create workspace', exact: true })
    .click();
  await page.getByRole('heading', { name: 'Needs you' }).waitFor();
  const organizationId = new URL(page.url()).pathname.split('/')[2];
  await page.getByRole('link', { name: 'Manage apps', exact: true }).click();
  await page.getByText('No apps installed yet.', { exact: false }).waitFor();
  expect(appModules).toEqual([]);

  return { db, api, page, context, organizationId, errors, appModules };
}

async function setup(page, provider, label, token = 'valid-test-token') {
  const install = page.getByRole('button', {
    name: 'Install JTL',
    exact: true,
  });
  if (await install.count()) {
    await install.click();
    // Installing asks for consent to the access the app requests.
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Install JTL', exact: true })
      .click();
  }
  await page
    .getByRole('button', { name: 'Add connection', exact: true })
    .click();
  if (provider === 'JTL-Wawi on-premise')
    await page.getByLabel('Connection type').selectOption('jtl-onprem');
  await page.getByLabel('Connection name').fill(label);
  await page.getByLabel('Access token', { exact: true }).fill(token);

  return page.getByRole('dialog');
}

async function save(page, label) {
  await page
    .getByRole('button', { name: 'Save connection', exact: true })
    .click();
  const card = page.getByRole('article', { name: label, exact: true });
  await card.getByText('Importing', { exact: true }).waitFor();

  return card;
}

test('connects JTL targets, validates, replaces invalid credentials and disconnects', async ({
  resources: t,
}) => {
  const { page, context, db, errors, organizationId, appModules } =
    await fixture(t);
  expect(await page.title()).toBe('Luma');
  await setup(page, 'JTL Cloud', 'Main shop', 'invalid-test-token');
  expect(appModules).toContain('jtl');
  expect(appModules).not.toContain('shopify');
  await page
    .getByLabel('JTL Cloud tenant ID')
    .fill('22222222-2222-4222-8222-222222222222');
  const shop = await save(page, 'Main shop');
  await shop.getByRole('button', { name: 'Validate access' }).click();
  await shop.getByText('Read failing', { exact: true }).waitFor();
  expect(await shop.getByText('Permitted', { exact: true }).count()).toBe(0);
  await shop.getByRole('button', { name: 'Connection settings' }).click();
  expect(
    await page.getByLabel('Access token', { exact: true }).inputValue(),
  ).toBe('');
  await page
    .getByLabel('Access token', { exact: true })
    .fill('valid-test-token');
  await page.getByRole('button', { name: 'Confirm replacement' }).click();
  await shop.getByText('Importing', { exact: true }).waitFor();
  await shop.getByRole('button', { name: 'Validate access' }).click();
  await shop.getByText('Importing', { exact: true }).waitFor();
  await expect(shop.getByText('Permitted', { exact: true })).toHaveCount(4);
  await shop.getByText('Read-only access', { exact: true }).waitFor();
  await setup(page, 'JTL Cloud', 'Warehouse');
  await page
    .getByLabel('JTL Cloud tenant ID')
    .fill('11111111-1111-4111-8111-111111111111');
  await page.getByLabel(/Allow shipping method corrections/).check();
  const cloud = await save(page, 'Warehouse');
  await cloud.getByRole('button', { name: 'Validate access' }).click();
  await cloud.getByText('Read and write access', { exact: true }).waitFor();
  await page.getByRole('link', { name: 'All apps' }).click();
  const jtlSummary = page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: 'JTL', exact: true }) });
  await jtlSummary.getByText('2 connections', { exact: true }).waitFor();
  await page.screenshot({
    path: '/tmp/luma-apps-overview.png',
    fullPage: true,
    animations: 'disabled',
  });
  expect(
    await page.getByRole('article', { name: 'Main shop', exact: true }).count(),
  ).toBe(0);
  await jtlSummary.getByRole('link', { name: 'Manage app' }).click();
  await shop.waitFor();
  const linkedConnections = await (
    await context.request.get(
      `/api/v1/organizations/${organizationId}/connections`,
    )
  ).json();
  await page.goto(
    `/app/${organizationId}/connections#connection-${linkedConnections.items[0].id}`,
  );
  await page.waitForURL('**/apps/jtl/settings#connection-*');
  await shop.waitFor();
  await setup(page, 'JTL-Wawi on-premise', 'Local ERP');
  await page.getByLabel('HTTPS API URL').fill('https://erp.example.test/api/');
  await page.getByLabel('App ID', { exact: true }).fill('luma');
  await page.getByLabel('App version').fill('1.0');
  await page.getByLabel('Challenge code').fill('test-challenge');
  const onprem = await save(page, 'Local ERP');
  await onprem.getByRole('button', { name: 'Validate access' }).click();
  await onprem.getByText('Importing', { exact: true }).waitFor();
  await expect(onprem.getByText('Permitted', { exact: true })).toHaveCount(4);
  await page.goto(`/app/${organizationId}/apps/jtl/settings`);
  await page.getByRole('heading', { name: 'JTL', exact: true }).waitFor();
  expect(
    await page
      .getByRole('navigation', { name: 'Workspace navigation' })
      .getByRole('link', { name: 'Manage apps', exact: true })
      .getAttribute('aria-current'),
  ).toBe('page');
  await shop.getByText('Importing', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Refresh list' }).focus();
  await page.screenshot({
    path: '/tmp/luma-34-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  const listed = await context.request.get(
    `/api/v1/organizations/${organizationId}/connections`,
  );
  expect(listed.status()).toBe(200);
  const listText = await listed.text();
  expect(listText).not.toContain('test-token');
  expect(listText).not.toContain('challengeCode');
  const state = await page.evaluate(() =>
    JSON.stringify({
      local: { ...localStorage },
      session: { ...sessionStorage },
    }),
  );
  expect(state).not.toContain('test-token');
  expect(page.url()).not.toContain('token');
  await page.setViewportSize({ width: 390, height: 844 });
  await shop.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await shop.getByText('Importing', { exact: true }).waitFor();
  await shop.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'visible' });
  await expect
    .poll(() =>
      page
        .getByRole('dialog')
        .evaluate((element) => getComputedStyle(element).opacity),
    )
    .toBe('1');
  const dialogBox = await page.getByRole('dialog').boundingBox();
  expect(dialogBox.y).toBeGreaterThanOrEqual(0);
  expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(844);
  await page.screenshot({
    path: '/tmp/luma-34-mobile.png',
    fullPage: false,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Confirm disconnect' }).click();
  await shop.getByText('Disconnected', { exact: true }).waitFor();
  expect(
    await shop.getByRole('button', { name: 'Validate access' }).count(),
  ).toBe(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await shop.getByRole('button', { name: 'Connection settings' }).click();
  await page
    .getByRole('dialog')
    .getByLabel('Connection name')
    .fill('Reconnected shop');
  await page
    .getByRole('dialog')
    .getByLabel('Access token', { exact: true })
    .fill('valid-test-token');
  await page
    .getByRole('button', { name: 'Save connection', exact: true })
    .click();
  const reconnected = page.getByRole('article').filter({
    has: page.getByRole('heading', { name: 'Reconnected shop', exact: true }),
  });
  await reconnected.getByRole('button', { name: 'Validate access' }).click();
  await reconnected.getByText('Importing', { exact: true }).waitFor();
  await expect(reconnected.getByText('Permitted', { exact: true })).toHaveCount(
    4,
  );
  await shop.getByText('Disconnected', { exact: true }).waitFor();
  await page
    .getByRole('button', { name: 'Uninstall app', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Uninstall and disconnect', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Install JTL', exact: true })
    .waitFor();
  const disconnected = await (
    await context.request.get(
      `/api/v1/organizations/${organizationId}/connections`,
    )
  ).json();
  expect(
    disconnected.items.every(
      (connection) => connection.status === 'disconnected',
    ),
  ).toBe(true);
  appModules.length = 0;
  await page.reload();
  await page
    .getByRole('button', { name: 'Install JTL', exact: true })
    .waitFor();
  expect(appModules).toEqual([]);
  await db.owner.query(
    "UPDATE memberships SET role = 'member' WHERE tenant_id = $1",
    [organizationId],
  );
  await page.reload();
  await page
    .getByText('Your role can’t install or uninstall apps', {
      exact: false,
    })
    .waitFor();
  expect(
    await page
      .getByRole('button', { name: 'Install Shopify', exact: true })
      .isDisabled(),
  ).toBe(true);
  expect(
    await page
      .getByRole('button', { name: 'Connection settings', exact: true })
      .count(),
  ).toBe(0);
  const denied = await context.request.post(
    `/api/v1/organizations/${organizationId}/connections`,
    {
      headers: { origin },
      data: {
        label: 'Denied',
        target: { kind: 'shopify', shop: 'denied.myshopify.com' },
        permissions: ['orders.read'],
        credentials: { token: 'valid-test-token' },
      },
    },
  );
  expect(denied.status()).toBe(403);
  const foreign = await context.request.get(
    '/api/v1/organizations/99999999-9999-4999-8999-999999999999/connections',
  );
  expect(foreign.status()).toBe(404);
  const untrusted = await context.request.post(
    `/api/v1/organizations/${organizationId}/connections/${listText ? JSON.parse(listText).items[0].id : ''}/check`,
    { headers: { origin: 'https://untrusted.example' }, data: { version: 1 } },
  );
  expect(untrusted.status()).toBe(403);
  expect(errors).toEqual([]);
});

test('preserves non-secret input on errors, handles stale versions and unavailable service', async ({
  resources: t,
}) => {
  const { page, context, organizationId } = await fixture(t);
  await setup(page, 'JTL Cloud', 'Keep this name');
  await page
    .getByLabel('JTL Cloud tenant ID')
    .fill('22222222-2222-4222-8222-222222222222');
  await page.route('**/api/v1/organizations/*/connections', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 422,
          json: {
            code: 'CONFLICT',
            message: 'Invalid settings',
            requestId: 'fixture',
          },
        })
      : route.continue(),
  );
  await page.getByRole('button', { name: 'Save connection' }).click();
  await page
    .getByText('Check the connection details and enter the credentials again.')
    .waitFor();
  expect(await page.getByLabel('Connection name').inputValue()).toBe(
    'Keep this name',
  );
  expect(
    await page.getByLabel('Access token', { exact: true }).inputValue(),
  ).toBe('');
  await page.unroute('**/api/v1/organizations/*/connections');
  await page
    .getByLabel('Access token', { exact: true })
    .fill('valid-test-token');
  const card = await save(page, 'Keep this name');
  const list = await (
    await context.request.get(
      `/api/v1/organizations/${organizationId}/connections`,
    )
  ).json();
  const item = list.items[0];
  const path = `/api/v1/organizations/${organizationId}/connections/${item.id}/check`;
  expect(
    (
      await context.request.post(path, {
        headers: { origin },
        data: { version: item.version },
      })
    ).status(),
  ).toBe(200);
  await card.getByRole('button', { name: 'Validate access' }).click();
  await card
    .getByText('This connection changed. Refresh the list before trying again.')
    .waitFor();
  await card.getByText('Importing', { exact: true }).waitFor();
  await page.route('**/api/v1/organizations/*/connections', (route) =>
    route.fulfill({
      status: 503,
      json: { code: 'NOT_READY', message: 'Unavailable', requestId: 'fixture' },
    }),
  );
  await page.getByRole('button', { name: 'Refresh list' }).click();
  await page
    .getByRole('alert')
    .filter({ hasText: 'The connection service is unavailable.' })
    .waitFor();
  expect(await card.count()).toBe(0);
  await page.unroute('**/api/v1/organizations/*/connections');
  await page.getByRole('button', { name: 'Refresh list' }).click();
  await card.waitFor();
});

test('starts Shopify authorization without token fields and reports callback outcomes', async ({
  resources: t,
}) => {
  const { page, errors } = await fixture(t);
  await page.route('**/apps/shopify/access', (route) =>
    route.fulfill({
      status: 200,
      json: {
        customerDataApproved: false,
        allOrdersApproved: false,
        requestedScopes: [],
        grantedScopes: null,
        missingScopes: [],
        subscriptions: [],
      },
    }),
  );
  await page
    .getByRole('button', { name: 'Install Shopify', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Install Shopify', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Add connection', exact: true })
    .click();
  expect(await page.getByLabel('Access token', { exact: true }).count()).toBe(
    0,
  );
  await page
    .getByText('Luma can read orders from the last 60 days.', {
      exact: false,
    })
    .waitFor();
  await page
    .getByText(
      'Customer details aren’t available until Shopify approves access',
      { exact: false },
    )
    .waitFor();
  await page.getByLabel('Connection name').fill('Dev shop');
  await page.getByLabel('Shop hostname').fill('dev-shop.myshopify.com');
  await page.route('**/apps/shopify/authorize', (route) =>
    route.fulfill({
      status: 200,
      json: {
        authorizationUrl:
          'https://dev-shop.myshopify.com/admin/oauth/authorize?state=opaque-state',
      },
    }),
  );
  await page.route('https://dev-shop.myshopify.com/**', (route) =>
    route.fulfill({ status: 200, body: 'Shopify approval' }),
  );
  const returnUrl = page.url();
  await page.getByRole('button', { name: 'Continue to Shopify' }).click();
  await page.waitForURL('https://dev-shop.myshopify.com/**');
  await page.goto(returnUrl + '?appResult=denied');
  await page
    .getByText(
      'Authorization was declined, so no connection was added. Add the connection again to retry.',
    )
    .waitFor();
  expect(errors).toEqual([]);
}, 120000);

test('keeps basic Wawi access independent of an explicitly requested exchange reservation read', async ({
  resources: t,
}) => {
  const { page, context, organizationId } = await fixture(t);
  await setup(page, 'JTL Cloud', 'Exchange read');
  await page
    .getByLabel('JTL Cloud tenant ID')
    .fill('22222222-2222-4222-8222-222222222222');
  const exchange = page.getByLabel(
    /Read exchange replacement orders and reservations/,
  );
  await expect(exchange).not.toBeChecked();
  await exchange.check();
  const card = await save(page, 'Exchange read');
  const list = await (
    await context.request.get(
      `/api/v1/organizations/${organizationId}/connections`,
    )
  ).json();
  expect(list.items[0].permissions).toContain(
    'returns.exchange.reservation.read',
  );
  await card.getByRole('button', { name: 'Validate access' }).click();
  // This provider fixture supports basic reads only. Opt-in must never manufacture a grant.
  await expect(card.getByText('Read failing', { exact: true })).toBeVisible();
  await expect(
    card.getByText('Replacement order and reservation evidence', {
      exact: true,
    }),
  ).toBeVisible();
  expect(await card.getByText('Permitted', { exact: true }).count()).toBe(0);
});

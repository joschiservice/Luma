/* global document, innerWidth, getComputedStyle */
import { it, expect } from 'vitest';
import { chromium } from 'playwright';
import { database, startApi, startProcess } from './helpers.mjs';

const origin = 'http://127.0.0.1:3107';
async function fixture(t) {
  const db = await database(t);
  await db.migrate();
  await db.grantRuntime();
  const role = new URL(db.runtimeUrl).username;
  await db.owner.query(`GRANT luma_connectors TO "${role}"`);
  const api = await startApi(t, db, origin, 'e2e/connections-server.mjs');
  const web = startProcess(
    t,
    'e2e/web-server.mjs',
    { TEST_API_ORIGIN: api.origin },
    true,
  );
  await web.message('listening');
  const browser = await chromium.launch();
  t.onTestFinished(() => browser.close());
  const context = await browser.newContext({
    baseURL: origin,
    viewport: { width: 1440, height: 1100 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(15_000);
  await page.goto('/sign-up');
  await page.getByLabel('Name', { exact: true }).fill('Ada');
  await page.getByLabel('Email', { exact: true }).fill('ada@example.test');
  await page
    .getByLabel('Password', { exact: true })
    .fill('browser-test-password-123');
  await page
    .getByRole('button', { name: 'Create account', exact: true })
    .click();
  await page.getByLabel('Workspace name').fill('North Studio');
  await page
    .getByRole('button', { name: 'Create workspace', exact: true })
    .click();
  await page
    .getByRole('heading', { name: 'Welcome to your Exception Desk.' })
    .waitFor();
  const organizationId = new URL(page.url()).pathname.split('/')[2];
  await page.getByRole('link', { name: 'Connections', exact: true }).click();
  await page.getByText('No connections yet', { exact: true }).waitFor();
  return { db, api, page, context, organizationId, errors };
}
async function setup(page, provider, label, token = 'valid-test-token') {
  await page
    .getByRole('button', { name: `Set up ${provider}`, exact: true })
    .click();
  await page.getByLabel('Connection name').fill(label);
  await page.getByLabel('Access token', { exact: true }).fill(token);
  return page.getByRole('dialog');
}
async function save(page, label) {
  await page
    .getByRole('button', { name: 'Save connection', exact: true })
    .click();
  const card = page.getByRole('article', { name: label, exact: true });
  await card.getByText('Awaiting validation', { exact: true }).waitFor();
  return card;
}

it('connects all supported targets, validates, replaces invalid credentials and disconnects', async (t) => {
  const { page, context, db, errors, organizationId } = await fixture(t);
  expect(await page.title()).toBe('Luma');
  await setup(page, 'Shopify', 'Main shop', 'invalid-test-token');
  await page.getByLabel('Shop hostname').fill('north.myshopify.com');
  const shop = await save(page, 'Main shop');
  await shop.getByRole('button', { name: 'Validate access' }).click();
  await shop.getByText('Needs attention', { exact: true }).waitFor();
  expect(await shop.getByText('Permitted', { exact: true }).count()).toBe(0);
  await shop.getByRole('button', { name: 'Replace credentials' }).click();
  expect(
    await page.getByLabel('Access token', { exact: true }).inputValue(),
  ).toBe('');
  await page
    .getByLabel('Access token', { exact: true })
    .fill('valid-test-token');
  await page.getByRole('button', { name: 'Confirm replacement' }).click();
  await shop.getByText('Awaiting validation', { exact: true }).waitFor();
  await shop.getByRole('button', { name: 'Validate access' }).click();
  await shop.getByText('Validated', { exact: true }).waitFor();
  expect(await shop.getByText('Permitted', { exact: true }).count()).toBe(4);
  await shop.getByText('Read-only access', { exact: true }).waitFor();
  await setup(page, 'JTL Cloud', 'Warehouse');
  await page
    .getByLabel('JTL Cloud tenant ID')
    .fill('11111111-1111-4111-8111-111111111111');
  await page.getByLabel(/Permit shipping-method corrections/).check();
  const cloud = await save(page, 'Warehouse');
  await cloud.getByRole('button', { name: 'Validate access' }).click();
  await cloud.getByText('Read and write access', { exact: true }).waitFor();
  await setup(page, 'JTL-Wawi on-premise', 'Local ERP');
  await page.getByLabel('HTTPS API URL').fill('https://erp.example.test/api/');
  await page.getByLabel('App ID', { exact: true }).fill('luma');
  await page.getByLabel('App version').fill('1.0');
  await page.getByLabel('Challenge code').fill('test-challenge');
  const onprem = await save(page, 'Local ERP');
  await onprem.getByRole('button', { name: 'Validate access' }).click();
  await onprem.getByText('Validated', { exact: true }).waitFor();
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
  await shop.getByText('Validated', { exact: true }).waitFor();
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
  expect(await shop.getByRole('button').count()).toBe(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await db.owner.query(
    "UPDATE memberships SET role = 'member' WHERE tenant_id = $1",
    [organizationId],
  );
  await page.reload();
  await page.getByText('You can view connections.', { exact: false }).waitFor();
  expect(
    await page
      .getByRole('button', { name: 'Set up Shopify', exact: true })
      .isDisabled(),
  ).toBe(true);
  expect(
    await page
      .getByRole('button', { name: 'Replace credentials', exact: true })
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
}, 120_000);

it('preserves non-secret input on errors, handles stale versions and unavailable service', async (t) => {
  const { page, context, organizationId } = await fixture(t);
  await setup(page, 'Shopify', 'Keep this name');
  await page.getByLabel('Shop hostname').fill('draft.myshopify.com');
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
  await card.getByText('Validated', { exact: true }).waitFor();
  await page.route('**/api/v1/organizations/*/connections', (route) =>
    route.fulfill({
      status: 503,
      json: { code: 'NOT_READY', message: 'Unavailable', requestId: 'fixture' },
    }),
  );
  await page.getByRole('button', { name: 'Refresh list' }).click();
  await page
    .getByRole('alert')
    .filter({ hasText: 'Connection service unavailable.' })
    .waitFor();
  expect(await page.getByRole('article').count()).toBe(0);
  await page.unroute('**/api/v1/organizations/*/connections');
  await page.getByRole('button', { name: 'Refresh list' }).click();
  await card.waitFor();
}, 120_000);

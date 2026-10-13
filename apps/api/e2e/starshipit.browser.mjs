/* global document */
import { expect, test } from './browser-fixtures.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { starshipitOperationsFixture } from './starshipit-operations-fixture.mjs';

async function browserFixture(t, options) {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const f = await starshipitOperationsFixture(t, origin, options);
  const web = startProcess(
    t,
    'e2e/web-server.mjs',
    { TEST_API_ORIGIN: f.apiOrigin, TEST_WEB_PORT: String(port) },
    true,
  );
  await web.message('listening');
  const errors = [];
  const page = async (actor = 'operator') => {
    const context = await t.newContext({
      baseURL: origin,
      viewport: { width: 1280, height: 900 },
    });
    await context.addCookies(
      f.cookies
        .get(actor)
        .split('; ')
        .map((value) => {
          const [name, ...rest] = value.split('=');

          return { name, value: rest.join('='), url: origin };
        }),
    );
    const current = await context.newPage();
    current.on('pageerror', (error) => errors.push(error.message));
    current.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });

    return current;
  };

  return { ...f, page, errors };
}

async function confirmLink(page, f, button, reason) {
  await button.click();
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByRole('button', { name: 'Link records', exact: true }),
  ).toBeDisabled();
  await dialog.getByLabel('Why is this correct?').fill(reason);
  const response = page.waitForResponse(
    (response) =>
      response.url().endsWith('/identities/links') &&
      response.request().method() === 'POST',
  );
  await dialog
    .getByRole('button', { name: 'Link records', exact: true })
    .click();
  const request = await (await response).json();
  await f.complete(request);
  await f.pilot.observe({ check: false });
}

test('confirms source order and line identities, reviews the exact shipping correction, approves independently and verifies one provider write', async ({
  resources: t,
}) => {
  const f = await browserFixture(t);
  await f.setAuthority();
  const page = await f.page();
  const orderUrl = `/app/${f.tenantId}/orders/${f.shop}`;
  await page.goto(orderUrl);
  await expect(
    page.getByRole('heading', { name: 'Current state', exact: true }),
  ).toBeVisible();
  const sourceChoice = page
    .locator('.sync-identity-suggestions li')
    .filter({ hasText: 'SIMULATED STARSHIPIT' });
  await confirmLink(
    page,
    f,
    sourceChoice.getByRole('button', { name: 'Link', exact: true }),
    'Checked these exact Shopify and Starshipit orders in the merchant integration.',
  );
  await page.reload();
  const lineSection = page.getByRole('region', {
    name: 'Match order lines',
    exact: true,
  });
  await lineSection
    .getByRole('combobox', { name: 'Order line to match', exact: true })
    .click();
  const shopLabel = (await f.detail()).sources.find(
    (source) => source.connectionId === f.manifest.connections.shopify,
  ).label;
  await page.getByRole('option').filter({ hasText: shopLabel }).click();
  const shippingLine = lineSection
    .locator('.sync-identity-suggestions li')
    .filter({ hasText: 'SIMULATED STARSHIPIT' });
  await confirmLink(
    page,
    f,
    shippingLine.getByRole('button', { name: 'Link', exact: true }),
    'Confirmed this shipping item is the exact order line selected in Shopify.',
  );
  await f.setShopQuantity(1);
  await page.reload();
  const plan = page.getByRole('region', { name: /^Change plan/ });
  await plan.getByLabel('New quantity', { exact: true }).fill('1');
  await plan
    .getByRole('button', { name: 'Plan this change', exact: true })
    .click();
  await plan
    .getByRole('button', { name: /Review in SIMULATED STARSHIPIT/ })
    .click();
  const correction = page.locator(
    `#source-${f.manifest.connections.starshipit}`,
  );
  await expect(
    correction.getByText('Quantity: 2 → 1', { exact: false }),
  ).toBeVisible();
  await correction
    .getByRole('button', { name: 'Review correction', exact: true })
    .focus();
  const previewResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/order-update-preview') &&
      response.request().method() === 'POST',
    { timeout: 45_000 },
  );
  await page.keyboard.press('Enter');
  expect((await previewResponse).ok()).toBe(true);
  await expect(
    correction.getByText(
      'This correction needs approval under your workspace policy.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    correction.getByRole('button', {
      name: 'Send approved correction',
      exact: true,
    }),
  ).toHaveCount(0);
  const approver = await f.page('requester');
  await approver.goto(page.url());
  const approval = approver.locator(
    `#source-${f.manifest.connections.starshipit}`,
  );
  const approvedResponse = approver.waitForResponse(
    (response) =>
      response.url().endsWith('/order-update-approve') &&
      response.request().method() === 'POST',
    { timeout: 45_000 },
  );
  await approval
    .getByRole('button', { name: 'Approve correction', exact: true })
    .click();
  const approved = await approvedResponse;
  expect(approved.ok()).toBe(true);
  expect((await approved.json()).state).toBe('approved');
  await expect(
    approval.getByRole('button', { name: 'Approve correction', exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    correction.getByText(
      'Approved. The requester can send this exact correction after a fresh check.',
      { exact: true },
    ),
  ).toBeVisible();
  await f.call('runs/operations/control', {
    action: 'fault',
    rule: {
      instance: 'starshipit',
      operation: 'orders.quantity.update',
      resource: '1',
      kind: 'response-loss',
      remaining: 1,
    },
  });
  const execution = page.waitForResponse(
    (response) => response.url().endsWith('/order-update-execute'),
    { timeout: 30000 },
  );
  await correction
    .getByRole('button', { name: 'Send approved correction', exact: true })
    .click();
  const executionResponse = await execution;
  expect(executionResponse.ok(), await executionResponse.text()).toBe(true);
  await expect(
    correction.getByText(
      'The correction is not verified. Check again; Luma will not send this request again.',
      { exact: true },
    ),
  ).toBeVisible();
  await correction
    .getByRole('button', { name: 'Check current result', exact: true })
    .click();
  await expect(
    correction.getByText(
      'A fresh Starshipit read confirms the approved quantities.',
      { exact: true },
    ),
  ).toBeVisible();
  const writes = async () =>
    (await f.call('runs/operations/scorecard')).duplicateWrites.filter(
      (write) => write.instance === 'starshipit',
    );
  expect(await writes()).toEqual([]);
  const state = await f.call('runs/operations/records/starshipit?kind=order');
  expect(
    state.items.find((record) => record.id === '1').data.items[0].quantity,
  ).toBe(1);
  // The simulator database is inaccessible to Luma; its journal reports committed writes.
  await expect
    .poll(
      async () =>
        (
          await f.call('runs/operations/journal?instance=starshipit')
        ).items.filter(
          (item) =>
            item.kind === 'provider-write' && item.detail.status === 200,
        ).length,
    )
    .toBe(1);
  await correction.screenshot({
    path: '/tmp/luma-starshipit-correction-desktop.png',
  });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.setViewportSize({ width: 390, height: 844 });
  await correction.scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await correction.screenshot({
    path: '/tmp/luma-starshipit-correction-mobile-dark.png',
  });
  const observer = await f.page('warehouse');
  await observer.goto(orderUrl);
  await expect(
    observer.getByRole('heading', { name: 'Current state', exact: true }),
  ).toBeVisible();
  await expect(
    observer.getByRole('heading', {
      name: 'Correct unshipped shipping quantities',
      exact: true,
    }),
  ).toHaveCount(0);
  expect(f.errors).toEqual([]);
});

test('shows a disabled shipping action release without offering an executable correction', async ({
  resources: t,
}) => {
  const f = await browserFixture(t, {
    featureFlagOverrides: { 'starshipit-actions': false },
  });
  const page = await f.page();
  await page.goto(`/app/${f.tenantId}/orders/${f.shipping}`);
  const correction = page.locator(
    `#source-${f.manifest.connections.starshipit}`,
  );
  await expect(
    correction.getByText(
      'Shipping corrections are unavailable for this workspace.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    correction.getByRole('button', { name: 'Review correction', exact: true }),
  ).toHaveCount(0);
  await expect(
    correction.getByRole('button', {
      name: 'Send approved correction',
      exact: true,
    }),
  ).toHaveCount(0);
  expect(f.errors).toEqual([]);
});

/* global document */
import { expect, test } from './browser-fixtures.mjs';
import { starshipitOperationsFixture } from './starshipit-operations-fixture.mjs';

async function browserFixture(t, web, options) {
  const origin = web.origin;
  const f = await starshipitOperationsFixture(t, origin, options);
  await web.route(f.apiOrigin);
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

  return { ...f, origin, page, errors };
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

/** Opens the live Starshipit details beside the order from the order's actions. */
async function openLiveStarshipit(page) {
  await page.getByRole('button', { name: 'More order actions' }).click();
  await page.getByRole('menuitem', { name: /^Live .*STARSHIPIT/i }).click();
  await expect(
    page.getByRole('dialog', { name: /^Live .*STARSHIPIT/i }),
  ).toBeVisible();
}

test('confirms source order and line identities, reviews the exact shipping correction, approves independently and verifies one provider write', async ({
  resources: t,
  web,
}) => {
  const f = await browserFixture(t, web);
  await f.separateShippingOrder();
  await f.setAuthority();
  const page = await f.page();
  const orderUrl = `/app/${f.tenantId}/orders/${f.shop}`;
  await page.goto(orderUrl);
  await expect(
    page.getByRole('region', { name: 'Current state', exact: true }),
  ).toBeVisible();
  // Linked sources open in a panel beside the order.
  const openLinks = async () => {
    await page.getByRole('button', { name: 'More order actions' }).click();
    await page.getByRole('menuitem', { name: 'Linked sources' }).click();
    await expect(
      page.getByRole('dialog', { name: 'Linked sources' }),
    ).toBeVisible();
  };
  await openLinks();
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
  await openLinks();
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
  await page.getByRole('button', { name: 'More order actions' }).click();
  await page.getByRole('menuitem', { name: 'Plan a quantity change' }).click();
  const plan = page.getByRole('dialog', { name: 'Change plan' });
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
  await page.setViewportSize({ width: 390, height: 844 });
  await correction.scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  const observer = await f.page('warehouse');
  await observer.goto(orderUrl);
  await expect(
    observer.getByRole('region', { name: 'Current state', exact: true }),
  ).toBeVisible();
  await openLiveStarshipit(observer);
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
  web,
}) => {
  const f = await browserFixture(t, web, {
    featureFlagOverrides: { 'starshipit-actions': false },
  });
  const page = await f.page();
  await page.goto(`/app/${f.tenantId}/orders/${f.shipping}`);
  await openLiveStarshipit(page);
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

test('shows a generated webhook secret once, replaces it on request and records each generation', async ({
  resources: t,
  web,
}) => {
  const f = await browserFixture(t, web);
  const id = f.manifest.connections.starshipit;
  const page = await f.page();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const wake = (authorization) =>
    fetch(`${f.apiOrigin}/v1/starshipit/changes/${f.tenantId}/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization },
      body: JSON.stringify({ order_id: 1 }),
    }).then((response) => response.status);
  const pilotHeader = `Bearer ${f.manifest.simulator.webhookSecret}`;
  expect(await wake(pilotHeader)).toBe(202);

  await page.goto(`/app/${f.tenantId}/connections#connection-${id}`);
  await page.waitForURL('**/apps/starshipit/settings#connection-*');
  const card = page.locator(`#connection-${id}`);
  const openSettings = async () => {
    await card.getByRole('button', { name: 'Connection settings' }).click();
    const dialog = page.getByRole('dialog');
    await expect(
      dialog.getByRole('heading', { name: 'Change notifications' }),
    ).toBeVisible();

    return dialog;
  };
  /** Reads the one-time reveal, checks focus and copying, then closes it. */
  const reveal = async (dialog, intro) => {
    await expect(dialog.getByText(intro, { exact: true })).toBeVisible();
    const notice = dialog
      .getByRole('alert')
      .filter({ hasText: "You won't see this secret again." });
    await expect(notice).toBeFocused();
    const url = dialog.getByLabel('Change notification URL', { exact: true });
    const header = dialog.getByLabel(
      'Authorization header for change notifications',
      { exact: true },
    );
    await expect(url).toHaveValue(
      `${f.origin}/api/v1/starshipit/changes/${f.tenantId}/${id}`,
    );
    const authorization = await header.inputValue();
    expect(authorization).toMatch(/^Bearer [A-Za-z0-9_-]{43}$/);
    await dialog
      .getByRole('button', {
        name: 'Copy Authorization header for change notifications',
      })
      .click();
    await expect(
      dialog.getByRole('status').filter({
        hasText: 'Authorization header for change notifications copied.',
      }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => globalThis.navigator.clipboard.readText()),
    ).toBe(authorization);
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    return authorization;
  };

  let dialog = await openSettings();
  await dialog
    .getByRole('button', { name: 'Generate a new webhook secret' })
    .click();
  const generated = await reveal(
    dialog,
    'Luma generated a new webhook secret. The previous secret no longer works.',
  );
  // The previous secret stops working at once; the generated one wakes reads.
  expect(await wake(pilotHeader)).toBe(401);
  expect(await wake(generated)).toBe(202);

  // Reopening never shows the secret again.
  dialog = await openSettings();
  await expect(
    dialog.getByLabel('Authorization header for change notifications'),
  ).toHaveCount(0);
  await expect(dialog.getByText(generated.slice(7))).toHaveCount(0);

  // Saving new keys replaces the secret and reveals the new one once.
  await dialog
    .getByLabel('API key', { exact: true })
    .fill('synthetic-not-a-provider-secret');
  await dialog
    .getByLabel('Subscription key', { exact: true })
    .fill('synthetic-subscription-key');
  await dialog.getByRole('button', { name: 'Save connection' }).click();
  const rotated = await reveal(
    dialog,
    'Saved. Luma generated a webhook secret for this connection.',
  );
  expect(rotated).not.toBe(generated);
  // Saved keys leave the connection pending, so wakeups wait for validation.
  expect(await wake(rotated)).toBe(401);
  expect(await wake(generated)).toBe(401);

  const events = (
    await f.db.owner.query(
      'SELECT event,actor_id FROM connector_lifecycle_events WHERE tenant_id=$1 AND connection_id=$2 ORDER BY version',
      [f.tenantId, id],
    )
  ).rows;
  expect(
    events.map((event) => event.event).filter((event) => event !== 'checked'),
  ).toEqual(
    expect.arrayContaining(['webhook_secret_generated', 'credentials_rotated']),
  );
  expect(
    events.filter((event) => event.event === 'webhook_secret_generated'),
  ).toHaveLength(2);
  expect(JSON.stringify(events)).not.toContain(generated.slice(7));
  expect(JSON.stringify(events)).not.toContain(rotated.slice(7));
  await page.goto(`/app/${f.tenantId}/activity`);
  await expect(
    page.getByText('Webhook secret generated', { exact: true }).first(),
  ).toBeVisible();
  expect(f.errors).toEqual([]);
});

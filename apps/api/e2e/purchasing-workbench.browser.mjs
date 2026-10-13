/* global document, window */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createObservability } from '@luma/platform/composition';

import { expect, test } from './browser-fixtures.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { setupSimulator } from './simulator-fixture.mjs';

const flags = {
  'supplier-purchasing-terms': true,
  'purchasing-workbench': true,
  'purchasing-plans': true,
  'purchasing-outcomes': true,
  'purchasing-incoming': true,
};

/** Seeds independently observed demand and stock, then records reviewed supplier terms through HTTP. */
async function purchasingFixture(t, origin) {
  const f = await setupSimulator(t, {
    origin,
    historyDays: 14,
    featureFlagOverrides: flags,
    observability: createObservability({
      environment: 'test',
      release: 'test',
      sampleRate: 0,
      featureFlagOverrides: flags,
    }),
  });
  const org = f.manifest.organizationId;
  const login = async (email) => {
    const r = await f.pilot.app.inject({
      method: 'POST',
      url: '/auth/sign-in/email',
      headers: { origin },
      payload: { email, password: f.password },
    });
    assert.equal(r.statusCode, 200, r.body);

    return r.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  };
  const buyer = await login('pilot-operator@example.test');
  const approver = await login('pilot-requester@example.test');
  const api = async (
    path,
    body,
    cookie = buyer,
    method = body ? 'POST' : 'GET',
  ) => {
    const r = await f.pilot.app.inject({
      method,
      url: `/v1/organizations/${org}${path}`,
      headers: { origin, cookie },
      ...(body ? { payload: body } : {}),
    });
    assert.equal(r.statusCode, 200, r.body);

    return r.json();
  };
  await f.pilot.observe({ check: false });
  await f.pilot.link();
  for (const group of ['inventory_stock', 'inventory_selling', 'order_lines']) {
    const authority = await api('/source-authority');
    await api('/source-authority', {
      commandId: randomUUID(),
      revision: authority.revision,
      group,
      connectionId: f.manifest.connections.shopify,
    });
  }
  const skuId = (
    await f.db.owner.query(
      `SELECT DISTINCT canonical_id FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=$2 AND resource='sku' AND external_id=$3`,
      [org, f.manifest.connections.shopify, 'gid://shopify/InventoryItem/1'],
    )
  ).rows[0].canonical_id;
  await f.call('runs/operations/control', {
    action: 'order',
    shop: 'shopify',
    lines: [{ sku: 'LUMA-001', quantity: 14 }],
  });
  await f.call('runs/operations/control', {
    action: 'command',
    instance: 'shopify',
    command: { kind: 'available', variant: '1', location: '1', quantity: 0 },
  });
  await f.pilot.observe({ check: false });
  const suppliers = [];
  for (const name of [
    'Northstar Supply',
    'Harbor Supply',
    'Missing Pack Supply',
  ]) {
    const supplier = await api('/procurement/suppliers', {
      id: randomUUID(),
      name,
      externalReferences: [],
    });
    suppliers.push(supplier);
    await api('/procurement/supplier-terms', {
      id: randomUUID(),
      supplierId: supplier.id,
      skuId,
      expectedRevision: 0,
      reason: 'Reviewed synthetic purchasing terms',
      values: {
        supplierArticleNumber: 'QA-001',
        unitPrice: {
          amount: '3.50',
          currency: 'EUR',
          validFrom: new Date().toISOString().slice(0, 10),
        },
        packSize: name === 'Missing Pack Supply' ? null : 1,
        lineMinimumQuantity: 1,
        leadTimeDays: 7,
        preferred: name === 'Northstar Supply',
      },
    });
  }
  const initial = await api('/procurement/purchasing');
  await api(
    '/procurement/purchasing/settings',
    { ...initial.settings, demandPeriodDays: 7 },
    buyer,
    'PUT',
  );
  const overview = await api('/procurement/purchasing?demandPeriodDays=7');
  assert.equal(overview.items.length, 3);
  assert.deepEqual(
    overview.items.find((r) => r.supplierId === suppliers[0].id).missing,
    [],
  );

  return {
    f,
    org,
    api,
    buyer,
    approver,
    skuId,
    supplierId: suppliers[0].id,
    alternativeId: suppliers[1].id,
  };
}

test('reviews grouped purchasing evidence and independently approved drafts across themes and narrow layouts', async ({
  resources: t,
}) => {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const { f, org, api, buyer, approver, skuId, supplierId, alternativeId } =
    await purchasingFixture(t, origin);
  const apiOrigin = f.apiOrigin;
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
    buyer.split('; ').map((value) => {
      const [name, ...rest] = value.split('=');

      return { name, value: rest.join('='), url: origin };
    }),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let releaseRead;
  const readGate = new Promise((resolve) => {
    releaseRead = resolve;
  });
  await page.route(
    '**/procurement/purchasing?**',
    async (route) => {
      await readGate;
      await route.continue();
    },
    { times: 1 },
  );
  const url = `/app/${org}/procurement?view=purchasing&q=&status=`;
  await page.goto(url);
  await expect(
    page.getByRole('status').filter({ hasText: 'Reading purchasing evidence' }),
  ).toBeVisible();
  releaseRead();
  await expect(
    page.getByRole('table', {
      name: 'Purchasing recommendations for Northstar Supply',
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('table', {
      name: 'Purchasing recommendations for Harbor Supply',
    }),
  ).toBeVisible();
  const missing = page.getByRole('table', {
    name: 'Purchasing recommendations for Missing Pack Supply',
  });
  await expect(
    missing.getByText('Inputs missing or stale', { exact: true }),
  ).toBeVisible();
  await expect(
    missing.getByText('Pack size missing', { exact: false }),
  ).toBeVisible();
  await expect(missing.getByRole('checkbox')).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Demand period' }).click();
  await page.getByRole('option', { name: '7 days', exact: true }).click();
  await expect(
    page.getByRole('combobox', { name: 'Demand period' }),
  ).toContainText('7 days');
  const alternative = page.getByRole('table', {
    name: 'Purchasing recommendations for Harbor Supply',
  });
  await alternative.getByText('Inputs and sources', { exact: true }).click();
  await alternative
    .getByRole('textbox', { name: 'Reason for ignoring this recommendation' })
    .fill('Choose the preferred supplier for this reviewed arrival');
  const outcomesRefresh = page.waitForResponse(
    async (response) =>
      response.url().endsWith('/procurement/purchasing/outcomes') &&
      response.status() === 200 &&
      (await response.json()).items.some(
        (item) => item.supplierId === alternativeId,
      ),
  );
  await alternative
    .getByRole('button', { name: 'Ignore recommendation', exact: true })
    .click();
  await expect(
    alternative.getByText(
      'Ignored decision recorded for later outcome checks.',
    ),
  ).toBeVisible();
  await outcomesRefresh;
  const supplier = page.getByRole('table', {
    name: 'Purchasing recommendations for Northstar Supply',
  });
  await supplier.getByText('Inputs and sources', { exact: true }).click();
  await expect(supplier.getByText(/14 units over 7 days/)).toBeVisible();
  await supplier.getByRole('checkbox', { name: 'Select LUMA-001' }).check();
  await supplier.getByText('Inputs and sources', { exact: true }).click();
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 390, height: 844 });
    const quantity = supplier.getByRole('spinbutton', {
      name: 'Order quantity for LUMA-001',
    });
    const destination = supplier.getByRole('combobox', {
      name: 'Receiving location',
    });
    const include = supplier.getByRole('checkbox', { name: 'Select LUMA-001' });
    await include.uncheck();
    await expect(quantity).toHaveCount(0);
    await include.check();
    await quantity.scrollIntoViewIfNeeded();
    await expect(quantity).toBeVisible();
    await expect(destination).toBeVisible();
    await expect(destination).toContainText('Location');
    await expect(destination).not.toContainText('["source",');
    await quantity.fill('30');
    await expect(
      supplier
        .getByRole('rowheader')
        .getByText('After ordering: 15 days of cover'),
    ).toBeVisible();
    await quantity.fill('28');
    for (const control of [quantity, destination]) {
      const box = await control.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    }
    await t.attach(`purchasing-${colorScheme}-selected`, {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
  }
  await page.setViewportSize({ width: 740, height: 900 });
  await expect(
    supplier.getByRole('checkbox', { name: 'Select LUMA-001' }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page
    .getByRole('textbox', { name: 'Order reference (optional)' })
    .fill('PO-BROWSER-QA');
  await page
    .getByRole('textbox', {
      name: 'Reason for changed quantity or minimum exception',
    })
    .fill('Reviewed supplier demand and receiving location');
  const search = page.getByRole('searchbox', {
    name: 'Search purchasing recommendations',
  });
  const quantityBeforeSearch = supplier.getByRole('spinbutton', {
    name: 'Order quantity for LUMA-001',
  });
  await quantityBeforeSearch.fill('30');
  const referenceBeforeSearch = await page
    .getByRole('textbox', { name: 'Order reference (optional)' })
    .elementHandle();
  await search.fill('harbor');
  await search.press('Enter');
  await expect(
    page.getByRole('table', {
      name: 'Purchasing recommendations for Harbor Supply',
    }),
  ).toBeVisible();
  await expect(supplier).toBeHidden();
  await expect(
    page.getByRole('table', { name: /Purchasing recommendations for/ }),
  ).toHaveCount(1);
  await search.fill('LUMA-001');
  await search.press('Enter');
  await expect(
    page.getByRole('table', { name: /Purchasing recommendations for/ }),
  ).toHaveCount(3);
  await search.fill('no-supplier-matches-this');
  await search.press('Enter');
  await expect(
    page.getByRole('heading', {
      name: 'No matching purchasing recommendations',
    }),
  ).toBeVisible();
  expect(
    await referenceBeforeSearch.evaluate((element) => element.isConnected),
  ).toBe(true);
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(
    page.getByRole('table', { name: /Purchasing recommendations for/ }),
  ).toHaveCount(3);
  await expect(quantityBeforeSearch).toHaveValue('30');
  await expect(
    page.getByRole('textbox', { name: 'Order reference (optional)' }),
  ).toHaveValue('PO-BROWSER-QA');
  await quantityBeforeSearch.fill('28');
  // The user reviewed revision one. Another operator changes the terms before this command.
  await api('/procurement/supplier-terms', {
    id: randomUUID(),
    supplierId,
    skuId,
    expectedRevision: 1,
    reason: 'Another operator reviewed a new two-unit pack',
    values: { packSize: 2 },
  });
  const staleResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/procurement/purchasing/plans') &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Request draft approval' }).click();
  expect((await staleResponse).status()).toBe(409);
  await expect(
    page.getByRole('alert').filter({
      hasText:
        'Inputs changed or are unavailable. Refresh and review this purchasing plan.',
    }),
  ).toBeVisible();
  const reason = page.getByRole('textbox', {
    name: 'Reason for changed quantity or minimum exception',
  });
  await expect(reason).toBeEnabled();
  await expect(
    page.getByRole('textbox', { name: 'Order reference (optional)' }),
  ).toBeEnabled();
  await expect(
    supplier.getByRole('spinbutton', { name: 'Order quantity for LUMA-001' }),
  ).toBeEnabled();
  await reason.fill('Reviewed the refreshed two-unit pack and demand');
  expect((await api('/procurement/purchasing/plans')).items).toHaveLength(0);
  const freshRead = page.waitForResponse(
    (response) =>
      /\/procurement\/purchasing\?/.test(response.url()) &&
      response.status() === 200,
  );
  await page
    .getByRole('button', { name: 'Refresh purchase orders and suppliers' })
    .click();
  const refreshed = await (await freshRead).json();
  expect(
    refreshed.items.find((row) => row.supplierId === supplierId).termsRevision,
  ).toBe(2);
  await page.getByRole('button', { name: 'Request draft approval' }).click();
  await expect(page.getByText('Needs approval', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Approve draft', exact: true }),
  ).toHaveCount(0);
  const plans = await api('/procurement/purchasing/plans');
  expect(plans.items).toHaveLength(1);
  const plan = plans.items[0];
  const verified = await api(
    `/procurement/purchasing/plans/${plan.id}/decision`,
    { decisionId: plan.decisionId, outcome: 'approved' },
    approver,
  );
  expect(verified.state).toBe('verified');
  await page.reload();
  await expect(page.getByText('Draft verified', { exact: true })).toBeVisible();
  await page
    .getByRole('searchbox', { name: 'Search purchasing recommendations' })
    .fill('PO-BROWSER-QA');
  await page
    .getByRole('searchbox', { name: 'Search purchasing recommendations' })
    .press('Enter');
  await expect(
    page.getByRole('table', {
      name: 'Purchasing recommendations for Northstar Supply',
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Clear', exact: true }).click();

  await page
    .getByRole('link', { name: 'Open purchase order', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'PO-BROWSER-QA', exact: true }),
  ).toBeVisible();
  await page.goto(url);
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByRole('table', {
        name: 'Purchasing recommendations for Harbor Supply',
      }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await t.attach(`purchasing-${colorScheme}-narrow`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
    await page
      .getByRole('table', {
        name: 'Purchasing recommendations for Harbor Supply',
      })
      .scrollIntoViewIfNeeded();
    await t.attach(`purchasing-${colorScheme}-supplier`, {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
  }
  await page.getByRole('tab', { name: /Suppliers/ }).click();
  await page.getByRole('button', { name: 'Add supplier', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByRole('heading', { name: 'Add supplier' }),
  ).toBeVisible();
  await page.getByLabel('Supplier name', { exact: true }).focus();
  await page.keyboard.press('Tab');
  expect(
    await page.evaluate(
      () => !!document.activeElement.closest('[role=dialog]'),
    ),
  ).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Add supplier', exact: true }),
  ).toBeFocused();
  await page.goto(url);
  await page.route('**/procurement/purchasing?**', async (route) => {
    const r = await route.fetch();
    await route.fulfill({ json: { ...(await r.json()), enabled: false } });
  });
  await page.reload();
  await expect(
    page.getByRole('heading', {
      name: 'Purchasing is unavailable in this workspace.',
    }),
  ).toBeVisible();
  await page.unroute('**/procurement/purchasing?**');
  await page.route('**/procurement/purchasing?**', (route) =>
    route.fulfill({
      status: 503,
      json: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Purchasing evidence unavailable',
      },
    }),
  );
  await page.reload();
  await expect(
    page.getByRole('alert').getByRole('button', { name: 'Retry', exact: true }),
  ).toBeVisible();
  await page.unroute('**/procurement/purchasing?**');
  await page
    .getByRole('alert')
    .getByRole('button', { name: 'Retry', exact: true })
    .click();
  await expect(
    page.getByRole('table', {
      name: 'Purchasing recommendations for Harbor Supply',
    }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

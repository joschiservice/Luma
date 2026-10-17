/* global document, window */
import { randomUUID } from 'node:crypto';

import { createObservability } from '@luma/platform/composition';

import { appScopes } from './app-scopes.mjs';
import { expect, test } from './browser-fixtures.mjs';
import { addMembership, availablePort, startProcess } from './helpers.mjs';
import { ordersFixture } from './orders-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

test('opens an imported customer from an order, lists their imported orders and keeps other stores and workspaces apart', async ({
  resources: t,
}) => {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  // Saved views are behind a release flag.
  const observability = createObservability({
    environment: 'test',
    release: 'test',
    sampleRate: 0,
    featureFlagOverrides: { 'adaptive-saved-views': true },
  });
  const f = await settingsFixture(t, origin, { observability });
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
  const requests = [];
  // Only the order's live source panel reads Shopify; customer history never does.
  await page.route('**/apps/shopify/records', async (route) => {
    const input = route.request().postDataJSON();
    requests.push(input);
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
    const sections = [
      section('order', 'Order', [order]),
      section('customer', 'Customer', [contact]),
      section('returns', 'Returns', []),
      section('refunds', 'Refunds', [
        row('gid://shopify/Refund/9', { Refunded: '12.00 EUR' }),
      ]),
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
  });
  const profile = async (
    externalId,
    name,
    { state = 'enabled', spent = '84.00' } = {},
  ) => {
    const id = randomUUID();
    await f.db.owner.query(
      `INSERT INTO customer_profiles(tenant_id,connection_id,external_id,id,display_name,email,phone,address,state,
        source_created_at,order_count,amount_spent,currency,tags,contact_shared,address_shared,source_updated_at,
        observed_at,observation_id)
       VALUES($1,$2,$3,$4,$5,$6,NULL,NULL,$9,$7,2,$10,'EUR','{}',true,false,NULL,now(),$8)`,
      [
        f.org.id,
        source.store,
        externalId,
        id,
        name,
        `${externalId.split('/').at(-1)}@example.test`,
        timestamp,
        randomUUID(),
        state,
        spent,
      ],
    );

    return id;
  };
  const averyId = await profile(customerId, 'Avery Tan');
  const otherAveryId = await profile('gid://shopify/Customer/72', 'Avery Tan', {
    state: 'disabled',
    spent: '20.00',
  });
  // Sync records which source customer placed each order.
  await f.db.owner.query(
    `INSERT INTO customer_orders(tenant_id,connection_id,order_scope_key,order_external_id,customer_external_id,observed_at)
     VALUES($1,$2,'',$3,$4,now())`,
    [f.org.id, source.store, 'gid://shopify/Order/2001', customerId],
  );

  // The order's live source details link to the source customer, which opens the imported profile.
  await page.goto(`/app/${f.org.id}/orders/${orderId}`);
  await page.getByRole('button', { name: 'More order actions' }).click();
  await page.getByRole('menuitem', { name: /^Live .* details$/ }).click();
  await page.getByRole('link', { name: 'Open customer in Luma' }).click();
  await page.waitForURL(`**/customers/${averyId}`);
  await page.getByRole('heading', { name: 'Avery Tan', level: 1 }).waitFor();
  await page.getByText('71@example.test', { exact: true }).waitFor();
  await page.getByRole('link', { name: '#2001', exact: true }).waitFor();
  await page.screenshot({
    path: '/tmp/luma-customer-desktop.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: '/tmp/luma-customer-mobile.png',
    fullPage: true,
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({
    path: '/tmp/luma-customer-dark.png',
    fullPage: true,
  });

  // An order opened from the history returns to the customer.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByRole('link', { name: '#2001', exact: true }).click();
  await page.waitForURL(`**/orders/${orderId}**`);
  await page.getByRole('link', { name: 'Back to previous page' }).click();
  await page.waitForURL(`**/customers/${averyId}`);
  await page.getByRole('link', { name: '#2001', exact: true }).waitFor();
  expect(requests.every((input) => input.kind === 'Order')).toBe(true);

  // The same-name customer of the same store placed no imported order.
  await page.goto(`/app/${f.org.id}/customers/${otherAveryId}`);
  await page.getByRole('heading', { name: 'No orders yet' }).waitFor();
  expect(
    await page.getByRole('link', { name: '#2001', exact: true }).count(),
  ).toBe(0);

  // The list keeps same-name customers apart and search text out of the URL.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page
    .getByRole('navigation', { name: 'Breadcrumb' })
    .getByRole('link', { name: 'Customers' })
    .click();
  await page.getByRole('link', { name: 'Avery Tan' }).first().waitFor();
  await page.getByRole('searchbox', { name: 'Search customers' }).fill('72@');
  await page.keyboard.press('Enter');
  await page.getByText('72@example.test', { exact: true }).waitFor();
  // The previous rows stay until the search's rows arrive.
  await expect(page.getByText('71@example.test', { exact: true })).toHaveCount(
    0,
  );
  // Only the query string could carry search text; ports and IDs may contain the digits.
  expect(decodeURIComponent(new URL(page.url()).search)).not.toContain('72@');
  await page.screenshot({
    path: '/tmp/luma-customers-list.png',
    fullPage: true,
  });

  // A link's search is adopted and leaves the address.
  await page.goto(`/app/${f.org.id}/customers?q=72%40`);
  await page.waitForURL((url) => !url.searchParams.has('q'));
  expect(
    await page
      .getByRole('searchbox', { name: 'Search customers' })
      .inputValue(),
  ).toBe('72@');
  await page.getByText('72@example.test', { exact: true }).waitFor();
  // The previous rows stay until the search's rows arrive.
  await expect(page.getByText('71@example.test', { exact: true })).toHaveCount(
    0,
  );

  // A condition, a sort and a grouping become a personal view that opens again later.
  await page.goto(`/app/${f.org.id}/customers?view=all`);
  await page.getByText('71@example.test', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Add a filter' }).click();
  const picker = page.getByRole('dialog', { name: 'Add a filter' });
  await picker.getByRole('searchbox', { name: 'Find a field' }).fill('Amount');
  await picker
    .getByRole('button', { name: 'Amount spent', exact: true })
    .click();
  const spent = page.getByRole('dialog', { name: 'Amount spent' });
  await spent.getByRole('combobox', { name: 'Condition' }).click();
  await page.getByRole('option', { name: 'is not empty' }).click();
  await spent.getByRole('button', { name: 'Apply filter' }).click();
  await page
    .getByRole('button', { name: 'Edit filter: Amount spent is not empty' })
    .waitFor();
  expect(JSON.parse(new URL(page.url()).searchParams.get('where'))).toEqual({
    match: 'all',
    conditions: [{ field: 'spent', op: 'not_empty' }],
  });
  const spentHeader = page.getByRole('columnheader', { name: /Amount spent/ });
  await spentHeader
    .getByRole('button', { name: 'Amount spent', exact: true })
    .click();
  await expect(spentHeader).toHaveAttribute('aria-sort', 'descending');
  await expect(page.locator('tbody tr').first()).toContainText(
    '71@example.test',
  );
  await page.getByRole('button', { name: 'Display' }).click();
  await page.getByRole('combobox', { name: 'Group by' }).click();
  await page.getByRole('option', { name: 'Account', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Has account/ }).waitFor();
  await page.getByRole('button', { name: /^No account/ }).waitFor();
  await page.getByText('Modified', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Save as new view' }).click();
  const save = page.getByRole('dialog', { name: 'Save as new view' });
  await save.getByLabel('Name').fill('Spenders by account');
  await save.getByRole('button', { name: 'Save', exact: true }).click();
  await page
    .getByRole('tab', {
      name: 'Spenders by account',
      exact: true,
      selected: true,
    })
    .waitFor();
  await page.waitForURL((url) =>
    /^[0-9a-f-]{36}$/.test(url.searchParams.get('view') ?? ''),
  );
  const viewId = new URL(page.url()).searchParams.get('view');
  await page.screenshot({
    path: '/tmp/luma317-customers-view.png',
    fullPage: true,
  });

  // Opening Customers without a view returns to the remembered one, and a customer's
  // breadcrumb returns to it too.
  await page.waitForTimeout(1500);
  await page.goto(`/app/${f.org.id}/customers`);
  await page.waitForURL((url) => url.searchParams.get('view') === viewId);
  await page
    .getByRole('button', { name: 'Edit filter: Amount spent is not empty' })
    .waitFor();
  await page.getByRole('button', { name: /^No account/ }).waitFor();
  await page.getByRole('link', { name: 'Avery Tan' }).first().click();
  await page.getByRole('heading', { name: 'Avery Tan', level: 1 }).waitFor();
  await page
    .getByRole('navigation', { name: 'Breadcrumb' })
    .getByRole('link', { name: 'Customers' })
    .click();
  await page.waitForURL(
    (url) =>
      url.pathname.endsWith('/customers') &&
      url.searchParams.get('view') === viewId,
  );
  await page.getByRole('button', { name: /^Has account/ }).waitFor();

  // A source customer Luma has not imported says so instead of guessing.
  await page.goto(
    `/app/${f.org.id}/customers?${new URLSearchParams({ connectionId: source.store, customerId: 'gid://shopify/Customer/999' })}`,
  );
  await page.getByText('This customer isn’t in Luma yet.').waitFor();

  const other = await f.request(
    f.owner,
    '/v1/organizations',
    'POST',
    { name: 'Other workspace', slug: `customer-other-${Date.now()}` },
    201,
  );
  await addMembership(f.db.owner, other.id, f.member.id, 'member');
  await page.goto(`/app/${other.id}/customers`);
  await page
    .getByRole('heading', { name: 'Customers aren’t shared yet' })
    .waitFor();
  expect(await page.getByText('Avery Tan', { exact: true }).count()).toBe(0);
  await page.goto(`/app/${other.id}/customers/${averyId}`);
  await page.getByRole('heading', { name: 'Customer not found' }).waitFor();
  await page.goto(`/app/${f.org.id}/customers`);
  await page.getByRole('link', { name: 'Avery Tan' }).first().waitFor();
  await context.clearCookies();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForURL('**/sign-in**');
  expect(await page.getByText('Avery Tan', { exact: true }).count()).toBe(0);
  expect(errors).toEqual([]);
});

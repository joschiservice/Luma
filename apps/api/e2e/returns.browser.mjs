/* global document */
import { randomUUID } from 'node:crypto';

import { createObservability } from '@luma/platform/composition';

import { expect, test } from './browser-fixtures.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { returnsFixture } from './returns-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

test('opens a return from its order, tells pending work from money returned and filters by stage', async ({
  resources: t,
}) => {
  const port = await availablePort(),
    origin = `http://127.0.0.1:${port}`;
  // Saved views are behind a release flag.
  const observability = createObservability({
    environment: 'test',
    release: 'test',
    sampleRate: 0,
    featureFlagOverrides: { 'adaptive-saved-views': true },
  });
  const f = await settingsFixture(t, origin, { observability });
  const r = await returnsFixture(t, f);
  const casesPath = `${f.base}/orders/${r.orders[1002]}/return-cases`;
  const options = await f.request(f.owner, casesPath);
  const line = options.sources.find((source) => source.connectionId === r.store)
    .lines[0];
  let service = await f.request(f.owner, casesPath, 'POST', {
    id: randomUUID(),
    connectionId: r.store,
    sourceReturnId: r.returns.received,
    lines: [
      {
        orderLineId: line.orderLineId,
        quantity: 2,
        reason: 'defective',
        note: null,
      },
    ],
  });
  service = await f.request(
    f.owner,
    `${f.base}/return-cases/${service.case.id}/receipt`,
    'POST',
    {
      commandId: randomUUID(),
      expectedRevision: 1,
      lines: [{ orderLineId: line.orderLineId, received: 2 }],
      evidence: { note: 'Warehouse received both items', link: null },
    },
  );
  const customerId = randomUUID();
  await f.db.owner.query(
    `INSERT INTO customer_profiles(tenant_id,connection_id,external_id,id,state,contact_shared,address_shared,observed_at,observation_id) VALUES($1,$2,'customer-1002',$3,'enabled',false,false,now(),$4)`,
    [f.org.id, r.store, customerId, randomUUID()],
  );
  await f.db.owner.query(
    `INSERT INTO customer_orders(tenant_id,connection_id,order_scope_key,order_external_id,customer_external_id,observed_at) VALUES($1,$2,'','gid://shopify/Order/1002','customer-1002',now())`,
    [f.org.id, r.store],
  );
  const now = new Date().toISOString();
  await r.refund('2001', 1002, true, [{ status: 'failed' }], now);
  await r.refund('2002', 1002, true, [{ status: 'pending' }], now);
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
    // Screenshots switch themes; without transitions they show the settled colors.
    reducedMotion: 'reduce',
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
  const screenshot = async (name) => {
    await page.screenshot({
      path: `/tmp/luma103-${name}-light.png`,
      fullPage: true,
    });
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.screenshot({
      path: `/tmp/luma103-${name}-dark.png`,
      fullPage: true,
    });
    await page.evaluate(() =>
      document.documentElement.classList.remove('dark'),
    );
  };

  // The order lists its returns; the pending refund is not money returned.
  await page.goto(`/app/${f.org.id}/orders/${r.orders[1002]}`);
  const section = page.getByRole('region', { name: 'Returns and refunds' });
  await section.getByText('#1002-R1').waitFor();
  expect(await section.innerText()).toContain('€48.00 processing');
  await section.getByRole('link', { name: /#1002-R1/ }).click();
  await page.getByRole('heading', { name: '#1002-R1', level: 1 }).waitFor();
  await page.getByRole('heading', { name: 'Refund processing' }).waitFor();
  const money = page.getByRole('region', { name: 'Money' });
  expect(await money.innerText()).toMatch(
    /Refunded to the customer\s+Nothing yet/,
  );
  expect(await money.innerText()).toContain('€48.00');
  const progress = page.getByRole('list', { name: 'Return progress' });
  expect(await progress.innerText()).toContain('2 of 2 units received');
  await page
    .getByRole('region', { name: 'Refunds' })
    .getByText('Failed', { exact: true })
    .first()
    .waitFor();
  await screenshot('detail');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: '/tmp/luma103-detail-mobile.png',
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('link', { name: 'Back to previous page' }).click();
  await page.waitForURL(`**/orders/${r.orders[1002]}*`);

  // The list opens on pending work and names the source that does not share returns.
  await page.goto(`/app/${f.org.id}/returns`);
  await page.getByRole('heading', { name: 'Returns', exact: true }).waitFor();
  await page.getByRole('link', { name: '#1001-R1', exact: true }).waitFor();
  await page.getByText(/JTL-Wawi doesn’t share returns with Luma/).waitFor();
  expect(
    await page.getByRole('link', { name: '#1003-R1', exact: true }).count(),
  ).toBe(0);
  await screenshot('list');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: '/tmp/luma103-list-mobile.png',
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });

  // A stage card is a condition in the address; a waiting stage opens All returns.
  const stageWhere = {
    match: 'all',
    conditions: [{ field: 'stage', op: 'any_of', value: ['refund_pending'] }],
  };
  await page.getByRole('button', { name: /^Refund processing/ }).click();
  await page.getByRole('link', { name: '#1002-R1', exact: true }).waitFor();
  expect(new URL(page.url()).searchParams.get('view')).toBe('all');
  expect(JSON.parse(new URL(page.url()).searchParams.get('where'))).toEqual(
    stageWhere,
  );
  // Other stages keep their counts while one is chosen.
  await expect(
    page.getByRole('button', { name: /^Refund processing/ }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('button', { name: /^To review/ }).locator('strong'),
  ).toHaveText('1');
  await page.getByRole('link', { name: '#1002-R1', exact: true }).click();
  await page.getByRole('heading', { name: '#1002-R1', level: 1 }).waitFor();
  await page
    .getByRole('navigation', { name: 'Breadcrumb' })
    .getByRole('link', { name: 'Returns' })
    .click();
  await page.waitForURL((url) => url.pathname.endsWith('/returns'));
  expect(JSON.parse(new URL(page.url()).searchParams.get('where'))).toEqual(
    stageWhere,
  );

  // Home's stage rows from before views still open the same stage.
  await page.goto(`/app/${f.org.id}/returns?view=all&stage=refund_pending`);
  await page.waitForURL((url) => !url.searchParams.has('stage'));
  expect(JSON.parse(new URL(page.url()).searchParams.get('where'))).toEqual(
    stageWhere,
  );

  // Search finds the refund without a return by its source ID.
  await page.goto(`/app/${f.org.id}/returns?view=all`);
  const search = page.getByRole('searchbox', { name: 'Search returns' });
  await search.fill('gid://shopify/Refund/2003');
  await search.press('Enter');
  await page.getByText('Refund without a return', { exact: false }).waitFor();
  // Search can match customer names, so it stays out of the address.
  expect(new URL(page.url()).searchParams.has('q')).toBe(false);
  await search.fill('nothing');
  await search.press('Enter');
  await page
    .getByRole('heading', { name: 'No returns match these filters' })
    .waitFor();

  // A link's search is adopted and leaves the address.
  await page.goto(`/app/${f.org.id}/returns?view=all&q=%231002-R1`);
  await page.waitForURL((url) => !url.searchParams.has('q'));
  expect(await search.inputValue()).toBe('#1002-R1');
  await page.getByRole('link', { name: '#1002-R1', exact: true }).waitFor();
  expect(
    await page.getByRole('link', { name: '#1001-R1', exact: true }).count(),
  ).toBe(0);

  // A preview value becomes a condition, and a board by stage becomes a saved view.
  await page.goto(`/app/${f.org.id}/returns?view=all`);
  await page.getByRole('link', { name: '#1001-R1', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Display' }).click();
  await page
    .getByRole('checkbox', { name: 'Open records in a preview' })
    .check();
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: '#1002-R1', exact: true }).click();
  const preview = page.getByRole('region', { name: 'Return preview' });
  await preview.getByRole('button', { name: 'Filter by Defective' }).click();
  await page.getByRole('menuitem', { name: 'Show only this value' }).click();
  await page.waitForURL((url) => url.searchParams.has('where'));
  expect(JSON.parse(new URL(page.url()).searchParams.get('where'))).toEqual({
    match: 'all',
    conditions: [{ field: 'reasons', op: 'any_of', value: ['Defective'] }],
  });
  await expect(
    page.getByRole('link', { name: '#1001-R1', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Close preview' }).click();
  await page.getByRole('button', { name: 'Display' }).click();
  await page.getByRole('combobox', { name: 'Group by' }).click();
  await page.getByRole('option', { name: 'Stage', exact: true }).click();
  // The layout choice is a labelled segment; its radio input is visually hidden.
  await page
    .getByRole('dialog', { name: 'Display options' })
    .getByText('Board', { exact: true })
    .click();
  await expect(page.getByRole('radio', { name: 'Board' })).toBeChecked();
  await page.keyboard.press('Escape');
  await page.getByRole('region', { name: /^Refund processing/ }).waitFor();
  // The store owns the stage, so cards never move between columns.
  expect(await page.getByRole('button', { name: 'Move to…' }).count()).toBe(0);
  await page.getByRole('button', { name: 'Save as new view' }).click();
  const save = page.getByRole('dialog', { name: 'Save as new view' });
  await save.getByLabel('Name').fill('Defective by stage');
  await save.getByRole('button', { name: 'Save', exact: true }).click();
  await page
    .getByRole('tab', {
      name: 'Defective by stage',
      exact: true,
      selected: true,
    })
    .waitFor();
  await page.waitForURL((url) =>
    /^[0-9a-f-]{36}$/.test(url.searchParams.get('view') ?? ''),
  );
  const viewId = new URL(page.url()).searchParams.get('view');
  await screenshot('board');
  await page.waitForTimeout(1500);
  await page.goto(`/app/${f.org.id}/returns`);
  await page.waitForURL((url) => url.searchParams.get('view') === viewId);
  await page.getByRole('region', { name: /^Refund processing/ }).waitFor();
  expect(
    await page.getByRole('link', { name: '#1001-R1', exact: true }).count(),
  ).toBe(0);

  // G then T opens Returns from anywhere in the workspace.
  await page.goto(`/app/${f.org.id}/orders/${r.orders[1001]}`);
  await page
    .getByRole('region', { name: 'Returns and refunds' })
    .getByText('#1001-R1')
    .waitFor();
  await page.keyboard.press('g');
  await page.keyboard.press('t');
  await page.waitForURL(`**/app/${f.org.id}/returns*`);
  // The case combines source payments with the separately recorded warehouse receipt.
  await page.goto(`/app/${f.org.id}/orders/${r.orders[1002]}`);
  await page.getByRole('link', { name: /Return case/ }).click();
  await page
    .getByRole('heading', { name: 'Return case for order #1002', level: 1 })
    .waitFor();
  const summary = page.getByRole('region', {
    name: 'What you can tell the customer',
  });
  await expect(summary).toContainText('Payment still processing');
  await expect(summary).toContainText('€48.00');
  await expect(summary).toContainText(/Observed money returned\s*Not reported/);
  const timeline = page.getByRole('region', { name: 'Return timeline' });
  await expect(timeline).toContainText('Warehouse received both items');
  await expect(timeline).toContainText('Refund payment pending');
  await expect(timeline).toContainText('Luma decision');
  await screenshot('service');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: '/tmp/luma193-service-mobile.png',
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.goto(`/app/${f.org.id}/customers/${customerId}`);
  await page
    .getByRole('region', { name: 'Return cases' })
    .getByRole('link', { name: /Return case for order #1002/ })
    .click();
  await page.waitForURL(`**/returns/cases/${service.case.id}`);

  // Keyboard search reaches the same authoritative case review.
  await page.keyboard.press('Meta+k');
  const workspaceSearch = page.getByRole('textbox', {
    name: 'Search workspace',
  });
  await workspaceSearch.fill(service.case.id);
  await page
    .getByRole('navigation', { name: 'Search results' })
    .getByRole('link', { name: /Return case for order #1002/ })
    .focus();
  await page.keyboard.press('Enter');
  await page.waitForURL(`**/returns/cases/${service.case.id}`);

  await page.goto(
    `/app/${f.org.id}/needs-you?item=return-case:${service.case.id}`,
  );
  await page
    .getByRole('link', { name: 'Open return case', exact: true })
    .first()
    .click();
  await page.waitForURL(`**/returns/cases/${service.case.id}`);
  expect(errors).toEqual([]);
});

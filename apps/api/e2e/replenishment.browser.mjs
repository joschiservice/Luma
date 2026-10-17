/* global document */
import { processWorkflowId } from '@luma/workflow-temporal';

import { expect, test } from './browser-fixtures.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { replenishmentFixture } from './replenishment-fixture.mjs';

test('reviews replenishment scope, recovers a lost response, approves and opens the verified order', async ({
  resources: t,
}) => {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const f = await replenishmentFixture(t, origin);
  const web = startProcess(
    t,
    'e2e/web-server.mjs',
    { TEST_API_ORIGIN: f.apiOrigin, TEST_WEB_PORT: String(port) },
    true,
  );
  await web.message('listening');
  const contextFor = async (cookie) => {
    const context = await t.newContext({
      baseURL: origin,
      viewport: { width: 1440, height: 1000 },
    });
    await context.addCookies(
      cookie.split('; ').map((value) => {
        const [name, ...rest] = value.split('=');

        return { name, value: rest.join('='), url: origin };
      }),
    );

    return context;
  };
  const requester = await contextFor(f.ownerCookie);
  const page = await requester.newPage();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const path = `/app/${f.manifest.organizationId}/workflows/inventory-replenishment`;
  await page.goto(path);
  // Replenishment is set up through its stock rules, so it opens there while it's off.
  await page
    .getByRole('tab', { name: 'Stock rules', selected: true })
    .waitFor();
  await page.getByText('Off', { exact: true }).first().waitFor();
  await page
    .getByRole('button', { name: 'Add stock rules', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Supplier', exact: true }).click();
  await page.getByRole('option', { name: 'Northstar Supply' }).click();
  await dialog.getByLabel('Filter stock positions').fill(f.position.sku);
  // A SKU can come from several sources; pick the configured connection's position.
  const sku = f.position.sku.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await dialog
    .getByRole('checkbox', {
      name: new RegExp(`${sku}.*source ${f.position.connectionId.slice(0, 8)}`),
    })
    .check();
  await dialog
    .getByLabel('Minimum stock', { exact: true })
    .fill(String(f.position.available + 10));
  await dialog
    .getByLabel('Target stock', { exact: true })
    .fill(String(f.position.available + 50));
  await dialog.getByLabel('High-risk quantity threshold').fill('20');
  await dialog.getByRole('button', { name: 'Preview 1 rule' }).click();
  await dialog.getByText('Will activate', { exact: true }).waitFor();
  await dialog
    .getByText(
      'Someone else who can approve changes approves every purchase-order draft before Luma acts.',
    )
    .waitFor();
  await page.screenshot({
    path: '/tmp/luma76-setup-preview.png',
    fullPage: false,
  });
  await page.route(
    '**/replenishment/activations/batch',
    async (route) => {
      await route.fetch();
      await route.abort('failed');
    },
    { times: 1 },
  );
  await dialog.getByRole('button', { name: 'Activate 1 rule' }).click();
  await dialog.getByRole('button', { name: 'Retry activation' }).click();
  await dialog.getByText('1 activated', { exact: true }).waitFor();
  expect((await f.request('/replenishment')).rules).toHaveLength(1);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByText('On', { exact: true }).first().waitFor();
  await page.getByText('Watching', { exact: true }).waitFor();
  await page.screenshot({
    path: '/tmp/luma71-replenishment-desktop.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Check stock now' }).click();
  await page.getByText('Stock checked.', { exact: false }).waitFor();
  const run = (await f.request('/runs')).items[0];
  await f.waitFor(run.id, 'awaiting_decision');
  await page.goto(`/app/${f.manifest.organizationId}/procurement`);
  await page
    .getByRole('link', { name: '1 proposal waiting for approval', exact: true })
    .click();
  await expect(
    page.getByText('Waiting on others', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Waiting for another approver', { exact: true }),
  ).toBeVisible();
  await page.goto(path);
  await page.getByRole('tab', { name: /^Runs/, selected: true }).waitFor();
  await page
    .getByRole('heading', { name: new RegExp(`50 × ${sku}$`) })
    .waitFor();
  await page.getByLabel('Cost and demand at proposal time').waitFor();
  await page.getByText('Unit cost', { exact: true }).waitFor();
  await page.getByText('Estimated order value', { exact: true }).waitFor();
  expect(
    await page.getByRole('button', { name: 'Approve 50 units' }).count(),
  ).toBe(0);
  const approver = await contextFor(f.approverCookie);
  const review = await approver.newPage();
  await review.goto(path);
  // The waiting decision is the next step on every tab.
  await review
    .getByText('Review 1 waiting decision', { exact: true })
    .waitFor();
  expect(
    await review
      .getByRole('link', { name: 'Review the waiting decision' })
      .first()
      .getAttribute('href'),
  ).toContain(`item=replenishment%3A${run.id}`);
  // Needs you: the proposal opens the stock read, rule and policy decision it rests on, read
  // only when opened.
  let evidenceReads = 0;
  review.on('request', (request) => {
    if (request.url().endsWith('/evidence/resolve')) evidenceReads += 1;
  });
  await review.goto(
    `/app/${f.manifest.organizationId}/needs-you?item=${encodeURIComponent(`replenishment:${run.id}`)}`,
  );
  const cites = review.getByText('What this decision cites', { exact: true });
  await expect(cites).toBeVisible();
  expect(evidenceReads).toBe(0);
  await cites.click();
  const runEvidence = review.getByRole('list', { name: 'Cited evidence' });
  await expect(runEvidence.getByText(/^Read from /).first()).toBeVisible();
  await expect(
    runEvidence.getByText('Available', { exact: true }).first(),
  ).toBeVisible();
  for (const record of [
    'Replenishment rule',
    'Proposed purchase-order draft',
    'Policy decision',
    'Supplier',
  ])
    await expect(
      runEvidence.getByText(record, { exact: true }).first(),
    ).toBeVisible();
  await expect(runEvidence.getByText('Not found')).toHaveCount(0);
  expect(evidenceReads).toBe(1);
  await review.goto(path);
  await review.getByRole('tab', { name: /^Runs/, selected: true }).waitFor();
  await review.getByRole('button', { name: 'Approve 50 units' }).click();
  await review.getByText('Decision recorded.', { exact: false }).waitFor();
  await f.temporal.client.workflow
    .getHandle(processWorkflowId(f.manifest.organizationId, run.id))
    .signal('processDecisionChanged');
  await f.waitFor(run.id, 'verified');
  await review
    .getByRole('button', { name: 'Refresh runs', exact: true })
    .click();
  await review
    .getByText('The expected result was verified.', { exact: true })
    .waitFor();
  await review.getByText('Draft verified', { exact: true }).waitFor();
  await review.getByText('Approved', { exact: true }).waitFor();
  await review.getByLabel('Recorded stock context').waitFor();
  await review.screenshot({
    path: '/tmp/luma74-run-desktop.png',
    fullPage: true,
  });
  await review.setViewportSize({ width: 375, height: 812 });
  expect(
    await review
      .locator('.replenishment-metrics dd')
      .evaluateAll((values) =>
        values.every((value) => value.scrollWidth <= value.clientWidth),
      ),
  ).toBe(true);
  await review
    .getByText('Draft verified', { exact: true })
    .scrollIntoViewIfNeeded();
  await review.screenshot({
    path: '/tmp/luma74-run-mobile.png',
    fullPage: true,
  });
  expect(
    await review.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await review.getByRole('link', { name: 'View run activity' }).click();
  await review
    .getByRole('link', { name: /^Replenish low stock\..*Verified/ })
    .click();
  // The run's steps, including the purchase order it created, show beside the list.
  const event = review.getByRole('region', { name: 'Event details' });
  await event
    .locator('.activity-steps li')
    .filter({ hasText: 'Purchase order created' })
    .first()
    .waitFor();
  await event.getByRole('link', { name: 'Open Workflow', exact: true }).click();
  await review.getByRole('link', { name: 'Open purchase order' }).click();
  await review.getByText('Northstar Supply', { exact: true }).first().waitFor();
  // The stock record shows the same readiness and returns to the original context.
  await page.getByRole('tab', { name: 'Stock rules' }).click();
  await page.getByRole('link', { name: 'Stock record' }).first().click();
  const coverage = page.getByRole('region', { name: 'Replenishment' });
  await coverage.getByText('Running', { exact: true }).waitFor();
  await coverage.getByText('Northstar Supply', { exact: true }).waitFor();
  await page.screenshot({
    path: '/tmp/luma76-stock-record.png',
    fullPage: true,
  });
  await page.getByRole('link', { name: 'Back to previous page' }).click();
  await page.waitForURL(`**${path}*`);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole('tab', { name: 'Stock rules' }).click();
  await page.getByText('Watching', { exact: true }).first().waitFor();
  await page.screenshot({
    path: '/tmp/luma71-replenishment-mobile.png',
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
}, 120000);

test('keeps selections across stock pages and server search in narrow and dark layouts', async ({
  resources: t,
}) => {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const f = await replenishmentFixture(t, origin);
  const setup = await f.request('/replenishment');
  const first = setup.positions[0];
  const second = setup.positions.find(
    (p) => p.positionId !== first.positionId && p.sku !== first.sku,
  );
  expect(second).toBeTruthy();
  const web = startProcess(
    t,
    'e2e/web-server.mjs',
    { TEST_API_ORIGIN: f.apiOrigin, TEST_WEB_PORT: String(port) },
    true,
  );
  await web.message('listening');
  const context = await t.newContext({
    baseURL: origin,
    viewport: { width: 390, height: 844 },
  });
  await context.addCookies(
    f.ownerCookie.split('; ').map((value) => {
      const [name, ...rest] = value.split('=');

      return { name, value: rest.join('='), url: origin };
    }),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  // A short first page makes continuation and retained selection observable with the fixed merchant fixture.
  await page.route('**/replenishment{,?*}', async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch();
    const body = await response.json();
    if (
      !url.searchParams.get('q') &&
      !url.searchParams.has('cursor') &&
      !url.searchParams.has('positionId')
    ) {
      body.positions = body.positions.slice(0, 1);
      body.nextCursor = `${first.positionId}:${first.connectionId}`;
    }
    await route.fulfill({ response, json: body });
  });
  await page.goto(`/app/${f.actor.tenantId}/workflows/inventory-replenishment`);
  await page
    .getByRole('button', { name: 'Add stock rules', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('checkbox').first().check();
  await dialog
    .getByRole('navigation', { name: 'Stock position pages' })
    .getByRole('button', { name: 'Next', exact: true })
    .click();
  const escaped = second.sku.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await dialog
    .getByRole('checkbox', {
      name: new RegExp(`${escaped}.*source ${second.connectionId.slice(0, 8)}`),
    })
    .check();
  await expect(dialog.getByText('2 of 25 selected')).toBeVisible();
  await dialog.getByLabel('Filter stock positions').fill('no-such-sku');
  await expect(dialog.getByText('No SKU matches “no-such-sku”.')).toBeVisible();
  await expect(dialog.getByRole('checkbox', { checked: true })).toHaveCount(2);
  await expect(
    dialog.getByRole('button', { name: 'Next', exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole('button', { name: 'Previous', exact: true }),
  ).toBeDisabled();
  await page.screenshot({ path: '/tmp/luma-replenishment-paging-narrow.png' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: '/tmp/luma-replenishment-paging-dark.png' });
  await dialog.getByRole('combobox', { name: 'Supplier', exact: true }).click();
  await page.getByRole('option', { name: 'Northstar Supply' }).click();
  await dialog.getByRole('button', { name: 'Preview 2 rules' }).click();
  await expect(dialog.getByText('Will activate', { exact: true })).toHaveCount(
    2,
  );
  await expect(
    dialog
      .getByRole('list', { name: 'Rules to activate' })
      .getByRole('listitem'),
  ).toHaveCount(2);
});

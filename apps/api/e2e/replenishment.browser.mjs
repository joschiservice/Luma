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
  await page
    .getByRole('button', { name: 'Add stock rule', exact: true })
    .click();
  await page.getByRole('combobox', { name: 'Stock position' }).click();
  await page
    .getByRole('option')
    .filter({ hasText: f.position.connectionId.slice(0, 8) })
    .filter({ hasText: `${f.position.sku} ·` })
    .click();
  await page.getByRole('combobox', { name: 'Supplier', exact: true }).click();
  await page.getByRole('option', { name: 'Northstar Supply' }).click();
  await page
    .getByLabel('Minimum stock', { exact: true })
    .fill(String(f.position.available + 10));
  await page
    .getByLabel('Target stock', { exact: true })
    .fill(String(f.position.available + 50));
  await page.getByLabel('High-risk quantity threshold').fill('20');
  await page.route(
    '**/replenishment/activations',
    async (route) => {
      await route.fetch();
      await route.abort('failed');
    },
    { times: 1 },
  );
  await page.getByRole('button', { name: 'Activate reviewed rule' }).click();
  await page.getByRole('button', { name: 'Retry activation' }).waitFor();
  expect(
    await page.getByLabel('Minimum stock', { exact: true }).isDisabled(),
  ).toBe(true);
  await page.getByRole('button', { name: 'Retry activation' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  expect((await f.request('/replenishment')).rules).toHaveLength(1);
  await page.getByRole('button', { name: 'Stock rules', exact: true }).click();
  await page.screenshot({
    path: '/tmp/luma71-replenishment-desktop.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Check stock now' }).click();
  await page.getByText('Stock checked.', { exact: false }).waitFor();
  const run = (await f.request('/runs')).items[0];
  await f.waitFor(run.id, 'awaiting_decision');
  await page.getByRole('button', { name: 'Recent runs', exact: true }).click();
  await page.getByRole('heading', { name: `50 × ${f.position.sku}` }).waitFor();
  expect(
    await page.getByRole('button', { name: 'Approve 50 units' }).count(),
  ).toBe(0);
  const approver = await contextFor(f.approverCookie);
  const review = await approver.newPage();
  await review.goto(path);
  await review
    .getByRole('button', { name: 'Recent runs', exact: true })
    .click();
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
  await review.getByText('approved', { exact: true }).waitFor();
  await review.getByLabel('Recorded stock context').waitFor();
  await review.screenshot({
    path: '/tmp/luma74-run-desktop.png',
    fullPage: true,
  });
  await review.setViewportSize({ width: 375, height: 812 });
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
    .getByText('Purchase order created', { exact: true })
    .first()
    .waitFor();
  await review.goBack();
  await review.getByRole('link', { name: 'Inspect purchase order' }).click();
  await review.getByText('Northstar Supply', { exact: true }).first().waitFor();
  await page.setViewportSize({ width: 375, height: 812 });
  await page
    .getByRole('region', { name: 'Stock rules', exact: true })
    .scrollIntoViewIfNeeded();
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

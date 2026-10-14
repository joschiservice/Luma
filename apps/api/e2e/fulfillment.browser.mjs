/* global document */
import { createObservability } from '@luma/platform/composition';

import { expect, test } from './browser-fixtures.mjs';
import { fulfillmentFixture } from './fulfillment-fixture.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { settingsFixture } from './settings-fixture.mjs';

test('finds a held fulfillment, explains the next safe step and follows its order', async ({
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
  const work = await fulfillmentFixture(t, f);
  await work.issue();
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

  // G then F opens the workspace on what needs attention, longest wait first.
  await page.goto(`/app/${f.org.id}/home`);
  await page.getByRole('heading', { level: 1 }).first().waitFor();
  await page.keyboard.press('g');
  await page.keyboard.press('f');
  await page.waitForURL(`**/app/${f.org.id}/fulfillment`);
  await page
    .getByRole('heading', { name: 'Fulfillment', exact: true })
    .waitFor();
  const table = page.getByRole('table', { name: /^Needs attention/ });
  await table.getByRole('link', { name: '#201', exact: true }).waitFor();
  expect(await table.getByRole('row').count()).toBe(4);
  await expect(table).toContainText('Held: Incorrect address.');
  await expect(table).toContainText('Delivery attempted · 4521-8876-0012.');
  await page.screenshot({
    path: '/tmp/luma102-list-light.png',
    fullPage: true,
  });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.screenshot({ path: '/tmp/luma102-list-dark.png', fullPage: true });
  await page.evaluate(() => document.documentElement.classList.remove('dark'));

  // A tracking number search keeps the view in the address.
  await page.getByRole('tab', { name: /^All/ }).click();
  await page
    .getByRole('searchbox', { name: 'Search fulfillment' })
    .fill('4521-8876');
  await page.keyboard.press('Enter');
  // The previous rows stay until the search's rows arrive: only the shipment has that number.
  await expect(
    page.getByRole('link', { name: '#202', exact: true }),
  ).toHaveCount(1);
  const url = new URL(page.url());
  expect(url.searchParams.get('view')).toBe('all');
  expect(url.searchParams.get('q')).toBe('4521-8876');

  // The held work explains its cause, the next step and what counts as progress.
  await page.getByRole('tab', { name: /^On hold/ }).click();
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await page.getByRole('link', { name: '#200', exact: true }).click();
  await page
    .getByRole('heading', { name: 'On hold: Incorrect address' })
    .waitFor();
  await page
    .getByRole('heading', { name: 'Resolve the hold in Tokyo store' })
    .waitFor();
  await expect(page.getByText('Hold added: Incorrect address')).toHaveCount(2);
  await page.getByRole('link', { name: 'stuck fulfillment' }).waitFor();
  await page.screenshot({
    path: '/tmp/luma102-detail-light.png',
    fullPage: true,
  });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.screenshot({
    path: '/tmp/luma102-detail-dark.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: '/tmp/luma102-detail-mobile.png',
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  await page.setViewportSize({ width: 1440, height: 1000 });

  // The order links back to the same fulfillment.
  await page.getByRole('link', { name: '#200', exact: true }).click();
  await page.waitForURL(`**/orders/*`);
  await page
    .getByRole('region', { name: 'Fulfillments' })
    .getByRole('link')
    .first()
    .click();
  await page.waitForURL(`**/fulfillment/${work.ids.held}*`);
  await page
    .getByRole('heading', { name: 'On hold: Incorrect address' })
    .waitFor();
  await page.getByRole('link', { name: 'Back to previous page' }).click();
  await page.waitForURL(`**/orders/*`);

  // A condition, a sort and a grouping become a personal view that opens again later.
  await page.goto(`/app/${f.org.id}/fulfillment?view=all`);
  await page.getByRole('link', { name: '#203', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Add a filter' }).click();
  const picker = page.getByRole('dialog', { name: 'Add a filter' });
  await picker
    .getByRole('searchbox', { name: 'Find a field' })
    .fill('Fulfill by');
  await picker.getByRole('button', { name: 'Fulfill by', exact: true }).click();
  const deadline = page.getByRole('dialog', { name: 'Fulfill by' });
  await deadline.getByRole('combobox', { name: 'Condition' }).click();
  await page.getByRole('option', { name: 'is not empty' }).click();
  await deadline.getByRole('button', { name: 'Apply filter' }).click();
  await page
    .getByRole('button', { name: 'Edit filter: Fulfill by is not empty' })
    .waitFor();
  await expect(
    page.getByRole('link', { name: '#203', exact: true }),
  ).toHaveCount(0);
  const orderHeader = page.getByRole('columnheader', { name: /Order/ }).first();
  await orderHeader.getByRole('button', { name: 'Order', exact: true }).click();
  await expect(orderHeader).toHaveAttribute('aria-sort', 'ascending');
  expect(new URL(page.url()).searchParams.get('sort')).toBe('orderNumber');
  await page.getByRole('button', { name: 'Display' }).click();
  await page.getByRole('combobox', { name: 'Group by' }).click();
  await page.getByRole('option', { name: 'Status', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Waiting to start/ }).waitFor();
  await page.getByRole('button', { name: /^Completed/ }).waitFor();
  await page.getByText('Modified', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Save as new view' }).click();
  const save = page.getByRole('dialog', { name: 'Save as new view' });
  await save.getByLabel('Name').fill('Deadlines by status');
  await save.getByRole('button', { name: 'Save', exact: true }).click();
  await page
    .getByRole('button', { name: 'Deadlines by status', exact: true })
    .waitFor();
  await page.waitForURL((url) =>
    /^[0-9a-f-]{36}$/.test(url.searchParams.get('view') ?? ''),
  );
  const viewId = new URL(page.url()).searchParams.get('view');
  await page.screenshot({
    path: '/tmp/luma318-fulfillment-view.png',
    fullPage: true,
  });

  // Opening Fulfillment without a view returns to the remembered one.
  await page.waitForTimeout(1500);
  await page.goto(`/app/${f.org.id}/fulfillment`);
  await page.waitForURL((url) => url.searchParams.get('view') === viewId);
  await page
    .getByRole('button', { name: 'Edit filter: Fulfill by is not empty' })
    .waitFor();
  await page.getByRole('button', { name: /^Waiting to start/ }).waitFor();

  // List keys move through rows, and ? lists them.
  await page
    .locator('main')
    .first()
    .click({ position: { x: 4, y: 4 } });
  await page.keyboard.press('j');
  await expect(
    page.getByRole('link', { name: '#200', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('?');
  await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).waitFor();
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

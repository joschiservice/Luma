/* global document, window */
import { expect, test } from './browser-fixtures.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { seedMetricOrders } from './metrics-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

test('searches scoped records and returns from a metric to the same cohort', async ({
  resources: t,
}) => {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const fixture = await settingsFixture(t, origin);
  const seed = await seedMetricOrders(t, fixture);
  await seed(0);
  const records = await fixture.request(
    fixture.member,
    `${fixture.base}/records?q=order-0`,
  );
  expect(records.items).toHaveLength(1);
  expect(records.items[0]).toMatchObject({
    kind: 'order',
    label: '#1000',
    coverage: 'projected',
  });
  expect(
    (await fixture.request(fixture.member, `${fixture.base}/records?q=%231000`))
      .items,
  ).toHaveLength(1);
  await fixture.request(
    fixture.outsider,
    `${fixture.base}/records?q=order-0`,
    'GET',
    undefined,
    404,
  );
  await fixture.request(
    fixture.member,
    `${fixture.base}/records/order/${records.items[0].id}`,
    'GET',
  );
  await fixture.request(
    fixture.outsider,
    `${fixture.base}/records/order/${records.items[0].id}`,
    'GET',
    undefined,
    404,
  );

  const apiOrigin = await fixture.app.listen({ host: '127.0.0.1', port: 0 });
  const web = startProcess(
    t,
    'e2e/web-server.mjs',
    { TEST_API_ORIGIN: apiOrigin, TEST_WEB_PORT: String(port) },
    true,
  );
  await web.message('listening');
  const context = await t.newContext({
    baseURL: origin,
    viewport: { width: 1200, height: 900 },
  });
  await context.addCookies(
    fixture.member.cookie.split('; ').map((value) => {
      const [name, ...rest] = value.split('=');

      return { name, value: rest.join('='), url: origin };
    }),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/app/${fixture.org.id}/records`);
  await page
    .getByRole('heading', { name: 'All records', exact: true })
    .waitFor();
  await page.getByRole('link', { name: /#1000/ }).click();
  await page.getByRole('heading', { name: '#1000' }).waitFor();
  await page.getByRole('heading', { name: 'Data from sources' }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole('navigation', { name: 'Breadcrumb' })
    .getByRole('link', { name: 'All records' })
    .click();
  await page
    .getByRole('heading', { name: 'All records', exact: true })
    .waitFor();
  const search = page.getByRole('searchbox', { name: 'Search records' });
  await search.fill('#1000');
  await search.press('Enter');
  await page.getByRole('link', { name: /#1000/ }).waitFor();
  expect(
    await page
      .getByRole('table', { name: 'Matching records' })
      .locator('tbody tr')
      .count(),
  ).toBe(1);

  await page.goto(`/app/${fixture.org.id}/insights`);
  await page.locator('[data-metric="orders.open"]').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('link', { name: 'Open order' }).click();
  await page.getByRole('heading', { name: '#1000' }).waitFor();
  await page.getByRole('link', { name: 'Back to previous page' }).click();
  await dialog.getByRole('heading', { name: 'Open orders' }).waitFor();
  expect(errors).toEqual([]);
});

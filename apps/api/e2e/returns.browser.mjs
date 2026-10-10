/* global document */
import { expect, test } from './browser-fixtures.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { returnsFixture } from './returns-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

test('opens a return from its order, tells pending work from money returned and filters by stage', async ({
  resources: t,
}) => {
  const port = await availablePort(),
    origin = `http://127.0.0.1:${port}`;
  const f = await settingsFixture(t, origin);
  const r = await returnsFixture(t, f);
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

  // A stage card filters the list and is part of the address.
  await page.getByRole('button', { name: /^Refund processing/ }).click();
  await page.getByRole('link', { name: '#1002-R1', exact: true }).waitFor();
  expect(new URL(page.url()).searchParams.get('stage')).toBe('refund_pending');
  await page.getByRole('link', { name: '#1002-R1', exact: true }).click();
  await page.getByRole('heading', { name: '#1002-R1', level: 1 }).waitFor();
  await page
    .getByRole('navigation', { name: 'Breadcrumb' })
    .getByRole('link', { name: 'Returns' })
    .click();
  expect(new URL(page.url()).searchParams.get('stage')).toBe('refund_pending');

  // Search finds the refund without a return by its source ID.
  await page.goto(`/app/${f.org.id}/returns?view=all`);
  const search = page.getByRole('searchbox', { name: 'Search returns' });
  await search.fill('gid://shopify/Refund/2003');
  await search.press('Enter');
  await page.getByText('Refund without a return', { exact: false }).waitFor();
  await search.fill('nothing');
  await search.press('Enter');
  await page
    .getByRole('heading', { name: 'No returns match these filters' })
    .waitFor();

  // G then T opens Returns from anywhere in the workspace.
  await page.goto(`/app/${f.org.id}/orders/${r.orders[1001]}`);
  await page
    .getByRole('region', { name: 'Returns and refunds' })
    .getByText('#1001-R1')
    .waitFor();
  await page.keyboard.press('g');
  await page.keyboard.press('t');
  await page.waitForURL(`**/app/${f.org.id}/returns*`);
  expect(errors).toEqual([]);
});

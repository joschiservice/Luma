/* global document */
import { expect, test } from './browser-fixtures.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { correctionFixture } from './shopify-inventory-fixture.mjs';

test('reviews stock in Inventory, obtains approval, then verifies Shopify in both themes', async ({
  resources: t,
}) => {
  const port = await availablePort(),
    origin = `http://127.0.0.1:${port}`;
  const {
    f,
    admin,
    call,
    target,
    mutations,
    delayVerification,
    syncStock,
    changeAvailable,
  } = await correctionFixture(t, origin);
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
    f.owner.cookie.split('; ').map((value) => {
      const [name, ...rest] = value.split('=');

      return { name, value: rest.join('='), url: origin };
    }),
  );
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/app/${f.org.id}/inventory/${target.positionId}`);
  const panel = page.getByRole('region', { name: 'Shopify stock correction' });
  await expect(
    panel.getByText('12 → 9 available', { exact: true }),
  ).toBeVisible();
  await panel
    .getByRole('button', { name: 'Review correction', exact: true })
    .click();
  await expect(
    panel.getByText(
      'Someone else who can approve changes must approve this exact action.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    panel.getByRole('button', { name: 'Send to Shopify' }),
  ).toHaveCount(0);
  await page.reload();
  const inspection = await call(admin, 'inspect', target);
  await call(admin, 'approve', {
    id: inspection.runs[0].id,
    outcome: 'approved',
  });
  await panel.getByRole('button', { name: 'Check approval' }).click();
  delayVerification(true);
  await panel.getByRole('button', { name: 'Send to Shopify' }).click();
  await expect(
    panel.getByText('Shopify accepted', { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText('Quantity not verified', { exact: true }),
  ).toBeVisible();
  expect(mutations).toHaveLength(1);
  await page.screenshot({
    path: '/tmp/luma-106-stock-light.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(
    panel.getByRole('button', { name: 'Verify stock' }),
  ).toBeEnabled();
  await page.screenshot({
    path: '/tmp/luma-106-stock-dark-mobile.png',
    fullPage: true,
  });
  delayVerification(false);
  await panel.getByRole('button', { name: 'Verify stock' }).click();
  await expect(
    panel.getByText('Quantity verified', { exact: true }),
  ).toBeVisible();
  expect(mutations).toHaveLength(1);
  await syncStock();
  await page.reload();
  await expect(
    page
      .getByText(
        'Luma set available stock to 9. This read matches; other changes may also have occurred.',
      )
      .first(),
  ).toBeVisible();
  await panel.getByRole('button', { name: 'Review a new correction' }).click();
  await expect(
    panel.getByText(
      'Shopify already shows the same quantity as your inventory system. No correction is needed.',
      { exact: true },
    ),
  ).toBeVisible();
  await changeAvailable(8);
  await syncStock();
  await page.reload();
  await expect(
    page
      .getByText(
        'Luma set available stock to 9. This read differs; other changes remain unattributed.',
      )
      .first(),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: '/tmp/luma-204-attribution-dark-mobile.png',
    fullPage: true,
  });
  expect(mutations).toHaveLength(1);
  expect(errors).toEqual([]);
});

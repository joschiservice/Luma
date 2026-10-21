/* global document */
import { expect, test } from './browser-fixtures.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { bundlesFixture } from './shopify-bundles-fixture.mjs';

test('inspects catalog recipes and sold component groups with keyboard, light, dark and narrow views', async ({
  resources: t,
}) => {
  const port = await availablePort(),
    origin = `http://127.0.0.1:${port}`;
  const { f, parentSkuId, orderId, mutations } = await bundlesFixture(
    t,
    origin,
  );
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
  await page.goto(`/app/${f.org.id}/products/${parentSkuId}`);
  await expect(
    page.getByRole('heading', { name: 'Bundle components', exact: true }),
  ).toBeVisible();
  const recipe = page.getByRole('table', {
    name: 'Bundle components',
    exact: true,
  });
  await expect(
    recipe.getByRole('link', {
      name: 'LUMA-001',
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole('heading', { name: 'Bundle components', exact: true })
    .scrollIntoViewIfNeeded();
  const component = recipe.getByRole('link', {
    name: 'LUMA-001',
    exact: true,
  });
  await component.focus();
  await page.keyboard.press('Enter');
  await expect(page).not.toHaveURL(new RegExp(parentSkuId));
  await expect(
    page.getByText('Canvas tote', { exact: true }).first(),
  ).toBeVisible();
  await page.goto(`/app/${f.org.id}/orders/${orderId}`);
  await expect(page.getByText(/Bundle: Travel bundle at sale/)).toHaveCount(2);
  const lines = page.getByRole('table', { name: /Order lines/ });
  await expect(lines.getByText('LUMA-BUNDLE', { exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page
    .getByText(/Bundle: Travel bundle at sale/)
    .first()
    .scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    ),
  ).toBe(false);
  await page.goto(`/app/${f.org.id}/products/${parentSkuId}`);
  await expect(
    page.getByRole('heading', { name: 'Bundle components', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('heading', { name: 'Bundle components', exact: true })
    .scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    ),
  ).toBe(false);
  expect(errors).toEqual([]);
  expect(mutations).toHaveLength(0);
});

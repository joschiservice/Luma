/* global document, innerWidth */
import { expect, test } from './browser-fixtures.mjs';
import { availablePort, startProcess } from './helpers.mjs';

test('serves searchable issue guides without a session on desktop and mobile', async ({
  resources: t,
}) => {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const web = startProcess(
    t,
    'e2e/web-server.mjs',
    { TEST_API_ORIGIN: 'http://127.0.0.1:1', TEST_WEB_PORT: String(port) },
    true,
  );
  await web.message('listening');
  const page = await t.newPage({
    baseURL: origin,
    viewport: { width: 1440, height: 1000 },
  });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/docs');
  await page
    .getByRole('heading', { name: 'Find and prioritize issues', exact: true })
    .waitFor();
  expect(await page.title()).toBe('Find and prioritize issues · Luma');
  expect(new URL(page.url()).pathname).toBe('/docs/issues');
  expect(await page.locator('vite-error-overlay').count()).toBe(0);
  await page.screenshot({
    path: '/tmp/luma-help-portal-desktop.png',
    fullPage: true,
  });
  await page
    .getByRole('searchbox', { name: 'Search documentation' })
    .fill('preconditions');
  const result = page.locator('.docs-search-results a').first();
  await result.waitFor();
  await result.click();
  await page
    .getByRole('heading', { name: 'Review a resolution', exact: true })
    .waitFor();
  expect(new URL(page.url()).pathname).toBe('/docs/issues/resolve');
  await page.reload();
  await page
    .getByRole('heading', { name: 'Review a resolution', exact: true })
    .waitFor();
  await page
    .getByRole('searchbox', { name: 'Search documentation' })
    .fill('zzznomatchingguide');
  await page
    .getByText('No results. Try another word, or browse the guides below.')
    .waitFor();
  await page.route('**/docs-search?*', (route) =>
    route.fulfill({ status: 503, body: 'Unavailable' }),
  );
  await page
    .getByRole('searchbox', { name: 'Search documentation' })
    .fill('unavailable-search');
  await page
    .getByText('Search is unavailable. Browse the guides below.')
    .waitFor();
  await page.getByRole('searchbox', { name: 'Search documentation' }).fill('');
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole('navigation', { name: 'Documentation', exact: true })
    .getByRole('link', { name: 'Investigate an issue' })
    .click();
  await page
    .getByRole('heading', { name: 'Investigate an issue', exact: true })
    .waitFor();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: '/tmp/luma-help-portal-mobile.png',
    fullPage: true,
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect
    .poll(() => page.locator('html').getAttribute('class'))
    .toContain('dark');
  await page.screenshot({
    path: '/tmp/luma-help-portal-dark.png',
    fullPage: true,
  });
  const missing = await page.goto('/docs/unknown-guide');
  await page.getByRole('heading', { name: 'Guide not found' }).waitFor();
  expect(missing.status()).toBe(404);
  expect(errors).toEqual([]);
});

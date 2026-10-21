/* global document, innerWidth */
import { expect, test } from './browser-fixtures.mjs';

test('serves searchable, sectioned guides without a session on desktop and mobile', async ({
  resources: t,
  web,
}) => {
  const origin = web.origin;
  await web.route('http://127.0.0.1:1');
  const page = await t.newPage({
    baseURL: origin,
    viewport: { width: 1440, height: 1000 },
  });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/docs');
  await page
    .getByRole('heading', { name: 'Luma documentation', exact: true })
    .waitFor();
  expect(await page.title()).toBe('Documentation · Luma');
  await page
    .getByRole('heading', { name: 'Daily work', exact: true })
    .waitFor();
  await page
    .getByRole('main')
    .getByRole('link', { name: 'Find and prioritize issues', exact: true })
    .click();
  await page
    .getByRole('heading', { name: 'Find and prioritize issues', exact: true })
    .waitFor();
  expect(await page.title()).toBe('Find and prioritize issues · Luma');
  expect(new URL(page.url()).pathname).toBe('/docs/issues');
  expect(await page.locator('vite-error-overlay').count()).toBe(0);
  await page
    .getByRole('searchbox', { name: 'Search documentation' })
    .fill('reverse');
  const result = page.locator('.docs-search-results a').first();
  await result.waitFor();
  await result.click();
  await page
    .getByRole('heading', { name: 'Resolve an issue', exact: true })
    .waitFor();
  expect(new URL(page.url()).pathname).toBe('/docs/issues/resolve');
  await page.reload();
  await page
    .getByRole('heading', { name: 'Resolve an issue', exact: true })
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
  await page.unroute('**/docs-search?*');
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole('navigation', { name: 'Guides', exact: true })
    .getByRole('group', { name: 'Daily work' })
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
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect
    .poll(() => page.locator('html').getAttribute('class'))
    .toContain('dark');
  const missing = await page.goto('/docs/unknown-guide');
  await page.getByRole('heading', { name: 'Guide not found' }).waitFor();
  expect(missing.status()).toBe(404);
  // Leave the page first: if it were still hydrating, it would read the new language cookie
  // and no longer match the English server render.
  await page.goto('about:blank');
  await page
    .context()
    .addCookies([{ name: 'luma_locale', value: 'de', url: origin }]);
  await page.goto('/docs/issues/resolve');
  await page
    .getByRole('heading', { name: 'Problem lösen', exact: true })
    .waitFor();
  expect(new URL(page.url()).pathname).toBe('/docs/issues/resolve');
  expect(
    await page
      .getByText('Diese Anleitung ist noch nicht auf Deutsch verfügbar.')
      .count(),
  ).toBe(0);
  await page
    .getByRole('navigation', { name: 'Anleitungen', exact: true })
    .getByRole('group', { name: 'Tägliche Arbeit' })
    .waitFor();
  await page
    .getByRole('searchbox', { name: 'Dokumentation durchsuchen' })
    .fill('umkehrbar');
  await page
    .locator('.docs-search-results a')
    .filter({ hasText: 'Problem lösen' })
    .first()
    .waitFor();
  expect(errors).toEqual([]);
});

/* global document, window */
import { chromium } from 'playwright';
import { expect, test } from 'vitest';

import { setupSimulator } from './simulator-fixture.mjs';

test('panel shows problem removal separately from verified case resolution on desktop and mobile', async (t) => {
  const f = await setupSimulator(t);
  const browser = await chromium.launch({ headless: true });
  t.onTestFinished(() => browser.close());
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(f.simulatorOrigin);
  expect(await page.title()).toBe('Luma / Simulation lab');
  await page.locator('#token').fill(f.token);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page
    .getByRole('button', { name: 'Create mismatch', exact: true })
    .click();
  await page.waitForFunction(() =>
    document.querySelector('#inventory-case').textContent.startsWith('Open'),
  );
  expect(await page.locator('#inventory-stock').textContent()).toBe(
    'JTL 100 · Shopify 110',
  );
  expect(
    await page.locator('#inventory-case-link').getAttribute('href'),
  ).toContain(`/app/${f.manifest.organizationId}/exceptions/`);
  await page.getByRole('button', { name: 'Match stock', exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('#inventory-condition').textContent ===
      'Problem removed',
  );
  expect(await page.locator('#inventory-case').textContent()).toMatch(/^Open/);
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('#inventory-case').textContent === 'Case resolved',
  );
  expect(await page.locator('#error').textContent()).toBe('');
  await page.locator('.operational').scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/luma-inventory-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.operational').scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: '/tmp/luma-inventory-mobile.png' });
  expect(errors).toEqual([]);
});

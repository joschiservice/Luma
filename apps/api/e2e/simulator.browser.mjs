/* global document, window */
import { expect, test } from './browser-fixtures.mjs';
import { setupSimulator } from './simulator-fixture.mjs';

test('panel shows problem removal separately from verified case resolution on desktop and mobile', async ({
  resources: t,
}) => {
  const f = await setupSimulator(t);
  const page = await t.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(`${f.simulatorOrigin}/?token=${f.token}`);
  expect(page.url()).not.toContain('token=');
  await expect(page.getByText('Test fixture').first()).toBeVisible();
  await page.getByRole('tab', { name: 'Incidents' }).click();
  const check = page.getByRole('region', { name: 'Luma inventory check' });
  await expect(check.getByText('No case yet')).toBeVisible();
  // The kind defaults to stock sync drift.
  await page.getByLabel('Target (optional)').fill('LUMA-SCENARIO-001');
  await page.getByRole('button', { name: 'Inject incident' }).click();
  await expect(check.getByText(/Stock sync drift: active/)).toBeVisible();
  await check.getByRole('button', { name: 'Check now' }).click();
  await expect(check.getByText(/Case open/)).toBeVisible();
  await expect(
    check.getByRole('link', { name: /Open case in Luma/ }),
  ).toHaveAttribute(
    'href',
    new RegExp(`/app/${f.manifest.organizationId}/exceptions/`),
  );
  await page
    .getByRole('button', { name: 'Recover Stock sync drift incident' })
    .click();
  await expect(check.getByText('Problem removed')).toBeVisible();
  await expect(check.getByText(/Case open/)).toBeVisible();
  await check.getByRole('button', { name: 'Check now' }).click();
  await expect(check.getByText('Case resolved')).toBeVisible();
  await page.getByRole('tab', { name: 'Scorecard' }).click();
  await expect(page.getByText('Luma connected')).toBeVisible();
  await page.screenshot({ path: '/tmp/luma-simulator-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('tab', { name: 'Incidents' }).click();
  await check.scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: '/tmp/luma-simulator-mobile.png' });
  expect(errors).toEqual([]);
});

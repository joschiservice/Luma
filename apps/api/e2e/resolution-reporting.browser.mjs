/* global document, window */
import { randomUUID } from 'node:crypto';

import { createObservability } from '@luma/platform/composition';

import { expect, test } from './browser-fixtures.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { seedResolutionMeasurement } from './resolution-measurement-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

test('reports distinct detection and verification cohorts, filters exact evidence, and handles unavailable reads', async ({
  resources: t,
}) => {
  const port = await availablePort(),
    origin = `http://127.0.0.1:${port}`;
  const observability = createObservability({
    environment: 'test',
    release: 'test',
    sampleRate: 0,
    featureFlagOverrides: { 'resolution-insights': true },
  });
  const f = await settingsFixture(t, origin, { observability });
  const connectionId = randomUUID();
  const recent = await seedResolutionMeasurement(f, {
    sourceConnectionId: connectionId,
  });
  const late = await seedResolutionMeasurement(f, {
    sourceConnectionId: connectionId,
    detectedAt: new Date(Date.now() - 20 * 86400000).toISOString(),
  });
  await seedResolutionMeasurement(f, {
    verified: false,
    sourceConnectionId: connectionId,
  });
  await seedResolutionMeasurement(f, { synthetic: true });
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
    viewport: { width: 1440, height: 1100 },
  });
  await context.addCookies(
    f.member.cookie.split('; ').map((value) => {
      const [name, ...rest] = value.split('=');

      return { name, value: rest.join('='), url: origin };
    }),
  );
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/app/${f.org.id}/insights`);
  const report = page.getByRole('region', {
    name: 'Resolution reporting',
    exact: true,
  });
  const value = (id) =>
    report.locator(`[data-metric="resolution.${id}"] .operational-value`);
  await expect(value('detected')).toHaveText('3');
  await expect(value('completed')).toHaveText('2');
  await report
    .getByRole('combobox', { name: 'Reporting period', exact: true })
    .click();
  await page.getByRole('option', { name: '7 days', exact: true }).click();
  await expect(value('detected')).toHaveText('2');
  await expect(value('completed')).toHaveText('2');
  await expect(
    report
      .getByRole('group', { name: 'Daily counts (UTC) · Verified' })
      .getByText('0.5', { exact: true }),
  ).toHaveCount(0);
  const trigger = report.locator('[data-metric="resolution.completed"]');
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator(`[href*="${recent.id}"]`).first()).toBeVisible();
  await expect(dialog.locator(`[href*="${late.id}"]`).first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect
    .poll(() => trigger.evaluate((el) => el === document.activeElement))
    .toBe(true);
  await report
    .getByRole('combobox', { name: 'Reporting period', exact: true })
    .click();
  await page
    .getByRole('option', { name: 'Custom interval', exact: true })
    .click();
  await report
    .getByRole('textbox', { name: 'Before (UTC instant)' })
    .fill(new Date(Date.now() + 86400000).toISOString());
  await report.getByRole('button', { name: 'Apply interval' }).click();
  await expect(report.getByRole('alert')).toBeVisible();
  await report
    .getByRole('textbox', { name: 'Before (UTC instant)' })
    .fill(new Date().toISOString());
  await report.getByRole('button', { name: 'Apply interval' }).click();
  await expect(report.getByRole('alert')).toHaveCount(0);
  await expect(value('completed')).toHaveText('2');
  await report.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: '/tmp/luma65-report-light.png',
    fullPage: true,
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 390, height: 844 });
  await report.scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: '/tmp/luma65-report-dark-narrow.png',
    fullPage: true,
  });
  const cohortDay = report
    .getByRole('button', { name: /^Inspect records:/ })
    .last();
  await cohortDay.scrollIntoViewIfNeeded();
  await cohortDay.focus();
  await page.keyboard.press('Enter');
  await expect
    .poll(() => new URL(page.url()).searchParams.get('reportStart'))
    .toContain('T00:00:00');
  await expect(value('completed')).toHaveText('2');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await context.setOffline(true);
  await expect(
    report.getByText('Reconnect to load current metrics.', { exact: true }),
  ).toBeVisible();
  expect(await report.locator('[data-metric]').count()).toBe(0);
  await context.setOffline(false);
  await expect(value('completed')).toHaveText('2');
  await f.request(
    f.owner,
    `${f.base}/members/${f.membership.id}`,
    'DELETE',
    undefined,
    204,
  );
  await expect(
    report.getByText('Your workspace access changed', { exact: true }),
  ).toBeVisible();
  expect(await report.locator('[data-metric]').count()).toBe(0);
  expect(errors).toEqual([]);
});

/* global document, window */
import { mkdir } from 'node:fs/promises';

import { expect, test } from './browser-fixtures.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { seedResolutionMeasurement } from './resolution-measurement-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

test('explains measured and unknown outcomes, exposes evidence, and recovers from failure and access loss', async ({
  resources: t,
}) => {
  const port = await availablePort(),
    origin = `http://127.0.0.1:${port}`;
  const f = await settingsFixture(t, origin);
  const a = await seedResolutionMeasurement(f);
  const human = await seedResolutionMeasurement(f);
  await human.record({
    kind: 'attribution',
    involvement: 'manual_repair',
    complete: false,
    from: human.detectedAt,
    through: human.verifiedAt,
  });
  await seedResolutionMeasurement(f, { verified: false });
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
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(15000);
  await page.goto(`/app/${f.org.id}/insights`);
  const section = page.getByRole('region', {
    name: 'Verified outcomes and human help',
  });
  const value = (id) =>
    section.locator(`[data-metric="resolution.${id}"] .operational-value`);
  await expect(value('autonomous')).toHaveText('1 known');
  await expect(value('verified')).toHaveText('2');
  await expect(value('human')).toHaveText('1');
  await expect(value('unknown')).toHaveText('1');
  const trigger = section.locator('[data-metric="resolution.autonomous"]');
  expect((await trigger.boundingBox()).height).toBeLessThan(100);
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await dialog.getByText('Partial coverage', { exact: true }).waitFor();
  await dialog.getByText('Help unknown · 1', { exact: true }).waitFor();
  await dialog.getByText('No human help', { exact: true }).waitFor();
  await dialog
    .getByText('Evidence and measurement history', { exact: false })
    .click();
  await dialog
    .getByText('Eligible for automation · partner-rule/1 · supported', {
      exact: true,
    })
    .waitFor();
  await expect(dialog.getByText(a.evidence, { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect
    .poll(() => trigger.evaluate((el) => el === document.activeElement))
    .toBe(true);
  // Committed corrections update the same summary and cohort without manual refresh.
  await a.record({
    kind: 'eligibility',
    status: 'ineligible',
    ruleVersion: 'partner-rule/2',
    reasonCode: 'outside_scope',
  });
  await expect(value('autonomous')).toHaveText('0 known');
  await page.getByRole('combobox', { name: 'Environment' }).click();
  await page.getByRole('option', { name: 'Simulated', exact: true }).click();
  await expect(
    page.getByText('Excluded from live results', { exact: true }),
  ).toBeVisible();
  await expect(value('verified')).toHaveText('1');
  await page.getByRole('combobox', { name: 'Environment' }).click();
  await page.getByRole('option', { name: 'Shadow mode', exact: true }).click();
  await expect(value('verified')).toHaveText('—');
  await section.locator('[data-metric="resolution.verified"]').click();
  await dialog.getByText('No matching records', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('combobox', { name: 'Environment' }).click();
  await page
    .getByRole('option', { name: 'Live operations', exact: true })
    .click();
  await expect(value('verified')).toHaveText('2');
  await mkdir('/tmp/luma80-ui', { recursive: true });
  await section.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: '/tmp/luma80-ui/desktop-light.png',
    fullPage: true,
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({
    path: '/tmp/luma80-ui/desktop-dark.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await section.scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: '/tmp/luma80-ui/mobile-dark.png',
    fullPage: true,
  });
  await section.locator('[data-metric="resolution.human"]').click();
  await dialog.getByText('A person helped', { exact: true }).waitFor();
  await expect
    .poll(() => dialog.evaluate((el) => window.getComputedStyle(el).opacity))
    .toBe('1');
  await page.screenshot({
    path: '/tmp/luma80-ui/mobile-cohort.png',
    fullPage: true,
  });
  await page.keyboard.press('Escape');
  // A failed read hides prior claims; retry loads authoritative facts again.
  // Only the resolution part of the page's metric summary fails.
  await page.route('**/v2/organizations/*/metrics/summary', async (route) => {
    const requested = route.request().postDataJSON().parts;
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: {
        ...body,
        parts: body.parts.map((part, index) =>
          requested[index].request.metrics?.some((id) =>
            id.startsWith('resolution.'),
          )
            ? {
                kind: part.kind,
                status: 503,
                error: {
                  code: 'SERVICE_UNAVAILABLE',
                  message: 'Unavailable',
                  requestId: 'test',
                },
              }
            : part,
        ),
      },
    });
  });
  await section
    .getByRole('button', { name: 'Refresh summary', exact: true })
    .click();
  await section.getByText('Summary unavailable', { exact: true }).waitFor();
  expect(await section.locator('[data-metric]').count()).toBe(0);
  await page.unroute('**/v2/organizations/*/metrics/summary');
  await section
    .getByRole('button', { name: 'Refresh summary', exact: true })
    .click();
  await expect(value('verified')).toHaveText('2');
  await context.setOffline(true);
  await section
    .getByText('Reconnect to load current metrics.', { exact: true })
    .waitFor();
  expect(await section.locator('[data-metric]').count()).toBe(0);
  await context.setOffline(false);
  await expect(value('verified')).toHaveText('2');
  await f.request(
    f.owner,
    `${f.base}/members/${f.membership.id}`,
    'DELETE',
    undefined,
    204,
  );
  await section
    .getByText('Your workspace access changed', { exact: true })
    .waitFor();
  expect(await section.locator('[data-metric]').count()).toBe(0);
  expect(errors).toEqual([]);
});

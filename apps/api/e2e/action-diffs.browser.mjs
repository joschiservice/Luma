/* global document, window */
import { randomUUID } from 'node:crypto';

import { createObservability } from '@luma/platform/composition';

import { expect, test } from './browser-fixtures.mjs';
import { correctionFixture } from './shopify-inventory-fixture.mjs';

test('reviews exact expected values in Needs you with keyboard, both themes and a narrow layout', async ({
  resources: t,
  web,
}) => {
  const origin = web.origin;
  const observability = createObservability({
    environment: 'test',
    release: 'test',
    sampleRate: 0,
    featureFlagOverrides: { 'action-review-diffs': true },
  });
  const { f, admin, call, target } = await correctionFixture(t, origin, {
    observability,
  });
  await call(f.owner, 'preview', { ...target, requestId: randomUUID() });
  const apiOrigin = await f.app.listen({ host: '127.0.0.1', port: 0 });
  await web.route(apiOrigin);
  const context = await t.newContext({
    baseURL: origin,
    viewport: { width: 1280, height: 900 },
  });
  await context.addCookies(
    admin.cookie.split('; ').map((value) => {
      const [name, ...rest] = value.split('=');

      return { name, value: rest.join('='), url: origin };
    }),
  );
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const item = (
    await f.request(admin, `${f.base}/decisions?domain=inventory`)
  ).items.find((item) => item.kind === 'inventory_correction');
  await page.goto(
    `/app/${f.org.id}/needs-you?item=${encodeURIComponent(item.id)}`,
  );
  const diff = page.locator('.action-diff');
  await expect(
    diff.getByRole('heading', { name: 'Proposed change' }),
  ).toBeVisible();
  await expect(
    diff
      .getByRole('columnheader', { name: 'Expected before dispatch' })
      .first(),
  ).toBeVisible();
  await expect(
    diff.getByText('Approval required', { exact: true }),
  ).toBeVisible();
  await expect(
    diff.getByText('Unknown', { exact: true }).first(),
  ).toBeVisible();
  const evidence = diff
    .locator('summary')
    .filter({ hasText: /evidence references?/ });
  await evidence.focus();
  await page.keyboard.press('Enter');
  await expect(
    diff.getByText(item.diff.evidence.refs[0], { exact: true }),
  ).toBeVisible();
  await expect(diff.getByRole('link', { name: 'Open record' })).toHaveAttribute(
    'href',
    `/app/${f.org.id}/inventory/${target.positionId}`,
  );
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await expect(
    diff.getByRole('heading', { name: 'Proposed change' }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    diff.getByRole('heading', { name: 'Proposed change' }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await evidence.focus();
  await page.keyboard.press('Enter');
  await expect(
    diff.getByText(item.diff.evidence.refs[0], { exact: true }),
  ).not.toBeVisible();
  expect(errors).toEqual([]);
});

/* global document */
import { createObservability } from '@luma/platform/composition';

import { expect, test } from './browser-fixtures.mjs';
import { nativeStockFixture } from './native-stock-fixture.mjs';

test('reviews and publishes an owned synthetic allocation with separate approval and accessible light, dark and narrow controls', async ({
  resources: t,
  web,
}) => {
  const origin = web.origin;
  const observability = createObservability({
    environment: 'test',
    release: 'test',
    sampleRate: 0,
    featureFlagOverrides: { 'luma-erp-orders': true },
  });
  const f = await nativeStockFixture(t, { origin, observability });
  const apiOrigin = await f.f.app.listen({ host: '127.0.0.1', port: 0 });
  await web.route(apiOrigin);
  const context = await t.newContext({
    baseURL: origin,
    viewport: { width: 1280, height: 900 },
  });
  await context.addCookies(
    f.f.owner.cookie.split('; ').map((value) => {
      const [name, ...rest] = value.split('=');

      return { name, value: rest.join('='), url: origin };
    }),
  );
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(
    `/app/${f.owner.tenantId}/inventory/${f.snapshot.document.entityId}`,
  );
  const panel = page.getByRole('region', {
    name: 'Publish native allocation',
    exact: true,
  });
  await expect(panel).toBeVisible();
  const allocation = panel.getByRole('textbox', {
    name: 'Whole-unit allocation',
    exact: true,
  });
  await allocation.fill('5');
  const review = panel.getByRole('button', {
    name: 'Review allocation',
    exact: true,
  });
  await expect(review).toBeEnabled();
  await review.focus();
  await page.keyboard.press('Enter');
  await expect(
    panel.getByRole('button', { name: 'Check approval', exact: true }),
  ).toBeVisible();
  const id = (
    await f.f.db.owner.query(
      "SELECT id FROM shopify_inventory_corrections WHERE tenant_id=$1 AND document->'target' ? 'nativeAllocation' ORDER BY created_at DESC LIMIT 1",
      [f.owner.tenantId],
    )
  ).rows[0].id;
  await f.call(f.approverUser, 'approve', { id, outcome: 'approved' });
  await panel
    .getByRole('button', { name: 'Check approval', exact: true })
    .click();
  await panel
    .getByRole('button', { name: 'Publish allocation', exact: true })
    .click();
  await expect(
    panel.getByText('Shopify accepted', { exact: true }),
  ).toBeVisible();
  expect(f.mutations).toHaveLength(1);
  await panel
    .getByRole('button', { name: 'Verify stock', exact: true })
    .click();
  await expect(
    panel.getByText('Quantity verified', { exact: true }),
  ).toBeVisible();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

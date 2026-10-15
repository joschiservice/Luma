/* global document, window */
import { createObservability } from '@luma/platform/composition';

import { expect, test } from './browser-fixtures.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { correctionFixture } from './shopify-inventory-fixture.mjs';
import { protectionFixture } from './stock-protection-fixture.mjs';

test('stock protection settings save Preview and remain usable on a narrow dark screen', async ({
  resources: t,
}) => {
  const port = await availablePort(),
    origin = `http://127.0.0.1:${port}`;
  const observability = createObservability({
    environment: 'test',
    release: 'test',
    sampleRate: 0,
    featureFlagOverrides: { 'stock-protection': true },
  });
  const { f } = await correctionFixture(t, origin, { observability });
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
    viewport: { width: 1440, height: 1000 },
  });
  await context.addCookies(
    f.owner.cookie.split('; ').map((value) => {
      const [name, ...rest] = value.split('=');

      return { name, value: rest.join('='), url: origin };
    }),
  );
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/app/${f.org.id}/settings/approvals`);
  await expect(
    page.getByRole('heading', { name: 'Stock protection', exact: true }),
  ).toBeVisible();
  const form = page.getByRole('form', { name: 'Shopify stock', exact: true });
  const mode = form.getByRole('combobox', { name: 'Mode', exact: true });
  await mode.click();
  await page.getByRole('option', { name: 'Preview — record only' }).click();
  await form.getByLabel('Buffer units', { exact: true }).fill('3');
  await form
    .getByLabel('Excluded SKUs (comma separated)')
    .fill('FIRST, SECOND');
  await form
    .getByRole('button', { name: 'Save stock protection', exact: true })
    .click();
  await expect(
    form.getByRole('combobox', { name: 'Mode', exact: true }),
  ).toHaveText('Preview — record only');
  await page.reload();
  await expect(form.getByLabel('Buffer units', { exact: true })).toHaveValue(
    '3',
  );
  await t.attach('stock-protection-settings-light', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await form.getByRole('combobox', { name: 'Mode', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  await expect(
    form.getByRole('button', { name: 'Save stock protection', exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await t.attach('stock-protection-settings-dark-narrow', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  expect(errors).toEqual([]);
});

test('active stock protection links banners, per-SKU evidence and an explicit verified release', async ({
  resources: t,
}) => {
  const origin = `http://127.0.0.1:${await availablePort()}`;
  const observability = createObservability({
    environment: 'test',
    release: 'test',
    sampleRate: 0,
    featureFlagOverrides: { 'stock-protection': true },
  });
  const protection = await protectionFixture(t, 'on', origin, {
    observability,
  });
  const { f } = protection;
  await protection.service.tick(protection.actor, protection.incidentId);
  const apiOrigin = await f.app.listen({ host: '127.0.0.1', port: 0 });
  const web = startProcess(
    t,
    'e2e/web-server.mjs',
    { TEST_API_ORIGIN: apiOrigin, TEST_WEB_PORT: new URL(origin).port },
    true,
  );
  await web.message('listening');
  const context = await t.newContext({
    baseURL: origin,
    viewport: { width: 1440, height: 1000 },
  });
  await context.addCookies(
    f.owner.cookie.split('; ').map((value) => {
      const [name, ...rest] = value.split('=');

      return { name, value: rest.join('='), url: origin };
    }),
  );
  const page = await context.newPage();
  await page.goto(`/app/${f.org.id}/inventory`);
  const notice = page.getByRole('region', {
    name: 'Stock protection',
    exact: true,
  });
  await expect(
    notice.getByText('Stock protection for Shopify stock: 1 SKUs held', {
      exact: true,
    }),
  ).toBeVisible();
  await notice.getByRole('link', { name: 'Open the sync incident' }).click();
  await expect(page).toHaveURL(
    new RegExp(`/exceptions/${protection.incidentId}`),
  );
  await notice.getByText('1 stock positions', { exact: true }).click();
  await expect(
    notice.getByRole('table', { name: 'Stock protection by SKU' }),
  ).toContainText('LUMA-001');
  await expect(
    notice.getByText('Held by stock protection', { exact: true }),
  ).toBeVisible();
  await page.goto(`/app/${f.org.id}/inventory/${protection.target.positionId}`);
  await expect(
    notice.getByText('Held by stock protection', { exact: true }).first(),
  ).toBeVisible();
  await page.goto(`/app/${f.org.id}/settings/approvals`);
  const form = page.getByRole('form', { name: 'Shopify stock', exact: true });
  await form.getByRole('combobox', { name: 'Mode', exact: true }).click();
  await page.getByRole('option', { name: 'Off', exact: true }).click();
  await form
    .getByRole('combobox', { name: 'What happens to active holds' })
    .click();
  await page
    .getByRole('option', { name: 'Release all now', exact: true })
    .click();
  await form
    .getByRole('button', { name: 'Save stock protection', exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await protection.service.view(protection.actor)).settings[0].mode,
    )
    .toBe('off');
  await protection.service.tick(protection.actor, protection.incidentId);
  await page.goto(
    `/app/${f.org.id}/exceptions/${protection.incidentId}/detail`,
  );
  await notice.getByText('1 stock positions', { exact: true }).click();
  await expect(
    notice.getByText('Released and verified', { exact: true }),
  ).toBeVisible();
  expect(protection.mutations).toHaveLength(2);
});

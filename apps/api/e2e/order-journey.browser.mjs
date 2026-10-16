/* global document */
import { expect, test } from './browser-fixtures.mjs';
import { fulfillmentFixture } from './fulfillment-fixture.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { settingsFixture } from './settings-fixture.mjs';

test('journey checks and evidence remain readable in both themes, narrow layouts and keyboard navigation', async ({
  resources: t,
}) => {
  const port = await availablePort(),
    origin = `http://127.0.0.1:${port}`;
  const f = await settingsFixture(t, origin),
    records = await fulfillmentFixture(t, f);
  const order = await records.order({
    external: 'browser-journey',
    key: 'browser-journey',
    updatedAt: new Date(Date.now() - 6 * 3600000).toISOString(),
    data: {
      displayNumber: '#JOURNEY',
      placedAt: new Date(Date.now() - 12 * 3600000).toISOString(),
    },
    lines: [{ external: 'journey-line', quantity: '2', title: 'Journey item' }],
  });
  await records.fulfillment({
    external: 'browser-shipment',
    order: 'browser-journey',
    lines: [{ external: 'journey-line', quantity: '1' }],
    status: 'shipped',
    facts: { kind: 'shipment' },
  });
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
  page.on('pageerror', (e) => errors.push(e.message));
  // The open view's tab is selected; the link's search is adopted and leaves the address.
  await page.goto(`/app/${f.org.id}/orders?view=stuck&q=JOURNEY`);
  await page.waitForURL((url) => !url.searchParams.has('q'));
  expect(new URL(page.url()).searchParams.get('view')).toBe('stuck');
  await expect(
    page.getByRole('tab', { name: 'Journey checks', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(
    page.getByRole('searchbox', { name: 'Search orders' }),
  ).toHaveValue('JOURNEY');
  await page.getByRole('link', { name: '#JOURNEY', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/orders/${order}`));
  // History opens on the journey because a journey check needs investigation.
  const history = page.getByRole('region', { name: 'History', exact: true });
  await expect(
    history.getByRole('tab', { name: /^Order journey/ }),
  ).toHaveAttribute('aria-selected', 'true');
  const journey = history.getByRole('tabpanel');
  await expect(
    journey.getByText('Occurrence time unknown', { exact: true }).first(),
  ).toBeVisible();
  await expect(
    journey.getByText('Needs investigation', { exact: true }).first(),
  ).toBeVisible();
  const evidence = journey
    .getByText('Evidence references', { exact: true })
    .first();
  await evidence.focus();
  await page.keyboard.press('Enter');
  await expect(journey.locator('details').first()).toHaveAttribute('open', '');
  await expect(
    journey.getByText('Provider observation', { exact: true }).first(),
  ).toBeVisible();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(journey).toBeVisible();
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

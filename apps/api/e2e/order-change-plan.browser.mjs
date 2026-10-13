/* global document */
import { expect, test } from './browser-fixtures.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { linkedOrderFixture } from './order-change-plan-fixture.mjs';

test('previews a quantity plan, opens the Shopify edit prefilled and hands the warehouse step to a person after packing starts', async ({
  resources: t,
}) => {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const fixture = await linkedOrderFixture(t, origin);
  const { f, shop, tenantId } = fixture;
  const web = startProcess(
    t,
    'e2e/web-server.mjs',
    { TEST_API_ORIGIN: f.apiOrigin, TEST_WEB_PORT: String(port) },
    true,
  );
  await web.message('listening');
  const context = await t.newContext({
    baseURL: origin,
    viewport: { width: 1280, height: 900 },
  });
  await context.addCookies(
    fixture.cookie.split('; ').map((value) => {
      const [name, ...rest] = value.split('=');

      return { name, value: rest.join('='), url: origin };
    }),
  );
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/app/${tenantId}/orders/${shop}`);
  const plan = page.getByRole('region', { name: 'Change plan' });
  await expect(
    plan.getByText(
      'The sources show no change to plan. Propose a quantity to see what it would take.',
    ),
  ).toBeVisible();

  // Propose with the keyboard only.
  await plan.getByLabel('New quantity').focus();
  await page.keyboard.type('1');
  await page.keyboard.press('Enter');
  await expect(plan.getByText('Safe to change', { exact: true })).toBeVisible();
  await expect(plan.getByText('From 2 to 1')).toBeVisible();
  await expect(plan.getByText('Person: Operations')).toBeVisible();
  const review = plan.getByRole('button', { name: /^Review in / });
  await review.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/edit=/);
  const quantity = page.getByRole('spinbutton', { name: /^New quantity for / });
  await expect(quantity).toHaveValue('1');
  await expect(
    page.getByRole('button', { name: 'Preview change' }),
  ).toBeEnabled();

  // Packing in JTL makes the change unsafe; the warehouse step is a person's.
  await fixture.packing();
  await page.reload();
  await expect(
    plan.getByText('Not safe to change', { exact: true }),
  ).toBeVisible();
  await expect(plan.getByText('Person: Warehouse')).toBeVisible();
  await expect(
    plan.getByText('Waits until the steps above make the change safe.'),
  ).toBeVisible();
  await expect(plan.getByRole('button', { name: /^Review in / })).toHaveCount(
    0,
  );

  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.setViewportSize({ width: 390, height: 844 });
  await plan.scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await expect(plan.getByText('Not safe to change')).toBeVisible();
  expect(errors).toEqual([]);
});

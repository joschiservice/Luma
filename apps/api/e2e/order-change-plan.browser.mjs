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
  // Nothing differs, so the lines show no plan until the reader proposes one.
  const lines = page.getByRole('region', { name: 'Order lines' });
  await expect(lines.getByRole('button', { name: /^Review plan/ })).toHaveCount(
    0,
  );

  // Propose with the keyboard only, from the line's menu.
  await lines
    .getByRole('button', { name: /^Actions for / })
    .first()
    .focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('menuitem', { name: 'Plan a quantity change' }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  const plan = page.getByRole('dialog', { name: 'Change plan' });
  await expect(
    plan.getByText(
      'The sources show no change to plan. Propose a quantity to see what it would take.',
    ),
  ).toBeVisible();
  await expect(plan.getByLabel('New quantity')).toBeFocused();
  await page.keyboard.type('1');
  await page.keyboard.press('Enter');
  await expect(plan.getByText('Safe to change', { exact: true })).toBeVisible();
  await expect(plan.getByText('From 2 to 1')).toBeVisible();
  await expect(plan.getByText('Person: Operations')).toBeVisible();
  const review = plan.getByRole('button', { name: /^Review in / });
  await review.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/edit=/);
  await expect(plan).toHaveCount(0);
  const quantity = page.getByRole('spinbutton', { name: /^New quantity for / });
  await expect(quantity).toHaveValue('1');
  await expect(
    page.getByRole('button', { name: 'Preview change' }),
  ).toBeEnabled();

  // Packing in JTL makes the change unsafe; the warehouse step is a person's.
  await fixture.packing();
  await page.reload();
  await expect(lines.getByText('Not safe to change')).toBeVisible();
  await lines.getByRole('button', { name: /^Review plan/ }).click();
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

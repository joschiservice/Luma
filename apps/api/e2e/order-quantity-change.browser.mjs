/* global document */
import { expect, test } from './browser-fixtures.mjs';
import {
  quantityChangeFixture,
  workflow,
} from './order-quantity-change-fixture.mjs';

test('shows the operator what each system reports and lets the warehouse answer the dispatch task in Needs you', async ({
  resources: t,
  web,
}) => {
  const origin = web.origin;
  const f = await quantityChangeFixture(t, { origin });
  await f.activate(workflow);
  await f.changeQuantity('1');
  const opened = await f.caseOpened();
  const run = await f.run();
  await f.waitFor(workflow, run.id, 'waiting');
  await web.route(f.apiOrigin);
  const signedIn = async (cookie) => {
    const context = await t.newContext({
      baseURL: origin,
      viewport: { width: 1280, height: 900 },
    });
    await context.addCookies(
      cookie.split('; ').map((value) => {
        const [name, ...rest] = value.split('=');

        return { name, value: rest.join('='), url: origin };
      }),
    );
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));

    return { page, errors };
  };
  const tenantId = f.manifest.organizationId;

  // The operator opens the case: what changed, where, and the plan to carry it.
  const operator = await signedIn(f.operatorCookie);
  await operator.page.goto(`/app/${tenantId}/exceptions/${opened.id}`);
  await expect(
    operator.page
      .getByText(
        /^Luma ERP sets this quantity to 1; Shopify still shows 2;.*JTL doesn’t report it/,
      )
      .first(),
  ).toBeVisible();
  await expect(
    operator.page
      .getByText(/^Luma ERP reports 1 each;.* JTL reports no current quantity/)
      .first(),
  ).toBeVisible();
  await operator.page.goto(`/app/${tenantId}/exceptions/${opened.id}/detail`);
  const plan = operator.page.getByRole('region', { name: /^Change plan/ });
  await expect(plan.getByText(/sets this quantity to 1/).first()).toBeVisible();
  await expect(plan.getByText(/doesn’t report it/).first()).toBeVisible();

  // A warehouse member answers the dispatch task from Needs you with the keyboard.
  const warehouse = await signedIn(f.warehouseCookie);
  await warehouse.page.goto(`/app/${tenantId}/needs-you`);
  await warehouse.page
    .getByText(/A customer’s quantity change must reach dispatch/)
    .first()
    .click();
  await warehouse.page.getByLabel('Answer', { exact: true }).focus();
  await warehouse.page.keyboard.press('Enter');
  await warehouse.page
    .getByRole('option', { name: 'Adjusted', exact: true })
    .click();
  await warehouse.page
    .getByLabel('Required evidence', { exact: true })
    .fill('Delivery note updated to one unit in JTL.');
  await warehouse.page
    .getByRole('button', { name: 'Submit answer', exact: true })
    .click();
  await expect
    .poll(async () => (await f.task(run.id)).answer?.choice)
    .toBe('Adjusted');
  await f.wake(run.id);
  await f.waitFor(workflow, run.id, 'awaiting_decision');

  await warehouse.page.emulateMedia({ colorScheme: 'dark' });
  await warehouse.page.setViewportSize({ width: 390, height: 844 });
  await operator.page.evaluate(() =>
    document.documentElement.classList.add('dark'),
  );
  await operator.page.setViewportSize({ width: 390, height: 844 });
  await operator.page.reload();
  await expect(
    operator.page.getByRole('region', { name: /^Change plan/ }),
  ).toBeVisible();
  expect(
    await operator.page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  expect([...operator.errors, ...warehouse.errors]).toEqual([]);
});

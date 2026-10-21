/* global document, innerWidth */
import { expect, test } from './browser-fixtures.mjs';
import { returnBrowserCommand } from './return-browser-commands.mjs';
import { settlementFixture } from './return-settlement-fixture.mjs';

test('requests a replacement by keyboard and verifies charge payment before approving hold release on a narrow case', async ({
  resources: t,
  web,
}) => {
  const origin = web.origin,
    f = await settlementFixture(t, { origin, resolution: 'exchange' });
  const replacement = (await f.request(`${f.path}/exchange`)).choices[0],
    variant = (
      await f.call(
        'runs/operations/records/shopify?kind=ProductVariant&limit=100',
      )
    ).items.find(
      (v) => replacement.variantId === `gid://shopify/ProductVariant/${v.id}`,
    );
  await f.command({
    kind: 'product-update',
    product: variant.data.product,
    price: ((variant.data.price + 100) / 100).toFixed(2),
  });
  await web.route(f.apiOrigin);

  async function pageFor(cookie) {
    const context = await t.newContext({
      baseURL: origin,
      viewport: { width: 390, height: 844 },
      reducedMotion: 'reduce',
    });
    await context.addCookies(
      cookie.split('; ').map((value) => {
        const [name, ...rest] = value.split('=');

        return { name, value: rest.join('='), url: origin };
      }),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(`/app/${f.org}/returns/cases/${f.detail.case.id}`);

    return page;
  }

  const requester = await pageFor(f.requester),
    section = requester.getByRole('region', { name: 'Exchange' });
  const select = section.getByRole('combobox', { name: 'Replacement item' });
  await select.focus();
  await requester.keyboard.press('Enter');
  await expect(requester.getByRole('option').first()).toBeVisible();
  await requester.keyboard.press('Home');
  await requester.keyboard.press('Enter');
  await expect(select).toContainText(replacement.label);
  await section.getByRole('spinbutton').fill('2');
  const requestButton = section.getByRole('button', {
    name: 'Request replacement approval',
  });
  await expect(requestButton).toBeEnabled();
  await requestButton.focus();
  await requester.keyboard.press('Enter');
  await expect(
    section.getByText('Waiting for approval', { exact: true }),
  ).toBeVisible();
  expect(
    await section.getByRole('button', { name: 'Approve and send' }).count(),
  ).toBe(0);
  const approver = await pageFor(f.approver),
    review = approver.getByRole('region', { name: 'Exchange' });
  await returnBrowserCommand(approver, f.path, 'decision', () =>
    review.getByRole('button', { name: 'Approve and send' }).click(),
  );
  await expect(
    review.getByText('Independently verified', { exact: true }),
  ).toBeVisible();
  await requester.reload();
  await section
    .getByRole('button', { name: 'Request processing approval' })
    .click();
  await expect(
    section.getByText('Waiting for approval', { exact: true }),
  ).toBeVisible();
  await approver.reload();
  const rejected = (await f.request(`${f.path}/exchange`)).steps.find(
    (s) => s.plan.kind === 'process' && s.state === 'approval_required',
  );
  await f.request(
    `${f.path}/exchange/steps/${rejected.id}/decision`,
    { decisionId: rejected.decisionId, outcome: 'rejected' },
    f.approver,
  );
  await requester
    .getByRole('button', { name: 'Refresh return case', exact: true })
    .click();
  await section
    .getByRole('button', { name: 'Request processing approval' })
    .click();
  await expect
    .poll(
      async () =>
        (await f.request(`${f.path}/exchange`)).steps.filter(
          (s) =>
            s.plan.kind === 'process' &&
            s.state === 'approval_required' &&
            s.id !== rejected.id,
        ).length,
    )
    .toBe(1);
  await approver.reload();
  await returnBrowserCommand(approver, f.path, 'decision', () =>
    review.getByRole('button', { name: 'Approve and send' }).click(),
  );
  await expect(
    review.getByText('Price difference payment pending', { exact: true }),
  ).toBeVisible();
  await expect(
    review.getByText('Replacement fulfillment waiting', { exact: true }),
  ).toBeVisible();
  expect(
    await review
      .getByRole('button', { name: 'Request payment hold release approval' })
      .count(),
  ).toBe(0);
  expect(
    await approver.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await f.command({ kind: 'exchange-pay', order: f.providerOrderId });
  await returnBrowserCommand(approver, f.path, 'check', () =>
    review.getByRole('button', { name: 'Check source' }).last().click(),
  );
  await expect(
    review.getByText('Price difference payment verified', { exact: true }),
  ).toBeVisible();
  await review
    .getByRole('button', { name: 'Request payment hold release approval' })
    .click();
  await expect(
    review.getByText('Waiting for approval', { exact: true }),
  ).toBeVisible();
  await requester.reload();
  await returnBrowserCommand(requester, f.path, 'decision', () =>
    section.getByRole('button', { name: 'Approve and send' }).click(),
  );
  await expect(
    section.getByText('Replacement fulfillment ready', { exact: true }).last(),
  ).toBeVisible();
  expect(
    (
      await f.call(
        'runs/operations/records/shopify?kind=FulfillmentOrder&limit=100',
      )
    ).items.filter((w) => w.data.order === f.providerOrderId),
  ).toHaveLength(2);
});

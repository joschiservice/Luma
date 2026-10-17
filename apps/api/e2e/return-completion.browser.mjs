/* global document, innerWidth */
import { expect, test } from './browser-fixtures.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { returnBrowserCommand } from './return-browser-commands.mjs';
import { completionFixture } from './return-completion-fixture.mjs';

test('records receipt and inspection, approves stock and exchange separately, then completes only after both systems agree', async ({
  resources: t,
}) => {
  const port = await availablePort(),
    origin = `http://127.0.0.1:${port}`;
  const f = await completionFixture(t, { origin });
  const replacement = (await f.request(`${f.path}/exchange`)).choices[0];
  const variant = (
    await f.call(
      'runs/operations/records/shopify?kind=ProductVariant&limit=100',
    )
  ).items.find(
    (v) => replacement.variantId === `gid://shopify/ProductVariant/${v.id}`,
  );
  await f.command({
    kind: 'product-update',
    product: variant.data.product,
    price: ((variant.data.price - 100) / 100).toFixed(2),
  });
  const web = startProcess(
    t,
    'e2e/web-server.mjs',
    { TEST_API_ORIGIN: f.apiOrigin, TEST_WEB_PORT: String(port) },
    true,
  );
  await web.message('listening');

  async function pageFor(cookie) {
    const context = await t.newContext({
      baseURL: origin,
      viewport: { width: 390, height: 844 },
      reducedMotion: 'reduce',
    });
    await context.addCookies(
      cookie.split('; ').map((v) => {
        const [name, ...rest] = v.split('=');

        return { name, value: rest.join('='), url: origin };
      }),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(`/app/${f.org}/returns/cases/${f.detail.case.id}`);

    return page;
  }

  const requester = await pageFor(f.requester);

  async function saveDialog(button, title, save) {
    await requester.getByRole('button', { name: button, exact: true }).click();
    const dialog = requester.getByRole('dialog', { name: title });
    await dialog
      .getByRole('textbox', { name: 'Note', exact: false })
      .fill('Warehouse counted and inspected both returned units');

    return {
      dialog,
      save: async () => {
        await dialog.getByRole('button', { name: save, exact: true }).click();
        await expect(dialog).not.toBeVisible();
      },
    };
  }

  await (
    await saveDialog('Record receipt', 'Record receipt', 'Save receipt')
  ).save();
  await (
    await saveDialog(
      'Record inspection',
      'Record inspection',
      'Save inspection',
    )
  ).save();
  const proposal = await saveDialog(
    'Propose resolution',
    'Propose a resolution',
    'Save proposal',
  );
  await proposal.dialog.getByRole('combobox', { name: 'Resolution' }).click();
  await requester
    .getByRole('option', { name: 'Exchange', exact: true })
    .click();
  await proposal.save();
  const section = requester.getByRole('region', {
    name: 'Exchange',
    exact: true,
  });
  const select = section.getByRole('combobox', { name: 'Replacement item' });
  await select.focus();
  await requester.keyboard.press('Enter');
  const options = requester.getByRole('option');
  await expect(options.first()).toBeFocused();
  await requester.keyboard.press('Home');
  await expect(options.first()).toBeFocused();
  const labels = await options.allTextContents();
  const replacementIndex = labels.findIndex((label) =>
    label.startsWith(`${replacement.label} · `),
  );
  expect(replacementIndex).toBeGreaterThanOrEqual(0);
  for (let index = 0; index < replacementIndex; index++)
    await requester.keyboard.press('ArrowDown');
  await expect(options.nth(replacementIndex)).toBeFocused();
  await requester.keyboard.press('Enter');
  await expect(select).toContainText(replacement.label);
  await section.getByRole('spinbutton').fill('2');
  await section
    .getByRole('button', { name: 'Request replacement approval' })
    .click();
  await expect(
    section.getByText('Waiting for approval', { exact: true }),
  ).toBeVisible();
  const replacementRequest = (await f.request(`${f.path}/exchange`)).operation
    .request;
  expect(replacementRequest.replacement.variantId).toBe(replacement.variantId);
  expect(replacementRequest.replacement.skuId).toBe(replacement.skuId);
  const approver = await pageFor(f.approver),
    review = approver.getByRole('region', { name: 'Exchange', exact: true });
  await returnBrowserCommand(approver, f.path, 'decision', () =>
    review.getByRole('button', { name: 'Approve and send' }).click(),
  );
  await expect(
    review.getByText('Independently verified', { exact: true }),
  ).toBeVisible();
  await f.command({ kind: 'return-receive', order: f.providerOrderId });
  await requester.reload();
  const stock = requester.getByRole('region', { name: 'Stock and refund' });
  await stock
    .getByRole('button', { name: /Request restock approval:/ })
    .first()
    .click();
  await expect(
    stock.getByText('Waiting for approval', { exact: true }),
  ).toBeVisible();
  await approver.reload();
  await returnBrowserCommand(approver, f.path, 'decision', () =>
    approver
      .getByRole('region', { name: 'Stock and refund' })
      .getByRole('button', { name: 'Approve and send' })
      .click(),
  );
  await expect(
    approver
      .getByRole('region', { name: 'Stock and refund' })
      .getByText('Independently verified', { exact: true }),
  ).toBeVisible();
  // Needs you: the restock is now the case's latest step, so the case cites it. It opens the
  // provider read that verified the restock and the write receipt of the accepted request.
  const restockCase = approver.url();
  await approver.goto(
    `/app/${f.org}/needs-you?item=${encodeURIComponent(`return-case:${f.detail.case.id}`)}`,
  );
  await approver.getByText('Evidence: restock step', { exact: true }).click();
  const restockEvidence = approver.getByRole('list', {
    name: 'Cited evidence',
  });
  await expect(restockEvidence.getByText(/^Read from /).first()).toBeVisible();
  await expect(
    restockEvidence.getByText('Write receipt', { exact: true }).first(),
  ).toBeVisible();
  await expect(
    restockEvidence.getByText(/^Accepted by /).first(),
  ).toBeVisible();
  await expect(restockEvidence.getByText('Not found')).toHaveCount(0);
  await approver.goto(restockCase);
  await requester.reload();
  await section
    .getByRole('button', { name: 'Request processing approval' })
    .click();
  await expect(
    section.getByText('Waiting for approval', { exact: true }),
  ).toBeVisible();
  await approver.reload();
  await returnBrowserCommand(approver, f.path, 'decision', () =>
    review.getByRole('button', { name: 'Approve and send' }).click(),
  );
  await expect(
    review.getByText('Price difference payment pending', { exact: true }),
  ).toBeVisible();
  await returnBrowserCommand(approver, f.path, 'complete', () =>
    review.getByRole('button', { name: 'Check both systems' }).click(),
  );
  await expect(
    review.getByText('Exchange unresolved · case owner must follow up', {
      exact: true,
    }),
  ).toBeVisible();
  const report = (await f.request(`${f.path}/exchange`)).operation;
  // Needs you: the unresolved completion check is what the case cites. Opened by keyboard on a
  // narrow screen, it shows the reads behind the replacement's availability and the check.
  const casePage = approver.url();
  await approver.goto(
    `/app/${f.org}/needs-you?item=${encodeURIComponent(`return-case:${f.detail.case.id}`)}`,
  );
  const cites = approver.getByText('Evidence: exchange check', {
    exact: true,
  });
  await cites.focus();
  await approver.keyboard.press('Enter');
  const exchangeEvidence = approver.getByRole('list', {
    name: 'Cited evidence',
  });
  const readsOf = (part) =>
    part.evidenceRefs.filter((ref) => /^[0-9a-f-]{36}$/i.test(ref));
  const availabilityReads = readsOf(report.availability);
  const completionReads = readsOf(report.completion);
  expect(availabilityReads.length).toBeGreaterThan(0);
  expect(completionReads.length).toBeGreaterThan(0);
  for (const ref of [...availabilityReads, ...completionReads])
    await expect(
      exchangeEvidence.getByRole('listitem').filter({ hasText: ref }),
    ).toContainText('Provider read');
  await expect(exchangeEvidence.getByText('Not found')).toHaveCount(0);
  expect(
    await approver.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await approver.goto(casePage);
  await expect(
    review.getByText('Exchange unresolved · case owner must follow up', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    review.getByRole('textbox', { name: 'Replacement order reference' }),
  ).toHaveValue(`luma-ex:${report.id}`);
  await f.createWawi(
    report.id,
    replacement,
    report.completion.replacementTotal,
  );
  await f.command({ kind: 'refund-settle', order: f.providerOrderId });
  await review.getByRole('button', { name: 'Check both systems' }).focus();
  await returnBrowserCommand(approver, f.path, 'complete', () =>
    approver.keyboard.press('Enter'),
  );
  await expect(
    review.getByText('Exchange consistency verified', { exact: true }),
  ).toBeVisible();
  expect((await f.request(f.path)).case.state).toBe('completed');
  await expect(
    approver.getByText(
      'This exchange was completed after independent checks in both systems.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    approver.getByText('No further work on this cancelled case.', {
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    review.getByText('Price difference payment verified', { exact: true }),
  ).toBeVisible();
  await expect(
    review.getByText('Price difference payment pending', { exact: true }),
  ).not.toBeVisible();
  expect(
    await approver.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await approver.screenshot({
    path: '/tmp/luma196-completed-light.png',
    fullPage: true,
  });
  await approver.evaluate(() => document.documentElement.classList.add('dark'));
  await approver.screenshot({
    path: '/tmp/luma196-completed-dark.png',
    fullPage: true,
  });
});

/* global document, innerWidth */
import { expect, test } from './browser-fixtures.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { settlementFixture } from './return-settlement-fixture.mjs';

test('independently approves a refund, distinguishes pending payment, and checks actual settlement on a narrow case', async ({
  resources: t,
}) => {
  const port = await availablePort(),
    origin = `http://127.0.0.1:${port}`;
  const f = await settlementFixture(t, { origin });
  const apiOrigin = f.apiOrigin;
  const web = startProcess(
    t,
    'e2e/web-server.mjs',
    { TEST_API_ORIGIN: apiOrigin, TEST_WEB_PORT: String(port) },
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

  const requester = await pageFor(f.requester);
  const requestSection = requester.getByRole('region', {
    name: 'Stock and refund',
  });
  await requestSection
    .getByRole('button', { name: 'Request refund approval' })
    .focus();
  await requester.keyboard.press('Enter');
  await expect(
    requestSection.getByText('Waiting for approval', { exact: true }),
  ).toBeVisible();
  await expect(
    requestSection.getByRole('button', { name: 'Approve and send' }),
  ).toHaveCount(0);
  await f.call('runs/operations/control', {
    action: 'fault',
    rule: {
      instance: 'shopify',
      operation: 'returns.refund',
      kind: 'response-loss',
      remaining: 1,
    },
  });
  const approver = await pageFor(f.approver),
    section = approver.getByRole('region', { name: 'Stock and refund' });
  await section.getByRole('button', { name: 'Approve and send' }).click();
  await expect(
    section.getByText('Refund processing', { exact: true }),
  ).toBeVisible();
  await expect(
    section.getByText('Independently verified', { exact: true }),
  ).toHaveCount(0);
  await expect(
    section.getByRole('button', { name: 'Request refund approval' }),
  ).toHaveCount(0);
  const restockButton = section.getByRole('button', {
    name: /Request restock approval/,
  });
  const bounds = await restockButton.boundingBox();
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  await approver.screenshot({
    path: '/tmp/luma195-settlement-narrow-light.png',
    fullPage: true,
  });
  await approver.evaluate(() => document.documentElement.classList.add('dark'));
  await approver.screenshot({
    path: '/tmp/luma195-settlement-narrow-dark.png',
    fullPage: true,
  });
  expect(
    await approver.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await f.command({ kind: 'refund-settle', order: f.providerOrderId });
  await section.getByRole('button', { name: 'Check source' }).click();
  await expect(
    section.getByText('Independently verified', { exact: true }),
  ).toBeVisible();
  await expect(
    section.getByText('Refund processing', { exact: true }),
  ).toHaveCount(0);
  const items = (
    await f.call('runs/operations/records/shopify?kind=Refund&limit=100')
  ).items;
  expect(items.filter((r) => r.data.note?.startsWith('luma-rs:'))).toHaveLength(
    1,
  );
});

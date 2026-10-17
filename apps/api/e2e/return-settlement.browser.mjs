/* global document, innerWidth */
import { expect, test } from './browser-fixtures.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { returnBrowserCommand } from './return-browser-commands.mjs';
import {
  providerWrites,
  settlementFixture,
} from './return-settlement-fixture.mjs';

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
  const rejected = (await f.request(`${f.path}/settlements`)).items[0];
  await f.request(
    `${f.path}/settlements/${rejected.id}/decision`,
    { decisionId: rejected.decisionId, outcome: 'rejected' },
    f.approver,
  );
  await requester
    .getByRole('button', { name: 'Refresh return case', exact: true })
    .click();
  await requestSection
    .getByRole('button', { name: 'Request refund approval' })
    .click();
  await expect
    .poll(
      async () =>
        (await f.request(`${f.path}/settlements`)).items.filter(
          (a) => a.state === 'approval_required' && a.id !== rejected.id,
        ).length,
    )
    .toBe(1);
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
  await returnBrowserCommand(approver, f.path, 'decision', () =>
    section.getByRole('button', { name: 'Approve and send' }).click(),
  );
  await expect(
    section.getByText('Refund processing', { exact: true }),
  ).toBeVisible();
  // The approved send consumed the armed loss, so its acceptance never reached Luma.
  expect((await f.call('runs/operations')).faults).toEqual([
    expect.objectContaining({
      operation: 'returns.refund',
      kind: 'response-loss',
      status: 'triggered',
    }),
  ]);
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
  await returnBrowserCommand(approver, f.path, 'check', () =>
    section.getByRole('button', { name: 'Check source' }).click(),
  );
  await expect(
    section.getByText('Independently verified', { exact: true }),
  ).toBeVisible();
  await expect(
    section.getByText('Refund processing', { exact: true }),
  ).toHaveCount(0);
  // Needs you: with no wait or exchange check, the case cites its latest step, the refund. It
  // opens the provider reads that verified the refund. Its response was lost, so Shopify's
  // acceptance was never received and no write receipt is shown in its place.
  await approver.goto(
    `/app/${f.org}/needs-you?item=${encodeURIComponent(`return-case:${f.detail.case.id}`)}`,
  );
  await approver.getByText('Evidence: refund step', { exact: true }).click();
  const refundEvidence = approver.getByRole('list', { name: 'Cited evidence' });
  await expect(refundEvidence.getByText(/^Read from /).first()).toBeVisible();
  await expect(
    refundEvidence.getByText('Write receipt', { exact: true }),
  ).toHaveCount(0);
  await expect(refundEvidence.getByText('Not found')).toHaveCount(0);
  expect(
    await approver.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const items = (
    await f.call('runs/operations/records/shopify?kind=Refund&limit=100')
  ).items;
  expect(items.filter((r) => r.data.note?.startsWith('luma-rs:'))).toHaveLength(
    1,
  );
  // Shopify received exactly one refund request, the one whose response was lost.
  await expect
    .poll(() => providerWrites(f, 'shopify', 'returns.refund'))
    .toEqual(['response-loss']);
});

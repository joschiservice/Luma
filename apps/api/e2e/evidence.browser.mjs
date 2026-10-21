/* global document */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { expect, test } from './browser-fixtures.mjs';
import { settlementFixture } from './return-settlement-fixture.mjs';

const screenshots = globalThis.process.env.EVIDENCE_SCREENSHOTS;

test('opens the stored reads and receipts behind a verified purchase-order submission and a return settlement', async ({
  resources: t,
  web,
}) => {
  const origin = web.origin;
  const f = await settlementFixture(t, { origin });
  await web.route(f.apiOrigin);

  // A restock the Wawi accepts and a fresh read verifies.
  const choices = await f.request(`${f.path}/settlements`);
  const target = choices.targets.find(
    (choice) => choice.warehouse.externalId !== 'all-warehouses',
  );
  assert.ok(target);
  const stock = await f.request(`${f.path}/settlements`, {
    id: randomUUID(),
    kind: 'restock',
    targetId: target.id,
  });
  const restocked = await f.request(
    `${f.path}/settlements/${stock.id}/decision`,
    { decisionId: stock.decisionId, outcome: 'approved' },
    f.approver,
  );
  assert.equal(restocked.state, 'verified', JSON.stringify(restocked));

  // A purchase order the JTL purchasing system accepts and a fresh read verifies.
  const procurement = (path, body, cookie = f.requester) =>
    f.request(`/procurement${path}`, body, cookie);
  const supplier = await procurement('/suppliers', {
    id: randomUUID(),
    name: 'Nordwind Textil',
    externalReferences: [],
  });
  await procurement(`/suppliers/${supplier.id}/link`, {
    expectedRevision: 1,
    link: {
      connectionId: f.manifest.connections.jtl,
      externalId: '1',
      scopeKey: '',
    },
    confirmationHours: 48,
  });
  const sku = (
    await f.db.owner.query(
      `SELECT canonical_id FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=$2
       AND resource='sku' AND external_id='2'`,
      [f.org, f.manifest.connections.jtl],
    )
  ).rows[0].canonical_id;
  const order = await procurement('/purchase-orders', {
    id: randomUUID(),
    supplierId: supplier.id,
    reference: 'PO-2026-EVIDENCE',
    lines: [
      {
        id: randomUUID(),
        sku,
        description: 'Canvas tote',
        quantity: 20,
        unit: 'each',
      },
    ],
  });
  const requestedDeliveryDate = new Date(Date.now() + 14 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const submission = await procurement(
    `/purchase-orders/${order.id}/submissions`,
    { id: randomUUID(), requestedDeliveryDate },
  );
  const submitted = await procurement(
    `/submissions/${submission.id}/decision`,
    { decisionId: submission.decisionId, outcome: 'approved' },
    f.approver,
  );
  assert.equal(submitted.state, 'submitted', JSON.stringify(submitted));

  const context = await t.newContext({
    baseURL: origin,
    viewport: { width: 1280, height: 1000 },
    reducedMotion: 'reduce',
  });
  await context.addCookies(
    f.requester.split('; ').map((value) => {
      const [name, ...rest] = value.split('=');

      return { name, value: rest.join('='), url: origin };
    }),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  // The verified submission: open its evidence from the keyboard.
  await page.goto(`/app/${f.org}/procurement/${order.id}`);
  await page
    .getByRole('heading', { name: 'PO-2026-EVIDENCE', exact: true })
    .waitFor();
  const submissionSummary = page.getByText(/^Submission evidence \(/);
  await submissionSummary.focus();
  await page.keyboard.press('Enter');
  const submissionEvidence = page
    .locator('details', { has: submissionSummary })
    .getByRole('list', { name: 'Cited evidence' });
  await expect(
    submissionEvidence.getByText('Write receipt', { exact: true }),
  ).toBeVisible();
  await expect(
    submissionEvidence.getByText(/^Accepted by JTL, /).first(),
  ).toBeVisible();
  await expect(
    submissionEvidence.getByText(/^Read from JTL, /).first(),
  ).toBeVisible();
  await expect(
    submissionEvidence.getByText('Complete', { exact: true }).first(),
  ).toBeVisible();
  await expect(
    submissionEvidence.getByText(submitted.externalOrder.externalId).first(),
  ).toBeVisible();
  await expect(submissionEvidence.getByText('Not found')).toHaveCount(0);
  await expect(submissionEvidence.getByText('Not retained')).toHaveCount(0);

  // The same evidence from the purchasing timeline's verified entry.
  const timeline = page.getByRole('region', { name: 'Purchasing timeline' });
  const timelineEvidence = timeline
    .locator('details')
    .filter({ hasText: /^Evidence \(/ })
    .first();
  await timelineEvidence.locator('summary').click();
  await expect(
    timelineEvidence.getByRole('list', { name: 'Cited evidence' }),
  ).toBeVisible();
  if (screenshots) {
    await submissionEvidence.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${screenshots}/submission-light.png` });
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.screenshot({ path: `${screenshots}/submission-dark.png` });
    await page.evaluate(() =>
      document.documentElement.classList.remove('dark'),
    );
  }

  // The verified restock on a narrow return case.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/app/${f.org}/returns/cases/${f.detail.case.id}`);
  const settlement = page.getByRole('region', { name: 'Stock and refund' });
  await settlement.getByText('Evidence', { exact: true }).click();
  const settlementEvidence = settlement.getByRole('list', {
    name: 'Cited evidence',
  });
  await expect(
    settlementEvidence.getByText('Provider read', { exact: true }).first(),
  ).toBeVisible();
  await expect(
    settlementEvidence.getByText('Write receipt', { exact: true }),
  ).toBeVisible();
  await expect(
    settlementEvidence.getByText(/^Accepted by JTL, /),
  ).toBeVisible();
  await expect(settlementEvidence.getByText('Not found')).toHaveCount(0);
  if (screenshots) {
    await settlementEvidence.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${screenshots}/settlement-narrow.png` });
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.screenshot({
      path: `${screenshots}/settlement-narrow-dark.png`,
    });
  }
  expect(errors).toEqual([]);
});

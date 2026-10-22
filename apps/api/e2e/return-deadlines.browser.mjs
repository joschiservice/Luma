/* global document, innerWidth */
import { randomUUID } from 'node:crypto';

import { expect, test } from './browser-fixtures.mjs';
import { settlementFixture } from './return-settlement-fixture.mjs';

test('configures deadlines by keyboard and follows independently verified native payment in narrow light and dark layouts', async ({
  resources: t,
  web,
}) => {
  const origin = web.origin,
    f = await settlementFixture(t, { origin });
  await web.route(f.apiOrigin);
  const context = await t.newContext({
    baseURL: origin,
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
  });
  await context.addCookies(
    f.requester.split('; ').map((value) => {
      const [name, ...rest] = value.split('=');

      return { name, value: rest.join('='), url: origin };
    }),
  );
  const page = await context.newPage();
  await page.goto(`/app/${f.org}/returns`);
  await page.getByText('Return deadlines', { exact: true }).click();
  const select = page.getByRole('combobox', { name: 'Deadlines', exact: true });
  await select.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('option', { name: 'Configured', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('option', { name: 'Disabled', exact: true }),
  ).toHaveAttribute('data-highlighted', '');
  await page.keyboard.press('End');
  await expect(
    page.getByRole('option', { name: 'Configured', exact: true }),
  ).toHaveAttribute('data-highlighted', '');
  await page.keyboard.press('Enter');
  await expect(select).toContainText('Configured');
  await page
    .getByRole('spinbutton', {
      name: 'Receipt deadline (hours after case opened)',
      exact: true,
    })
    .fill('1');
  await page
    .getByRole('button', { name: 'Save deadlines', exact: true })
    .click();
  await expect
    .poll(async () => (await f.request('/return-deadlines')).policy?.enabled)
    .toBe(true);
  await page.goto(`/app/${f.org}/returns/cases/${f.detail.case.id}`);
  const waiting = page.getByRole('region', { name: 'Waiting and deadlines' });
  await waiting
    .getByRole('button', { name: 'Check progress', exact: true })
    .click();
  await expect(
    waiting.getByText('Financial action not sent to source', { exact: true }),
  ).toBeVisible();
  await expect(
    waiting.getByText('Owner: Synthetic pilot operator', { exact: true }),
  ).toBeVisible();
  const refund = await f.request(`${f.path}/settlements`, {
    id: randomUUID(),
    kind: 'refund',
  });
  await f.request(
    `${f.path}/settlements/${refund.id}/decision`,
    { decisionId: refund.decisionId, outcome: 'approved' },
    f.approver,
  );
  await waiting
    .getByRole('button', { name: 'Check progress', exact: true })
    .click();
  await expect(
    waiting.getByText('Money pending', { exact: true }),
  ).toBeVisible();
  // Needs you: the case's due wait, named as what it cites, opens the refund read it waits on.
  const casePage = page.url();
  await page.goto(
    `/app/${f.org}/needs-you?item=${encodeURIComponent(`return-case:${f.detail.case.id}`)}`,
  );
  await page.getByText('Evidence: deadline wait', { exact: true }).click();
  const waitEvidence = page.getByRole('list', { name: 'Cited evidence' });
  await expect(waitEvidence.getByText(/^Read from /).first()).toBeVisible();
  await expect(waitEvidence.getByText('Not found')).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.goto(casePage);
  await waiting
    .getByRole('button', { name: 'Check progress', exact: true })
    .waitFor();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await f.command({ kind: 'refund-settle', order: f.providerOrderId });
  await waiting
    .getByRole('button', { name: 'Check progress', exact: true })
    .click();
  await expect(
    waiting.getByText('Verified progress', { exact: true }).last(),
  ).toBeVisible();
  expect(
    (await f.request(`${f.path}/waiting`)).episodes.filter((e) =>
      ['waiting', 'escalated'].includes(e.state),
    ),
  ).toEqual([]);
  await context.close();
});

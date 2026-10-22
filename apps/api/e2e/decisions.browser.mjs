/* global document */
import { randomUUID } from 'node:crypto';

import { processWorkflowId } from '@luma/workflow-temporal';

import { expect, test } from './browser-fixtures.mjs';
import { replenishmentFixture } from './replenishment-fixture.mjs';

test('finds a replenishment approval in Needs you, decides it once and updates every surface', async ({
  resources: t,
  web,
}) => {
  const origin = web.origin;
  const f = await replenishmentFixture(t, origin);
  await web.route(f.apiOrigin);
  const contextFor = async (cookie) => {
    const context = await t.newContext({
      baseURL: origin,
      viewport: { width: 1440, height: 1000 },
      timezoneId: 'Asia/Tokyo',
    });
    await context.addCookies(
      cookie.split('; ').map((value) => {
        const [name, ...rest] = value.split('=');

        return { name, value: rest.join('='), url: origin };
      }),
    );

    return context;
  };
  const rule = await f.configure();
  const run = await f.request('/replenishment/starts', {
    id: randomUUID(),
    activationId: rule.id,
  });
  await f.waitFor(run.id, 'awaiting_decision');
  const review = await f.request(`/replenishment/runs/${run.id}`);
  expect(review.context.productTitle).toBe('Canvas tote');
  const title = `Approve purchase-order draft for 50 × ${review.context.productTitle} (${f.position.sku})`;
  const path = `/app/${f.manifest.organizationId}/needs-you`;

  // The requester sees the decision, but it waits for a different approver.
  const requester = await (await contextFor(f.ownerCookie)).newPage();
  requester.setDefaultTimeout(20000);
  const errors = [];
  requester.on('pageerror', (error) => errors.push(error.message));
  await requester.goto(`/app/${f.manifest.organizationId}/home`);
  const attention = requester.getByRole('region', {
    name: 'Needs you',
  });
  await expect(attention.getByText(title)).toHaveCount(0);
  await requester.goto(path);
  await requester.getByText('Waiting on others', { exact: true }).click();
  const requested = requester.getByRole('link', { name: title, exact: true });
  await expect(requested).toBeVisible();
  await expect(
    requester
      .locator('li')
      .filter({ has: requested })
      .getByText('Waiting for another approver'),
  ).toBeVisible();

  // A different admin opens it, takes it and reads the exact change before approving.
  const approver = await (await contextFor(f.approverCookie)).newPage();
  approver.setDefaultTimeout(20000);
  approver.on('pageerror', (error) => errors.push(error.message));
  await approver.goto(path);
  await approver
    .getByRole('link', { name: title })
    .getByText('Needs your approval')
    .waitFor();
  // J focuses the first decision and Space opens it beside the queue.
  await approver.keyboard.press('j');
  await approver.keyboard.press('Space');
  await approver.waitForURL(/item=/);
  if (!(await approver.getByRole('heading', { name: title }).isVisible()))
    await approver.getByRole('link', { name: title }).click();
  const inspector = approver.getByRole('region', {
    name: 'Selected decision',
  });
  await inspector.getByRole('heading', { name: title }).waitFor();
  await inspector.getByText('Needs your approval').first().waitFor();
  await inspector.getByLabel('Recorded stock context').waitFor();
  await inspector
    .getByRole('region', { name: 'Cost and demand at proposal time' })
    .waitFor();
  expect(
    await inspector.getByText(/available, below the minimum of/).count(),
  ).toBe(0);
  await inspector
    .getByText('Nothing is sent now.', {
      exact: false,
    })
    .first()
    .waitFor();
  await inspector.getByRole('button', { name: 'Take it' }).click();
  await inspector.getByRole('button', { name: 'Unassign me' }).waitFor();

  // A reload restores the selected decision from the URL.
  await approver.reload();
  await inspector.getByRole('heading', { name: title }).waitFor();

  // The owner's review takes the one decision; Needs you and the run follow it.
  await inspector.getByRole('button', { name: 'Approve 50 units' }).click();
  await expect(inspector.getByText('You answered this at')).toBeVisible();
  await expect(
    inspector.getByText('Needs your approval', { exact: true }),
  ).toHaveCount(0);
  await expect(inspector.getByRole('button', { name: 'Take it' })).toHaveCount(
    0,
  );
  await f.temporal.client.workflow
    .getHandle(processWorkflowId(f.manifest.organizationId, run.id))
    .signal('processDecisionChanged');
  await expect(inspector.getByText('You answered this at')).toBeVisible();
  await requested.waitFor({ state: 'detached', timeout: 45000 });
  await f.waitFor(run.id, 'verified');
  await expect(
    inspector.getByText('A fresh independent check confirmed the result.'),
  ).toBeVisible({ timeout: 45000 });
  await approver.reload();
  await expect(inspector.getByText('You answered this at')).toBeVisible();
  await expect(
    inspector.getByRole('link', { name: 'Open purchase order' }),
  ).toHaveAttribute('href', /procurement\//);
  await expect(
    inspector.getByRole('link', { name: 'Open workflow run' }),
  ).toHaveAttribute('href', new RegExp(`run-${run.id}`));
  expect(
    (await inspector.locator('time').allTextContents()).every((time) =>
      time.includes('UTC'),
    ),
  ).toBe(true);
  await expect(
    inspector.getByRole('button', { name: 'Approve 50 units' }),
  ).toHaveCount(0);
  expect(
    (
      await f.request(`/replenishment/runs/${run.id}`, undefined, {
        cookie: f.approverCookie,
      })
    ).canRespond,
  ).toBe(false);

  // Escape returns to the list with focus on it.
  await inspector.press('Escape');
  await approver.waitForURL((url) => !url.searchParams.has('item'));

  // Narrow screens show one pane without horizontal scrolling.
  await requester.setViewportSize({ width: 390, height: 844 });
  await expect(
    requester.getByRole('button', { name: 'Filters', exact: true }),
  ).toHaveCount(0);
  expect(
    (await requester.locator('.decisions-toolbar').boundingBox()).height,
  ).toBeLessThan(280);
  expect(
    await requester.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

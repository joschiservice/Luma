/* global document */
import { randomUUID } from 'node:crypto';

import { processWorkflowId } from '@luma/workflow-temporal';

import { expect, test } from './browser-fixtures.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { replenishmentFixture } from './replenishment-fixture.mjs';

test('finds a replenishment approval in Needs you, decides it once and updates every surface', async ({
  resources: t,
}) => {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const f = await replenishmentFixture(t, origin);
  const web = startProcess(
    t,
    'e2e/web-server.mjs',
    { TEST_API_ORIGIN: f.apiOrigin, TEST_WEB_PORT: String(port) },
    true,
  );
  await web.message('listening');
  const contextFor = async (cookie) => {
    const context = await t.newContext({
      baseURL: origin,
      viewport: { width: 1440, height: 1000 },
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
  const title = `Approve purchase-order draft for 50 × ${f.position.sku}`;
  const path = `/app/${f.manifest.organizationId}/needs-you`;

  // The requester sees the decision, but it waits for a different approver.
  const requester = await (await contextFor(f.ownerCookie)).newPage();
  requester.setDefaultTimeout(20000);
  const errors = [];
  requester.on('pageerror', (error) => errors.push(error.message));
  await requester.goto(`/app/${f.manifest.organizationId}/home`);
  const attention = requester.getByRole('region', {
    name: 'Needs your attention',
  });
  await attention.getByText(title).waitFor();
  await attention.getByRole('link', { name: 'Open Needs you' }).click();
  await requester.waitForURL(`**${path}`);
  const requested = requester.getByRole('link', { name: new RegExp(title) });
  await requested.getByText('Needs another approver').waitFor();
  await requester
    .getByRole('navigation', { name: 'Workspace navigation' })
    .getByRole('link', { name: /Needs you/ })
    .getByText('need you')
    .waitFor({ state: 'attached' });

  // A different admin opens it, takes it and reads the exact change before approving.
  const approver = await (await contextFor(f.approverCookie)).newPage();
  approver.setDefaultTimeout(20000);
  approver.on('pageerror', (error) => errors.push(error.message));
  await approver.goto(path);
  await approver
    .getByRole('link', { name: new RegExp(title) })
    .getByText('Needs your approval')
    .waitFor();
  await approver.keyboard.press('j');
  await approver.waitForURL(/item=/);
  if (!(await approver.getByRole('heading', { name: title }).isVisible()))
    await approver.getByRole('link', { name: new RegExp(title) }).click();
  const inspector = approver.getByRole('region', {
    name: 'Selected decision',
  });
  await inspector.getByRole('heading', { name: title }).waitFor();
  await inspector.getByText('Needs your approval').first().waitFor();
  await inspector.getByText('Purchase-order draft, not sent').waitFor();
  await inspector
    .getByText('Nothing is sent to the supplier.', {
      exact: false,
    })
    .waitFor();
  await inspector.getByRole('button', { name: 'Take it' }).click();
  await inspector.getByRole('button', { name: 'Release' }).waitFor();
  await approver.screenshot({
    path: '/tmp/luma78-needs-you-desktop.png',
    fullPage: true,
  });

  // A reload restores the selected decision from the URL.
  await approver.reload();
  await inspector.getByRole('heading', { name: title }).waitFor();

  // The owner's review takes the one decision; Needs you and the run follow it.
  await inspector.getByRole('button', { name: 'Approve 50 units' }).click();
  await inspector.getByText('Decision recorded.', { exact: false }).waitFor();
  await f.temporal.client.workflow
    .getHandle(processWorkflowId(f.manifest.organizationId, run.id))
    .signal('processDecisionChanged');
  await inspector
    .getByText('This decision has left the queue')
    .waitFor({ timeout: 45000 });
  await requested.waitFor({ state: 'detached', timeout: 45000 });
  await f.waitFor(run.id, 'verified');
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
  await requester.setViewportSize({ width: 375, height: 812 });
  await requester.screenshot({
    path: '/tmp/luma78-needs-you-mobile.png',
    fullPage: true,
  });
  expect(
    await requester.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

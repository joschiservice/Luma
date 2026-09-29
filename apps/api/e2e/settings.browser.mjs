/* global document */
import { expect, test } from './browser-fixtures.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { invitationProof, settingsFixture } from './settings-fixture.mjs';

test('manages workspace preferences and the complete invitation journey on desktop and narrow screens', async ({
  resources: t,
}) => {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const f = await settingsFixture(t, origin);
  const apiOrigin = await f.app.listen({ host: '127.0.0.1', port: 0 });
  const web = startProcess(
    t,
    'e2e/web-server.mjs',
    { TEST_API_ORIGIN: apiOrigin, TEST_WEB_PORT: String(port) },
    true,
  );
  await web.message('listening');
  const context = await t.newContext({
    baseURL: origin,
    viewport: { width: 1440, height: 1000 },
  });
  await context.addCookies(
    f.owner.cookie.split('; ').map((value) => {
      const [name, ...rest] = value.split('=');

      return { name, value: rest.join('='), url: origin };
    }),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/app/${f.org.id}/settings/workspace`);
  await page.getByRole('heading', { name: 'Workspace', exact: true }).waitFor();
  expect(await page.getByText('Personal', { exact: true }).count()).toBe(1);
  expect(
    await page
      .getByRole('heading', { name: 'Settings', exact: true, level: 1 })
      .count(),
  ).toBe(1);
  const nameHeight = await page
    .getByLabel('Workspace name')
    .evaluate((input) => input.getBoundingClientRect().height);
  const timezone = page.getByRole('combobox', { name: 'Display timezone' });
  const timezoneHeight = await timezone.evaluate(
    (input) => input.getBoundingClientRect().height,
  );
  expect(nameHeight).toBe(timezoneHeight);
  await page.getByLabel('Workspace name').fill('Northstar Japan');
  await timezone.click();
  expect(
    await page
      .locator('.searchable-select-empty')
      .evaluate((element) => element.getBoundingClientRect().height),
  ).toBe(0);
  await timezone.fill('Tokyo');
  await page.getByRole('option', { name: 'Asia/Tokyo', exact: true }).click();
  // Lose a committed response; the original command must reconcile without a second write.
  await page.route(
    '**/settings/workspace',
    async (route) => {
      if (route.request().method() === 'PATCH') {
        await route.fetch();
        await route.abort('failed');
      } else await route.continue();
    },
    { times: 1 },
  );
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByRole('button', { name: 'Check status and retry' }).click();
  await page.getByText('Changes saved.', { exact: true }).waitFor();
  await page.reload();
  expect(await page.getByLabel('Workspace name').inputValue()).toBe(
    'Northstar Japan',
  );
  await page.screenshot({
    path: '/tmp/luma63-workspace-desktop.png',
    fullPage: true,
  });
  const overview = await context.newPage();
  await overview.goto(`/app/${f.org.id}/home`);
  await overview
    .getByText(/Asia\/Tokyo/)
    .first()
    .waitFor();
  await overview.close();
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'Notifications' })
    .click();
  await page.getByRole('switch', { name: 'Issues that need you' }).click();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByText('Changes saved.', { exact: true }).waitFor();
  await page.reload();
  expect(
    await page
      .getByRole('switch', { name: 'Issues that need you' })
      .getAttribute('aria-checked'),
  ).toBe('true');
  await page.getByRole('button', { name: 'Send test email' }).click();
  await f.drain();
  await page.getByText('Test email accepted for delivery.').waitFor();
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'Approvals' })
    .click();
  await page.getByRole('switch', { name: 'Always require approval' }).focus();
  await page.keyboard.press('Space');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page
    .getByText('Approval preference saved. Older reviews must be refreshed.')
    .waitFor();
  await page.reload();
  expect(
    await page
      .getByRole('switch', { name: 'Always require approval' })
      .getAttribute('aria-checked'),
  ).toBe('true');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: '/tmp/luma63-approvals-mobile.png',
    fullPage: true,
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= 390),
  ).toBe(true);
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'Team', exact: true })
    .click();
  await page.getByRole('button', { name: 'Invite teammate' }).click();
  await page.getByLabel('Email address').fill(f.outsider.email);
  await page
    .getByRole('button', { name: 'Send invitation', exact: true })
    .click();
  await page
    .getByText('Invitation queued. Access starts when it is accepted.')
    .waitFor();
  await f.drain();
  await page
    .getByText('Email sent · Pending acceptance', { exact: false })
    .waitFor();
  const proof = invitationProof(
    [...f.messages.values()].find((message) => message.to === f.outsider.email),
  );
  const invitedContext = await t.newContext({
    baseURL: origin,
    viewport: { width: 390, height: 844 },
  });
  const recipient = await invitedContext.newPage();
  recipient.setDefaultTimeout(12000);
  await recipient.goto(
    `/app/invitations/${proof.organizationId}/${proof.invitationId}#${proof.token}`,
  );
  await recipient.getByLabel('Email', { exact: true }).waitFor();
  expect(recipient.url()).not.toContain(proof.token);
  await recipient.reload();
  await recipient.getByLabel('Email', { exact: true }).fill(f.outsider.email);
  await recipient
    .getByLabel('Password', { exact: true })
    .fill('settings-test-password-123');
  await recipient.getByRole('button', { name: 'Sign in', exact: true }).click();
  await recipient.getByRole('button', { name: 'Accept invitation' }).click();
  await recipient.waitForURL(`**/app/${f.org.id}/home*`);
  await page.reload();
  await page.getByRole('button', { name: 'Manage Outsider' }).click();
  await page.getByRole('combobox', { name: 'Member role' }).click();
  await page.getByRole('option', { name: 'Admin', exact: true }).click();
  await page.getByRole('button', { name: 'Save role' }).click();
  await page.getByText('Member role updated.').waitFor();
  await page.getByRole('button', { name: 'Manage Outsider' }).click();
  await page.getByRole('button', { name: 'Remove access' }).click();
  await page.getByText('Workspace access removed.').waitFor();
  await recipient.goto(`/app/${f.org.id}/settings/workspace`);
  await recipient
    .getByRole('heading', { name: 'Workspace unavailable' })
    .waitFor();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: '/tmp/luma63-team-desktop.png',
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

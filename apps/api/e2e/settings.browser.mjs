/* global document */
import { expect, test } from './browser-fixtures.mjs';
import { until } from './helpers.mjs';
import { invitationProof, settingsFixture } from './settings-fixture.mjs';

test('manages workspace preferences and the complete invitation journey on desktop and narrow screens', async ({
  resources: t,
  web,
}) => {
  const origin = web.origin;
  const f = await settingsFixture(t, origin);
  const apiOrigin = await f.app.listen({ host: '127.0.0.1', port: 0 });
  await web.route(apiOrigin);
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
  const timezone = page.getByRole('combobox', { name: 'Time zone' });
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
  // The reload that follows stays held until the retry: recovery must not wait for it.
  let lost = false;
  let releaseReload = () => {};
  const reload = new Promise((resolve) => {
    releaseReload = resolve;
  });
  /** @param {import('@playwright/test').Route} route */
  const holdReload = async (route) => {
    const request = route.request();
    if (
      lost &&
      request.method() === 'GET' &&
      ['fetch', 'xhr'].includes(request.resourceType())
    )
      await reload;
    await route.fallback();
  };
  await page.route('**/*', holdReload);
  await page.route(
    '**/settings/workspace',
    async (route) => {
      if (route.request().method() === 'PATCH') {
        await route.fetch();
        lost = true;
        await route.abort('failed');
      } else await route.continue();
    },
    { times: 1 },
  );
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByRole('button', { name: 'Check status and retry' }).click();
  releaseReload();
  await page.unroute('**/*', holdReload);
  await page.getByText('Changes saved.', { exact: true }).waitFor();
  await page.reload();
  expect(await page.getByLabel('Workspace name').inputValue()).toBe(
    'Northstar Japan',
  );
  const overview = await context.newPage();
  await overview.goto(`/app/${f.org.id}/home`);
  // Workspace times leave the zone out and name it in the title, such as "… 15:39:02 GMT+9".
  await overview
    .locator('time[title*="GMT+9"], time[title*="JST"]')
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
    .getByText(
      'Approval setting saved. Open reviews must be refreshed before their changes run.',
    )
    .waitFor();
  await page.reload();
  expect(
    await page
      .getByRole('switch', { name: 'Always require approval' })
      .getAttribute('aria-checked'),
  ).toBe('true');
  const independent = page.getByRole('switch', {
    name: 'Require approval from another person',
    exact: true,
  });
  await expect(independent).toBeChecked();
  await independent.focus();
  await page.keyboard.press('Space');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Save changes', exact: true }),
  ).toBeDisabled();
  await page.reload();
  await expect(independent).not.toBeChecked();
  // Restore the team preference; a solo workspace should override it without losing it.
  await independent.click();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Save changes', exact: true }),
  ).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
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
    .getByText('Invitation queued. Access starts when they accept.')
    .waitFor();
  await f.drain();
  await page
    .getByText('Email sent. Waiting for them to accept.', { exact: false })
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
  await page.getByRole('radio', { name: /^Admin/ }).check();
  await page.getByRole('button', { name: 'Save role' }).click();
  await page
    .getByText('Role changed. It applies from their next action in Luma.')
    .waitFor();
  await page.getByRole('button', { name: 'Manage Outsider' }).click();
  await page.getByRole('button', { name: 'Remove access' }).click();
  await page.getByText('Workspace access removed.').waitFor();
  await recipient.goto(`/app/${f.org.id}/settings/workspace`);
  await recipient
    .getByRole('heading', { name: 'Workspace unavailable' })
    .waitFor();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await f.request(
    f.owner,
    `${f.base}/members/${f.membership.id}`,
    'DELETE',
    undefined,
    204,
  );
  await page.goto(`/app/${f.org.id}/settings/approvals`);
  await expect(independent).toBeDisabled();
  await expect(independent).not.toBeChecked();
  await expect(
    page.getByText(
      'Off while only one member has workspace access, so you can approve your own changes.',
      { exact: false },
    ),
  ).toBeVisible();
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(independent).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= 390),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test('stores the language picked in the browser on the account for email', async ({
  resources: t,
  web,
}) => {
  const origin = web.origin;
  const f = await settingsFixture(t, origin);
  const apiOrigin = await f.app.listen({ host: '127.0.0.1', port: 0 });
  await web.route(apiOrigin);
  const context = await t.newContext({ baseURL: origin });
  await context.addCookies([
    ...f.member.cookie.split('; ').map((value) => {
      const [name, ...rest] = value.split('=');

      return { name, value: rest.join('='), url: origin };
    }),
    { name: 'luma_locale', value: 'de', url: origin },
  ]);
  const page = await context.newPage();
  await page.goto(`/app/${f.org.id}/settings/notifications`);
  await page.getByRole('heading', { name: 'Benachrichtigungen' }).waitFor();
  await until(
    async () =>
      (
        await f.db.owner.query('SELECT locale FROM users WHERE id=$1', [
          f.member.id,
        ])
      ).rows[0]?.locale === 'de',
    'the account to store German',
  );

  // Email written after the change uses the stored language.
  await page.getByRole('button', { name: 'Test-E-Mail senden' }).click();
  await until(async () => {
    await f.drain();

    return [...f.messages.values()].some(
      (message) =>
        message.to === f.member.email &&
        message.subject === 'Deine Luma-Test-E-Mail',
    );
  }, 'a German test email');
});

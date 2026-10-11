/* global document */
import { expect, test } from './browser-fixtures.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { invitationProof, settingsFixture } from './settings-fixture.mjs';

test('creates a custom role, invites with it, restricts views and applies edits on refresh', async ({
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

  // Create a role from scratch and review it before it is saved.
  await page.goto(`/app/${f.org.id}/settings/roles`);
  await page.getByRole('heading', { name: /^Roles/ }).waitFor();
  await page.getByRole('link', { name: /Member/ }).waitFor();
  await page.getByRole('button', { name: 'Create role' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Buyer');
  await page.getByLabel('Description').fill('Works with purchase orders.');
  await page.getByRole('button', { name: 'Continue to permissions' }).click();
  await page.getByRole('switch', { name: 'View procurement' }).click();
  // Keyboard users toggle permissions with Space.
  await page.getByRole('switch', { name: 'View orders' }).focus();
  await page.keyboard.press('Space');
  expect(
    await page.getByRole('switch', { name: 'View orders' }).isChecked(),
  ).toBe(true);
  await page.getByRole('button', { name: 'Review and create' }).click();
  const review = page.getByRole('dialog', { name: 'Create Buyer' });
  await review.getByText('View procurement').waitFor();
  await review.getByRole('button', { name: 'Create role' }).click();
  await page.waitForURL(/role=/);
  await page.getByRole('heading', { name: /^Buyer/ }).waitFor();

  // Invite a teammate with the new role.
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'Team', exact: true })
    .click();
  await page.getByRole('button', { name: 'Invite teammate' }).click();
  await page.getByLabel('Email address').fill(f.outsider.email);
  await page.getByRole('radio', { name: /^Buyer/ }).check();
  await page
    .getByRole('button', { name: 'Send invitation', exact: true })
    .click();
  await page
    .getByText('Invitation queued. Access starts when they accept.')
    .waitFor();
  await f.drain();
  const proof = invitationProof(
    [...f.messages.values()].find((message) => message.to === f.outsider.email),
  );

  // Accept and confirm what the role allows.
  const invitedContext = await t.newContext({
    baseURL: origin,
    viewport: { width: 1280, height: 900 },
  });
  const teammate = await invitedContext.newPage();
  teammate.setDefaultTimeout(12000);
  teammate.on('pageerror', (error) => errors.push(error.message));
  await teammate.goto(
    `/app/invitations/${proof.organizationId}/${proof.invitationId}#${proof.token}`,
  );
  await teammate.getByLabel('Email', { exact: true }).fill(f.outsider.email);
  await teammate
    .getByLabel('Password', { exact: true })
    .fill('settings-test-password-123');
  await teammate.getByRole('button', { name: 'Sign in', exact: true }).click();
  await teammate.getByText('Buyer', { exact: true }).waitFor();
  await teammate.getByRole('button', { name: 'Accept invitation' }).click();
  await teammate.waitForURL(`**/app/${f.org.id}/home*`);
  const navigation = teammate.getByRole('navigation', {
    name: 'Workspace navigation',
  });
  await navigation.getByRole('link', { name: 'Procurement' }).waitFor();
  expect(
    await navigation.getByRole('link', { name: 'Inventory' }).count(),
  ).toBe(0);
  await teammate.goto(`/app/${f.org.id}/inventory`);
  await teammate
    .getByRole('heading', { name: 'You don’t have access to inventory' })
    .waitFor();
  await teammate.getByText('View inventory', { exact: true }).waitFor();
  await teammate.goto(`/app/${f.org.id}/settings/workspace`);
  await teammate.getByText(/Changing it requires/).waitFor();
  expect(await teammate.getByLabel('Workspace name').isDisabled()).toBe(true);

  // Grant inventory access; it applies on the teammate's next request.
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'Roles', exact: true })
    .click();
  await page.getByRole('link', { name: /Buyer/ }).click();
  await page.getByRole('switch', { name: 'View inventory' }).click();
  await page.getByRole('button', { name: 'Review changes' }).click();
  const changes = page.getByRole('dialog', {
    name: 'Review changes to Buyer',
  });
  await changes.getByText('These changes apply to 1 person').waitFor();
  await changes.getByRole('button', { name: 'Save changes' }).click();
  await page
    .getByText(
      'Role saved. Changes apply from each person’s next action in Luma.',
    )
    .waitFor();
  await page.getByRole('tab', { name: /History/ }).click();
  await page.getByText(/joined with this role/).waitFor();
  // The saved revision arrives without resetting the editor or dropping the confirmation.
  await page.getByText(/Granted: View inventory/).waitFor();
  await page.getByRole('tab', { name: /Permissions/ }).click();
  await expect(
    page.getByText(
      'Role saved. Changes apply from each person’s next action in Luma.',
    ),
  ).toBeVisible();
  await teammate.goto(`/app/${f.org.id}/inventory`);
  await teammate.reload();
  await teammate
    .getByRole('heading', { name: 'Inventory', level: 1 })
    .waitFor();
  expect(
    await teammate.getByText('You don’t have access to inventory').count(),
  ).toBe(0);

  // The editor stays usable on narrow screens and in the dark theme.
  const narrow = await t.newContext({
    baseURL: origin,
    viewport: { width: 390, height: 844 },
    colorScheme: 'dark',
  });
  await narrow.addCookies(
    f.owner.cookie.split('; ').map((value) => {
      const [name, ...rest] = value.split('=');

      return { name, value: rest.join('='), url: origin };
    }),
  );
  const small = await narrow.newPage();
  small.setDefaultTimeout(12000);
  await small.goto(`/app/${f.org.id}/settings/roles`);
  await small.getByRole('link', { name: /Buyer/ }).click();
  await small.getByRole('switch', { name: 'View inventory' }).waitFor();
  expect(
    await small.evaluate(() => document.documentElement.scrollWidth <= 390),
  ).toBe(true);
  await small.screenshot({
    path: '/tmp/luma135-role-narrow-dark.png',
    fullPage: true,
  });
  await page.screenshot({
    path: '/tmp/luma135-role-desktop.png',
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

/* global document, innerWidth */
import { expect, test } from './browser-fixtures.mjs';
import { availablePort, startProcess } from './helpers.mjs';
import { settingsFixture } from './settings-fixture.mjs';

const password = 'settings-test-password-123';
const newPassword = 'new-browser-password-123';

test('changes a password, signs out devices and recovers through a single-use email link', async ({
  resources: t,
}) => {
  const port = await availablePort();
  const origin = `http://localhost:${port}`;
  const f = await settingsFixture(t, origin);
  const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
  const web = startProcess(
    t,
    'e2e/web-server.mjs',
    { TEST_API_ORIGIN: address, TEST_WEB_PORT: String(port) },
    true,
  );
  await web.message('listening');
  const page = await t.newPage({
    baseURL: origin,
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/sign-in');
  await page.getByLabel('Email', { exact: true }).fill(f.owner.email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Needs you', exact: true }),
  ).toBeVisible();
  const security = `/app/${f.org.id}/settings/security`;
  await page.goto(security);
  const sessions = page.getByRole('list', { name: 'Active sessions' });
  await expect(sessions.getByRole('listitem')).toHaveCount(2);
  await page
    .getByRole('button', { name: 'Change password', exact: true })
    .click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Current password').fill('wrong-password-123');
  await dialog.getByLabel('New password').fill(newPassword);
  await dialog.getByRole('button', { name: 'Change password' }).click();
  await expect(dialog.getByRole('alert')).toHaveText(
    'That current password isn’t correct.',
  );
  await dialog.getByLabel('Current password').fill(password);
  await dialog.getByLabel('New password').fill(newPassword);
  await dialog.getByLabel('Sign out other devices').check();
  await dialog.getByRole('button', { name: 'Change password' }).click();
  await expect(dialog).toBeHidden();
  await expect(sessions.getByRole('listitem')).toHaveCount(1);
  await f.request(f.owner, '/v1/organizations', 'GET', undefined, 401);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);

  await page.goto('/sign-out');
  await page.getByRole('link', { name: 'Forgot password?' }).click();
  await expect(
    page.getByRole('heading', { name: 'Reset your password', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill(f.owner.email);
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue(
    f.owner.email,
  );
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('status')).toContainText('If an account exists');
  await f.drain();
  const mail = [...f.messages.values()].find(
    (m) => m.subject === 'Reset your Luma password',
  );
  expect(mail).toBeDefined();
  const link = mail.text.match(/https?:\/\/\S+/)[0];
  await page.goto(link);
  await expect(
    page.getByRole('heading', { name: 'Choose a new password' }),
  ).toBeVisible();
  await expect.poll(() => new URL(page.url()).hash).toBe('');
  await page.getByLabel('New password').fill(password);
  await page.getByRole('button', { name: 'Reset password' }).click();
  await expect(page.getByRole('status')).toContainText('Password reset.');
  await page.goto(link);
  await page.getByLabel('New password').fill(newPassword);
  await page.getByRole('button', { name: 'Reset password' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'invalid, expired or already used',
  );
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill(f.owner.email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Needs you', exact: true }),
  ).toBeVisible();
  await page.goto(security);
  await expect(sessions.getByRole('listitem')).toHaveCount(1);
  await sessions.getByRole('button', { name: 'Sign out', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Sign out', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Sign in to Luma' }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

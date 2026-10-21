/* global document, innerWidth */
import { randomUUID } from 'node:crypto';

import { seedLocalStaff } from '@luma/staff/composition';

import { expect, test } from './browser-fixtures.mjs';
import {
  addMembership,
  availablePort,
  database,
  signup,
  startApi,
  startProcess,
} from './helpers.mjs';

const password = 'support-view-browser-password-long';

/** Starts the customer app and API, the staff console and API, and a workspace with two people. */
async function fixture(t) {
  const webPort = await availablePort();
  const staffWebPort = await availablePort();
  const staffApiPort = await availablePort();
  const customerOrigin = `http://localhost:${webPort}`;
  const staffOrigin = `http://127.0.0.1:${staffWebPort}`;
  const db = await database(t);
  await db.migrate();
  await db.grantRuntime();
  const api = await startApi(t, db, customerOrigin);
  const owner = await signup(api, 'owner');
  const member = await signup(api, 'member');
  const { body: workspace } = await api.request('/v1/organizations', {
    method: 'POST',
    cookie: owner.cookie,
    body: { name: 'Support North', slug: 'support-north' },
    status: 201,
  });
  await addMembership(db.owner, workspace.id, member.userId, 'member');
  const web = startProcess(
    t,
    'e2e/web-server.mjs',
    { TEST_API_ORIGIN: api.origin, TEST_WEB_PORT: String(webPort) },
    true,
  );
  await web.message('listening');

  const login = `support_view_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(db.ownerUrl);
  url.username = login;
  url.password = randomUUID();
  // Both identifiers and password are generated UUIDs, not caller-provided SQL.
  await db.owner.query(
    `CREATE ROLE "${login}" LOGIN PASSWORD '${url.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
  );
  await db.owner.query(`GRANT luma_staff_runtime TO "${login}"`);
  t.onTestFinished(() =>
    db.owner.query(`DROP OWNED BY "${login}"; DROP ROLE "${login}"`),
  );
  const env = {
    NODE_ENV: 'test',
    STAFF_DATABASE_URL: url.toString(),
    STAFF_AUTH_SECRET: 'support-view-staff-secret-at-least-32-characters',
    STAFF_PUBLIC_ORIGIN: staffOrigin,
    STAFF_CUSTOMER_ORIGIN: customerOrigin,
    STAFF_AUTH_MODE: 'local',
    STAFF_API_HOST: '127.0.0.1',
    STAFF_API_PORT: String(staffApiPort),
    STAFF_TRUSTED_PROXY: '127.0.0.1',
    STAFF_COOKIE_PREFIX: login,
  };
  await seedLocalStaff(
    {
      databaseUrl: env.STAFF_DATABASE_URL,
      secret: env.STAFF_AUTH_SECRET,
      publicOrigin: staffOrigin,
      customerOrigin,
      mode: 'local',
      host: '127.0.0.1',
      port: staffApiPort,
      cookiePrefix: login,
      environment: 'test',
    },
    {
      email: 'support@example.test',
      name: 'Support operator',
      password,
      permissions: [
        'staff.directory.read',
        'staff.workspace.inspect',
        'staff.accounts.inspect',
        'staff.view-as',
      ],
    },
    db.ownerUrl,
  );
  const staffApi = startProcess(t, '../staff-api/dist/index.js', env, true);
  const { address: staffApiOrigin } = await staffApi.message('listening');
  const staffWeb = startProcess(
    t,
    'e2e/staff-web-server.mjs',
    {
      STAFF_WEB_PORT: String(staffWebPort),
      STAFF_API_PROXY_TARGET: staffApiOrigin,
    },
    true,
  );
  await staffWeb.message('listening');

  return {
    db,
    api,
    owner,
    member,
    workspace,
    customerOrigin,
    staffOrigin,
  };
}

async function signedIn(t, origin, cookie) {
  const context = await t.newContext({
    baseURL: origin,
    viewport: { width: 1440, height: 900 },
  });
  await context.addCookies(
    cookie.split('; ').map((value) => {
      const [name, ...rest] = value.split('=');

      return { name, value: rest.join('='), url: origin };
    }),
  );

  return context;
}

/** Signs in to the staff console in a new browser context. */
async function staffPage(t, f, errors) {
  const context = await t.newContext({
    baseURL: f.staffOrigin,
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByLabel('Email', { exact: true }).fill('support@example.test');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Support directory', level: 1 }),
  ).toBeVisible();

  return { context, page };
}

test('staff view a consenting workspace as a member, read-only, until the owner revokes access', async ({
  resources: t,
}) => {
  const f = await fixture(t);
  const errors = [];

  // The owner allows support access from Settings.
  const ownerContext = await signedIn(t, f.customerOrigin, f.owner.cookie);
  const ownerPage = await ownerContext.newPage();
  ownerPage.setDefaultTimeout(12000);
  ownerPage.on('pageerror', (error) => errors.push(error.message));
  await ownerPage.goto(`/app/${f.workspace.id}/settings/support`);
  await expect(
    ownerPage.getByText('Luma support access is off', { exact: true }),
  ).toBeVisible();
  await ownerPage.getByRole('button', { name: 'Allow access' }).click();
  await expect(
    ownerPage.getByText('Luma support access is on', { exact: true }),
  ).toBeVisible();

  // Staff ask to inspect the workspace; nothing opens until the owner approves.
  const { context: staffContext, page: staff } = await staffPage(t, f, errors);
  await staff.getByLabel('Name, email or workspace').fill('Support North');
  await staff.getByRole('button', { name: 'Search', exact: true }).click();
  await staff.getByRole('button', { name: 'Inspect Support North' }).click();
  await staff
    .getByLabel('Support reason or ticket reference')
    .fill('Member reports a missing order on Home');
  await staff
    .getByRole('button', { name: 'Send request', exact: true })
    .click();
  await expect(staff.getByText(/^Waiting for approval from/)).toBeVisible();
  await expect(
    staff.getByRole('button', { name: 'Open workspace' }),
  ).toHaveCount(0);

  // The owner sees the support team's reason and approves in Settings.
  await ownerPage.reload();
  await expect(
    ownerPage.getByRole('heading', { name: 'Inspection requests' }),
  ).toBeVisible();
  await expect(
    ownerPage.getByText('Member reports a missing order on Home'),
  ).toBeVisible();
  await ownerPage.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(
    ownerPage.getByText('Inspection approved for 30 minutes.'),
  ).toBeVisible();
  await expect(
    ownerPage.getByRole('button', { name: 'End inspection' }),
  ).toBeVisible();

  // Staff open the approved access and start a view as the member.
  await staff.getByRole('button', { name: 'Check again' }).click();
  await staff.getByRole('button', { name: 'Open workspace' }).click();
  await expect(
    staff.getByText(/allows read-only support views until/),
  ).toBeVisible();
  await staff
    .getByRole('button', { name: 'View as member@example.test' })
    .click();
  await staff
    .getByLabel('Reason or ticket reference')
    .fill('Reproduce the missing order on Home');
  await staff.getByRole('button', { name: 'Start support view' }).click();
  const link = staff.getByRole('link', { name: 'Open support view' });
  await expect(link).toBeVisible();
  const [view] = await Promise.all([
    staffContext.waitForEvent('page'),
    link.click(),
  ]);
  view.setDefaultTimeout(12000);
  view.on('pageerror', (error) => errors.push(error.message));

  // The customer app shows the member's workspace with a permanent read-only banner.
  const banner = view.getByRole('region', { name: 'Support view' });
  await expect(banner).toContainText('Read-only support view');
  await expect(banner).toContainText('You see Support North as member.');
  await expect(view).toHaveURL(
    new RegExp(`/app/${f.workspace.id}/home(\\?|$)`),
  );
  expect(new URL(view.url()).hash).toBe('');
  await view.goto(
    `${f.customerOrigin}/app/${f.workspace.id}/settings/notifications`,
  );
  await expect(banner).toBeVisible();
  await expect(
    view.getByRole('link', { name: 'Security', exact: true }),
  ).toHaveCount(0);
  await view.getByRole('switch').first().click();
  await view.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(
    view.getByText(
      'Luma support is viewing this workspace read-only. Nothing was changed.',
    ),
  ).toBeVisible();
  await view.setViewportSize({ width: 390, height: 844 });
  await expect(banner).toBeVisible();
  await expect
    .poll(() =>
      view.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  const preferences = await f.db.owner.query(
    'SELECT count(*)::int AS count FROM notification_preferences WHERE tenant_id=$1',
    [f.workspace.id],
  );
  expect(preferences.rows[0].count).toBe(0);

  // Activity shows the inspection grant, the member shown and the path read. The owner then
  // revokes access.
  await ownerPage.goto(`/app/${f.workspace.id}/activity`);
  await expect(
    ownerPage.getByRole('link', {
      name: /^Support inspection requested\b.*Luma support\. Recorded\./,
    }),
  ).toBeVisible();
  await expect(
    ownerPage.getByRole('link', {
      name: /^Support inspection approved for 30 minutes\b.*Recorded\./,
    }),
  ).toBeVisible();
  await expect(
    ownerPage.getByRole('link', {
      name: /^Read-only support view started\. .*member, Luma support\. Recorded\./,
    }),
  ).toBeVisible();
  await expect(
    ownerPage.getByRole('link', {
      name: /^Support view opened a page\. \/settings, Luma support\. Recorded\./,
    }),
  ).toBeVisible();
  await ownerPage.goto(`/app/${f.workspace.id}/settings/support`);
  await ownerPage.getByRole('button', { name: 'Revoke access' }).click();
  await expect(
    ownerPage.getByText('Luma support access is off', { exact: true }),
  ).toBeVisible();

  // The view ends on its next request and explains why.
  await view.reload();
  await expect(
    view.getByRole('heading', { name: 'Support view ended' }),
  ).toBeVisible();
  await expect(
    view.getByText('The workspace revoked Luma support access.'),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test('a person approves account inspection in Settings › Security and can end it early', async ({
  resources: t,
}) => {
  const f = await fixture(t);
  const errors = [];

  // Staff ask to inspect the member's account.
  const { page: staff } = await staffPage(t, f, errors);
  await staff.goto(`/accounts/${f.member.userId}`);
  await staff.getByRole('button', { name: 'Request inspection' }).click();
  await staff
    .getByLabel('Support reason or ticket reference')
    .fill('Member cannot sign in with their passkey');
  await staff
    .getByRole('button', { name: 'Send request', exact: true })
    .click();
  await expect(staff.getByText(/^Waiting for approval from/)).toBeVisible();

  // The member answers in Settings › Security, where the reason is shown.
  const memberContext = await signedIn(t, f.customerOrigin, f.member.cookie);
  const member = await memberContext.newPage();
  member.setDefaultTimeout(12000);
  member.on('pageerror', (error) => errors.push(error.message));
  await member.goto(`/app/${f.workspace.id}/settings/security`);
  await expect(
    member.getByRole('heading', { name: 'Luma support access' }),
  ).toBeVisible();
  await expect(
    member.getByText('Member cannot sign in with their passkey'),
  ).toBeVisible();
  await member.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      member.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  const approve = member.getByRole('button', { name: 'Approve', exact: true });
  await approve.focus();
  await member.keyboard.press('Enter');
  await expect(
    member.getByText('Access approved for 30 minutes.'),
  ).toBeVisible();
  await expect(
    member.getByText(
      'You approved Luma support access to your account for 30 minutes',
    ),
  ).toBeVisible();
  await expect(
    member.getByText('Luma support asked to inspect your account'),
  ).toBeVisible();

  // Staff open the account under the approval.
  await staff.getByRole('button', { name: 'Check again' }).click();
  await staff.getByRole('button', { name: 'Open account' }).click();
  await expect(staff.getByText('member@example.test').first()).toBeVisible();

  // Ending it early refuses the next read.
  await member.getByRole('button', { name: 'End inspection' }).click();
  await expect(
    member.getByText('Access ended. Luma support’s next read is refused.'),
  ).toBeVisible();
  await staff.reload();
  await expect(
    staff.getByText(/The customer revoked your access/),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

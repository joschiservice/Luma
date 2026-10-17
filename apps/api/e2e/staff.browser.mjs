/* global window, document, innerWidth */
import { randomUUID } from 'node:crypto';

import { seedLocalStaff } from '@luma/staff/composition';

import { expect, test } from './browser-fixtures.mjs';
import {
  availablePort,
  database,
  signup,
  startApi,
  startProcess,
} from './helpers.mjs';

const password = 'staff-browser-password-long-enough';

async function fixture(t) {
  const webPort = await availablePort();
  const apiPort = await availablePort();
  const origin = `http://localhost:${webPort}`;
  const db = await database(t);
  await db.migrate();
  await db.grantRuntime();
  const customerApi = await startApi(t, db, origin);
  const customer = await signup(customerApi, 'customer');
  const { body: workspace } = await customerApi.request('/v1/organizations', {
    method: 'POST',
    cookie: customer.cookie,
    body: { name: 'Support North', slug: 'support-north' },
    status: 201,
  });
  const login = `staff_browser_${randomUUID().replaceAll('-', '')}`;
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
    STAFF_AUTH_SECRET: 'staff-browser-signing-secret-at-least-32-characters',
    STAFF_PUBLIC_ORIGIN: origin,
    STAFF_AUTH_MODE: 'local',
    STAFF_API_HOST: '127.0.0.1',
    STAFF_API_PORT: String(apiPort),
    STAFF_TRUSTED_PROXY: '127.0.0.1',
    STAFF_COOKIE_PREFIX: login,
  };
  await seedLocalStaff(
    {
      databaseUrl: env.STAFF_DATABASE_URL,
      secret: env.STAFF_AUTH_SECRET,
      publicOrigin: origin,
      mode: 'local',
      host: '127.0.0.1',
      port: apiPort,
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
        'staff.sessions.revoke',
        'staff.audit.read',
        'staff.accounts.inspect',
        'staff.memberships.manage',
        'staff.accounts.manage',
        'staff.accounts.delete',
      ],
    },
    db.ownerUrl,
  );
  const staffProcess = startProcess(t, '../staff-api/dist/index.js', env, true);
  const { address: staffOrigin } = await staffProcess.message('listening');
  const webProcess = startProcess(
    t,
    'e2e/staff-web-server.mjs',
    {
      STAFF_WEB_PORT: String(webPort),
      STAFF_API_PROXY_TARGET: staffOrigin,
    },
    true,
  );
  await webProcess.message('listening');
  const context = await t.newContext({
    baseURL: origin,
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  return {
    page,
    context,
    db,
    customerApi,
    customer,
    workspace,
    staffOrigin,
    errors,
  };
}

/** Adds a failing sync stream and 51 access changes; owner triggers are off for these rows. */
async function seedHealth(db, tenantId, userId) {
  const connection = randomUUID();
  const seed = await db.owner.connect();
  try {
    await seed.query('BEGIN');
    await seed.query('SET LOCAL session_replication_role=replica');
    await seed.query(
      'INSERT INTO connector_installations(tenant_id,id,version,document,secret) VALUES($1,$2,1,$3,$4)',
      [
        tenantId,
        connection,
        {
          id: connection,
          tenantId,
          version: 1,
          provider: 'shopify',
          status: 'degraded',
          credentialVersion: 2,
          granted: ['orders.read'],
        },
        'private-credential-secret',
      ],
    );
    await seed.query(
      `INSERT INTO commerce_sync_streams(tenant_id,id,connection_id,record_type,principal_id,phase,attempts,error_code,error_message,error_at,failing_since)
      VALUES($1,$2,$3,'orders',$4,'incremental',4,'authentication','The provider rejected the connection credentials.',now(),now()-interval '2 hours')`,
      [tenantId, randomUUID(), connection, userId],
    );
    await seed.query(
      `INSERT INTO workspace_access_events(id,tenant_id,actor_id,event_type,target_id,before_value,after_value,created_at)
      SELECT gen_random_uuid(),$1,$2,'member.update',$3,$4,$5,now()-make_interval(mins=>n) FROM generate_series(1,51) n`,
      [
        tenantId,
        userId,
        randomUUID(),
        { userId, roleName: 'Member' },
        { userId, roleName: 'Admin' },
      ],
    );
    await seed.query('COMMIT');
  } catch (error) {
    await seed.query('ROLLBACK');
    throw error;
  } finally {
    seed.release();
  }
}

/** Approves the pending workspace inspection request as one of the workspace's owners would. */
async function approveWorkspaceInspection(
  customerApi,
  cookie,
  workspaceId,
  decision = 'approve',
) {
  const base = `/v1/organizations/${workspaceId}/settings/support-access`;
  const { body } = await customerApi.request(base, { cookie });
  const pending = body.inspections.find((item) => item.status === 'pending');
  expect(pending?.reason).toBeTruthy();
  await customerApi.request(`${base}/inspections/${pending.id}`, {
    method: 'POST',
    cookie,
    body: { commandId: randomUUID(), decision },
  });
}

/** Approves the pending inspection of an account as its holder would, in Settings › Security. */
async function approveAccountInspection(customerApi, cookie) {
  const { body } = await customerApi.request(
    '/v1/account/support-inspections',
    {
      cookie,
    },
  );
  const pending = body.items.find((item) => item.status === 'pending');
  await customerApi.request(`/v1/account/support-inspections/${pending.id}`, {
    method: 'POST',
    cookie,
    body: { decision: 'approve' },
  });
}

/** Sends an inspection request from the inspection panel of a workspace or account page. */
async function requestInspection(page, reason) {
  await page
    .getByRole('button', { name: 'Request inspection', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Support reason or ticket reference').fill(reason);
  await dialog
    .getByRole('button', { name: 'Send request', exact: true })
    .click();
  await expect(page.getByText(/^Waiting for approval/)).toBeVisible();
}

/** Rechecks the request after the customer answered and opens the approved access. */
async function openApproved(page, name) {
  await page.getByRole('button', { name: 'Check again', exact: true }).click();
  await page.getByRole('button', { name, exact: true }).click();
}

/** Asks Support North for inspection from the directory, approves it as its owner and opens it. */
async function inspectWorkspace(
  page,
  customerApi,
  customer,
  workspace,
  reason,
) {
  await page.getByLabel('Name, email or workspace').fill('Support North');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: 'Inspect Support North' }).click();
  await page.getByLabel('Support reason or ticket reference').fill(reason);
  await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect(page.getByText(/^Waiting for approval/)).toBeVisible();
  await approveWorkspaceInspection(customerApi, customer.cookie, workspace.id);
  await openApproved(page, 'Open workspace');
}

/** On an account page without access, requests inspection, approves it as the holder and opens it. */
async function inspectAccount(page, customerApi, cookie, reason) {
  await requestInspection(page, reason);
  await approveAccountInspection(customerApi, cookie);
  await openApproved(page, 'Open account');
}

async function signIn(page) {
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Sign in to Luma staff' }),
  ).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill('support@example.test');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('heading', {
      name: 'Support directory',
      exact: true,
      level: 1,
    }),
  ).toBeVisible();
}

test('staff investigates a workspace and retries an uncertain global revocation without repeating it', async ({
  resources: t,
}) => {
  const { page, db, customerApi, customer, workspace, errors } =
    await fixture(t);
  await seedHealth(db, workspace.id, customer.userId);
  await signIn(page);
  await inspectWorkspace(
    page,
    customerApi,
    customer,
    workspace,
    'Investigating customer access ticket',
  );
  await expect(
    page.getByRole('heading', { name: workspace.name, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('table', { name: 'Workspace members' }),
  ).toContainText('customer');
  const streams = page.getByRole('table', { name: 'Sync streams' });
  await expect(streams).toContainText('Failing');
  await expect(streams).toContainText('authentication');
  await expect(page.locator('body')).not.toContainText(
    'private-credential-secret',
  );
  const history = page.getByRole('table', {
    name: 'Workspace access changes, newest first',
  });
  await expect(history.getByRole('row')).toHaveCount(51);
  await expect(history).toContainText('Member role changed');
  await page.getByRole('button', { name: 'Load older changes' }).focus();
  await page.keyboard.press('Enter');
  // 51 seeded changes plus the inspection request and its approval.
  await expect(history.getByRole('row')).toHaveCount(54);
  await expect(
    page.getByText('This is the oldest recorded access change.'),
  ).toBeVisible();
  const reads = await db.owner.query(
    "SELECT count(*) FILTER (WHERE event='workspace.health.read')::int AS health,count(*) FILTER (WHERE event='workspace.access-history.read')::int AS history FROM staff_audit WHERE tenant_id=$1",
    [workspace.id],
  );
  expect(reads.rows[0].health).toBeGreaterThanOrEqual(1);
  expect(reads.rows[0].history).toBeGreaterThanOrEqual(2);
  await page.screenshot({
    path: test.info().outputPath('workspace-light.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.screenshot({
    path: test.info().outputPath('workspace-dark-narrow.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page
    .getByRole('button', { name: 'Revoke sessions for customer@example.test' })
    .click();
  await page
    .getByLabel('Reason for revoking sessions')
    .fill('Customer requested all device sign-out');
  await page.getByRole('checkbox').check();
  const commands = [];
  await page.route('**/revoke-sessions', async (route) => {
    commands.push(route.request().postDataJSON().commandId);
    if (commands.length === 1) {
      await route.fetch();
      await route.abort('failed');
    } else await route.continue();
  });
  await page
    .getByRole('button', { name: 'Revoke all sessions', exact: true })
    .click();
  await expect(page.getByText(/Completion was not confirmed/)).toBeVisible();
  await page
    .getByRole('button', { name: 'Retry revocation', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('session revoked');
  expect(commands).toHaveLength(2);
  expect(commands[0]).toBe(commands[1]);
  const audit = await db.owner.query(
    "SELECT count(*)::int AS count FROM staff_audit WHERE event='customer.sessions.revoked'",
  );
  expect(audit.rows[0].count).toBe(1);
  await customerApi.request('/v1/organizations', {
    cookie: customer.cookie,
    status: 401,
  });
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Sign in to Luma staff' }),
  ).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole('heading', { name: 'Sign in to Luma staff' }),
  ).toBeVisible();
  await expect(
    page.getByRole('table', { name: 'Workspace members' }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('staff suspends the only active owner after acknowledgement and reactivates the same role', async ({
  resources: t,
}) => {
  const { page, db, customerApi, customer, workspace, errors } =
    await fixture(t);
  await signIn(page);
  await inspectWorkspace(
    page,
    customerApi,
    customer,
    workspace,
    'Owner departed, customer asked for removal',
  );
  const members = page.getByRole('table', { name: 'Workspace members' });
  await expect(members).toContainText('Active');
  await page
    .getByRole('button', {
      name: 'Suspend membership for customer@example.test',
    })
    .click();
  await page
    .getByLabel('Reason for suspending access')
    .fill('Departed employee, owner unreachable');
  const submit = page.getByRole('button', {
    name: 'Suspend membership',
    exact: true,
  });
  await expect(submit).toBeDisabled();
  await page.getByRole('checkbox').check();
  await submit.click();
  await expect(page.getByRole('status')).toContainText(
    'The workspace has no active owner',
  );
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(members).toContainText('Suspended');
  await expect(members).toContainText('By Luma support');
  await expect(page.locator('body')).toContainText(
    'This workspace has no active owner.',
  );
  const rejected = await customerApi.request(
    `/v1/organizations/${workspace.id}/context`,
    { cookie: customer.cookie, status: 403 },
  );
  expect(rejected.body.code).toBe('ACCESS_SUSPENDED');
  const listed = await customerApi.request('/v1/organizations', {
    cookie: customer.cookie,
  });
  expect(listed.body.items).toEqual([
    expect.objectContaining({
      id: workspace.id,
      membershipStatus: 'suspended',
    }),
  ]);
  await page.screenshot({
    path: test.info().outputPath('membership-suspended.png'),
    fullPage: true,
    animations: 'disabled',
  });

  await page
    .getByRole('button', {
      name: 'Reactivate membership for customer@example.test',
    })
    .click();
  await page
    .getByLabel('Reason for reactivating access')
    .fill('Ownership confirmed with the customer');
  await page
    .getByRole('button', { name: 'Reactivate membership', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText(
    'Membership reactivated',
  );
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(members).not.toContainText('Suspended');
  const context = await customerApi.request(
    `/v1/organizations/${workspace.id}/context`,
    { cookie: customer.cookie },
  );
  expect(context.body.actor.role.key).toBe('owner');
  const audit = await db.owner.query(
    "SELECT event FROM staff_audit WHERE event LIKE 'customer.membership.%' ORDER BY sequence",
  );
  expect(audit.rows.map((row) => row.event)).toEqual([
    'customer.membership.suspended',
    'customer.membership.reactivated',
  ]);
  expect(errors).toEqual([]);
});

test('staff disables an account, its sign-in is refused, and enabling restores it', async ({
  resources: t,
}) => {
  const { page, db, customerApi, customer, workspace, errors } =
    await fixture(t);
  // The customer signs in through their own web app and API origin.
  const customerPort = await availablePort();
  const customerOrigin = `http://127.0.0.1:${customerPort}`;
  const customerWebApi = await startApi(t, db, customerOrigin);
  const customerWeb = startProcess(
    t,
    'e2e/web-server.mjs',
    {
      TEST_API_ORIGIN: customerWebApi.origin,
      TEST_WEB_PORT: String(customerPort),
    },
    true,
  );
  await customerWeb.message('listening');
  const customerContext = await t.newContext({
    baseURL: customerOrigin,
    viewport: { width: 1440, height: 900 },
  });
  const customerPage = await customerContext.newPage();
  customerPage.on('pageerror', (error) => errors.push(error.message));
  const customerSignIn = async () => {
    await customerPage.goto('/sign-in');
    await customerPage
      .getByLabel('Email', { exact: true })
      .fill('customer@example.test');
    await customerPage
      .getByLabel('Password', { exact: true })
      .fill('long-e2e-test-password');
    await customerPage
      .getByRole('button', { name: 'Sign in', exact: true })
      .click();
  };

  await signIn(page);
  await page.getByLabel('Name, email or workspace').fill('customer@example');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page
    .getByRole('link', { name: 'Open account customer@example.test' })
    .click();
  await inspectAccount(
    page,
    customerApi,
    customer.cookie,
    'Compromised account report, ticket 5120',
  );
  await page
    .getByRole('button', { name: 'Disable account', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByLabel('Reason for disabling the account')
    .fill('Credentials posted publicly, ticket 5120');
  const submit = dialog.getByRole('button', {
    name: 'Disable account',
    exact: true,
  });
  await expect(submit).toBeDisabled();
  await dialog.getByRole('checkbox').check();
  await submit.click();
  await expect(page.getByRole('status')).toContainText(
    'Account disabled. 1 session ended.',
  );
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.locator('body')).toContainText(
    'Compromised account: Credentials posted publicly, ticket 5120',
  );
  await expect(
    page.getByRole('heading', { name: 'No active sessions' }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('account-disabled.png'),
    fullPage: true,
    animations: 'disabled',
  });

  // The existing session is gone, and a new sign-in is refused without the reason.
  await customerApi.request('/v1/organizations', {
    cookie: customer.cookie,
    status: 401,
  });
  await customerSignIn();
  await expect(customerPage.locator('body')).toContainText(
    'This account is disabled. Contact your workspace owner or Luma support.',
  );
  await expect(customerPage.locator('body')).not.toContainText('ticket 5120');
  await expect(customerPage).toHaveURL(/\/sign-in/);

  await page
    .getByRole('button', { name: 'Enable account', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByLabel('Reason for enabling the account')
    .fill('Password reset confirmed by the account holder');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Enable account', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('Account enabled.');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Disable account', exact: true }),
  ).toBeVisible();

  await customerSignIn();
  await expect(customerPage).not.toHaveURL(/\/sign-in/);
  await expect(customerPage).toHaveURL(new RegExp(workspace.id));
  const audit = await db.owner.query(
    "SELECT event FROM staff_audit WHERE event LIKE 'customer.account.%' ORDER BY sequence",
  );
  expect(audit.rows.map((row) => row.event)).toEqual([
    'customer.account.disabled',
    'customer.account.enabled',
  ]);
  expect(errors).toEqual([]);
});

test('staff schedules, restores and erases an account, and history shows a former member', async ({
  resources: t,
}) => {
  const { page, db, customerApi, customer, workspace, errors } =
    await fixture(t);
  const member = await signup(customerApi, 'leaver');
  const cookies = {
    'customer@example.test': customer.cookie,
    'leaver@example.test': member.cookie,
  };
  await db.owner.query(
    "INSERT INTO memberships(id,tenant_id,user_id,role,created_at) VALUES($1,$2,$3,'admin',now())",
    [randomUUID(), workspace.id, member.userId],
  );
  // A change the person recorded, so Activity names them before and after erasure.
  await db.owner.query(
    "INSERT INTO workspace_access_events(id,tenant_id,actor_id,event_type,target_id,after_value) VALUES($1,$2::uuid,$3,'workspace.updated',$2::text,$4)",
    [randomUUID(), workspace.id, member.userId, { name: 'Support North' }],
  );
  const openAccount = async (email) => {
    await page.getByLabel('Name, email or workspace').fill(email);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByRole('link', { name: `Open account ${email}` }).click();
    await inspectAccount(
      page,
      customerApi,
      cookies[email],
      'Deletion request, ticket SUP-7710',
    );
  };
  const deletion = async (button, values) => {
    await page.getByRole('button', { name: button, exact: true }).click();
    const dialog = page.getByRole('dialog');
    if (values.reference)
      await dialog.getByLabel('Request reference').fill(values.reference);
    await dialog.getByLabel(values.reasonLabel).fill(values.reason);
    if (values.reference) await dialog.getByRole('checkbox').check();
    await dialog
      .getByRole('button', { name: values.submit, exact: true })
      .click();
  };

  await signIn(page);
  // The only owner can't be deleted until someone else owns the workspace.
  await openAccount('customer@example.test');
  await deletion('Schedule deletion', {
    reference: 'SUP-7709',
    reasonLabel: 'Reason for deleting the account',
    reason: 'Account holder asked for deletion',
    submit: 'Schedule deletion',
  });
  await expect(page.getByRole('dialog')).toContainText('only owner');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();

  await page.getByRole('link', { name: 'Back to directory' }).click();
  await openAccount('leaver@example.test');
  await deletion('Schedule deletion', {
    reference: 'SUP-7710',
    reasonLabel: 'Reason for deleting the account',
    reason: 'Account holder asked for deletion',
    submit: 'Schedule deletion',
  });
  await expect(page.getByRole('status')).toContainText('Deletion scheduled.');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.locator('body')).toContainText('Scheduled for deletion');
  await expect(page.locator('body')).toContainText('reference SUP-7710');
  await expect(
    page.getByRole('button', { name: 'Disable account', exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath('account-deletion-scheduled.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await customerApi.request('/v1/organizations', {
    cookie: member.cookie,
    status: 401,
  });

  await deletion('Restore account', {
    reasonLabel: 'Reason for restoring the account',
    reason: 'Account holder changed their mind',
    submit: 'Restore account',
  });
  await expect(page.getByRole('status')).toContainText('Account restored.');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Schedule deletion', exact: true }),
  ).toBeVisible();
  expect(
    (
      await db.owner.query(
        'SELECT role,status FROM memberships WHERE user_id=$1',
        [member.userId],
      )
    ).rows,
  ).toEqual([{ role: 'admin', status: 'active' }]);

  await deletion('Erase now', {
    reference: 'GDPR-17-0099',
    reasonLabel: 'How the request was verified',
    reason: 'Verified Art. 17 request from the account holder',
    submit: 'Erase account now',
  });
  await expect(page.getByRole('status')).toContainText('Erasure requested.');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.locator('body')).toContainText('Erasure requested');
  // The API's erasure pass runs every minute; erase directly instead of waiting for it.
  const { id: deletionId } = (
    await db.owner.query(
      "SELECT id FROM account_deletions WHERE user_id=$1 AND status='scheduled'",
      [member.userId],
    )
  ).rows[0];
  await db.owner.query('SELECT account_erase($1)', [deletionId]);
  // Erasure also removed the account grant.
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Account unavailable', level: 1 }),
  ).toBeVisible();

  // The workspace owner sees the person's history as a former member.
  const customerPort = await availablePort();
  const customerOrigin = `http://127.0.0.1:${customerPort}`;
  const customerWebApi = await startApi(t, db, customerOrigin);
  const customerWeb = startProcess(
    t,
    'e2e/web-server.mjs',
    {
      TEST_API_ORIGIN: customerWebApi.origin,
      TEST_WEB_PORT: String(customerPort),
    },
    true,
  );
  await customerWeb.message('listening');
  const customerPage = await (
    await t.newContext({
      baseURL: customerOrigin,
      viewport: { width: 1440, height: 900 },
    })
  ).newPage();
  customerPage.on('pageerror', (error) => errors.push(error.message));
  await customerPage.goto('/sign-in');
  await customerPage
    .getByLabel('Email', { exact: true })
    .fill('customer@example.test');
  await customerPage
    .getByLabel('Password', { exact: true })
    .fill('long-e2e-test-password');
  await customerPage
    .getByRole('button', { name: 'Sign in', exact: true })
    .click();
  await expect(customerPage).toHaveURL(new RegExp(workspace.id));
  const activityLoaded = customerPage.waitForResponse(
    (response) =>
      response
        .url()
        .includes(`/api/v1/organizations/${workspace.id}/activity?`) &&
      response.status() === 200,
  );
  await customerPage.goto(`/app/${workspace.id}/activity`);
  await activityLoaded;
  await expect(customerPage.locator('body')).toContainText('Former member');
  await expect(customerPage.locator('body')).not.toContainText('leaver');
  await customerPage.screenshot({
    path: test.info().outputPath('account-erased-activity.png'),
    fullPage: true,
    animations: 'disabled',
  });
  expect(errors).toEqual([]);
});

test('staff reviews the audit log by event and staff member', async ({
  resources: t,
}) => {
  const { page, db, customerApi, customer, workspace, errors } =
    await fixture(t);
  await signIn(page);
  await inspectWorkspace(
    page,
    customerApi,
    customer,
    workspace,
    'Checking the audit trail for this ticket',
  );
  await expect(
    page.getByRole('heading', { name: workspace.name, exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Audit log', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Staff audit log', level: 1 }),
  ).toBeVisible();
  const entries = page.getByRole('table', {
    name: 'Staff audit entries, newest first',
  });
  await expect(entries).toContainText('Support access opened');
  await expect(entries).toContainText(
    'Checking the audit trail for this ticket',
  );
  await expect(entries).toContainText('Signed in');
  await page
    .getByLabel('Staff member email or ID')
    .fill('support@example.test');
  await page.getByLabel('Until (inclusive)').fill('2000-01-01');
  await page.getByLabel('From').fill('2000-01-02');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(
    page.getByText('Choose an end date on or after the start.'),
  ).toBeVisible();
  await page.getByLabel('From').fill('');
  await page.getByLabel('Until (inclusive)').fill('');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page).toHaveURL(/staff=support%40example\.test/);
  await expect(entries).toContainText('Support access opened');
  await page.goto('/audit?event=staff.signed-in');
  await expect(entries).toContainText('Signed in');
  await expect(entries).not.toContainText('Support access opened');
  await page.goto('/audit?event=workspace.access.opened');
  await entries.getByRole('link', { name: 'Only this workspace' }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`workspace=${workspace.id}`));
  await expect(entries).toContainText('Support North');
  await page.screenshot({
    path: test.info().outputPath('audit-light.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.screenshot({
    path: test.info().outputPath('audit-dark-narrow.png'),
    fullPage: true,
    animations: 'disabled',
  });
  const reads = await db.owner.query(
    "SELECT count(*)::int AS count FROM staff_audit WHERE event='staff.audit.read'",
  );
  expect(reads.rows[0].count).toBeGreaterThanOrEqual(4);
  expect(errors).toEqual([]);
});

test('staff opens a customer account and follows a workspace into its own support access', async ({
  resources: t,
}) => {
  const { page, db, customerApi, customer, workspace, errors } =
    await fixture(t);
  await signIn(page);
  await page.getByLabel('Name, email or workspace').fill('customer@example');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page
    .getByRole('link', { name: 'Open account customer@example.test' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Account support access' }),
  ).toBeVisible();
  await expect(
    page.getByRole('table', { name: 'Account workspaces' }),
  ).toHaveCount(0);
  await inspectAccount(
    page,
    customerApi,
    customer.cookie,
    'Investigating a customer sign-in ticket',
  );
  await expect(
    page.getByRole('heading', { name: 'customer', exact: true, level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole('table', { name: 'Account workspaces' }),
  ).toContainText(workspace.name);
  await expect(
    page.getByRole('table', { name: 'Account workspaces' }),
  ).toContainText('Owner');
  // The header row and the session created when the confirmed account signed in.
  await expect(
    page
      .getByRole('table', { name: 'Active customer sessions' })
      .getByRole('row'),
  ).toHaveCount(2);
  await expect(
    page.getByRole('table', { name: 'Account security activity' }),
  ).toContainText('Password sign-in');
  const audit = await db.owner.query(
    "SELECT event,details->>'userId' AS \"userId\" FROM staff_audit WHERE event LIKE 'account.%' ORDER BY event",
  );
  expect(audit.rows).toEqual([
    { event: 'account.access.opened', userId: customer.userId },
    { event: 'account.access.requested', userId: customer.userId },
    { event: 'account.inspected', userId: customer.userId },
    { event: 'account.security-events.inspected', userId: customer.userId },
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.screenshot({
    path: test.info().outputPath('account-dark-narrow.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('link', { name: workspace.name, exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Workspace support access' }),
  ).toBeVisible();
  // The workspace needs its own approval; a declined request says so and can be asked again.
  await requestInspection(page, 'Following up on the sign-in ticket');
  await approveWorkspaceInspection(
    customerApi,
    customer.cookie,
    workspace.id,
    'decline',
  );
  await page.getByRole('button', { name: 'Check again', exact: true }).click();
  await expect(page.getByText(/^Your request was declined/)).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Request again', exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test('staff access removal clears customer details and rejects direct API calls', async ({
  resources: t,
}) => {
  const { page, context, db, customerApi, customer, workspace, errors } =
    await fixture(t);
  await signIn(page);
  const denied = await context.request.post('/api/auth/sign-up/email', {
    headers: { origin: new URL(page.url()).origin },
    data: { email: 'unexpected@example.test', password, name: 'Unexpected' },
  });
  expect(denied.status()).toBe(404);
  await inspectWorkspace(
    page,
    customerApi,
    customer,
    workspace,
    'Checking support offboarding behavior',
  );
  await expect(
    page.getByRole('table', { name: 'Workspace members' }),
  ).toBeVisible();
  await db.owner.query(
    "UPDATE staff_access SET active=false WHERE email='support@example.test'",
  );
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(
    page.getByRole('heading', { name: 'Sign in to Luma staff' }),
  ).toBeVisible();
  await expect(
    page.getByRole('table', { name: 'Workspace members' }),
  ).toHaveCount(0);
  const response = await context.request.get(
    '/api/v1/staff/directory?query=Support',
  );
  expect(response.status()).toBe(403);
  expect(errors).toEqual([]);
});

test('passive refreshes preserve idle limits while trusted input refreshes active support access', async ({
  resources: t,
}) => {
  const { page, db, errors } = await fixture(t);
  await signIn(page);
  const previous = await db.owner.query(
    "UPDATE staff_sessions SET updated_at=now()-interval '5 minutes' RETURNING updated_at",
  );
  const [passive] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().endsWith('/api/v1/staff/session'),
    ),
    page.evaluate(() => window.dispatchEvent(new Event('focus'))),
  ]);
  expect(passive.status()).toBe(200);
  expect(passive.request().headers()['x-luma-staff-activity']).toBeUndefined();
  const unchanged = await db.owner.query(
    'SELECT updated_at FROM staff_sessions',
  );
  expect(unchanged.rows[0].updated_at).toEqual(previous.rows[0].updated_at);

  await page.getByLabel('Name, email or workspace').click();
  await page.getByLabel('Name, email or workspace').press('a');
  const [active] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/staff/session') &&
        response.request().headers()['x-luma-staff-activity'] === 'true',
    ),
    page.evaluate(() => window.dispatchEvent(new Event('focus'))),
  ]);
  expect(active.status()).toBe(200);
  const refreshed = await db.owner.query(
    'SELECT updated_at FROM staff_sessions',
  );
  expect(refreshed.rows[0].updated_at.getTime()).toBeGreaterThan(
    previous.rows[0].updated_at.getTime(),
  );

  await db.owner.query(
    "UPDATE staff_sessions SET updated_at=now()-interval '31 minutes'",
  );
  const [expired] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().endsWith('/api/v1/staff/session'),
    ),
    page.evaluate(() => window.dispatchEvent(new Event('focus'))),
  ]);
  expect(expired.request().headers()['x-luma-staff-activity']).toBeUndefined();
  expect(expired.status()).toBe(403);
  await expect(
    page.getByRole('heading', { name: 'Sign in to Luma staff', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Support directory', exact: true }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('rejected Google callbacks return to staff login with a sanitized failure message', async ({
  resources: t,
}) => {
  const { page, errors } = await fixture(t);
  let errorCallbackURL;
  await page.route('**/api/v1/staff/config', (route) =>
    route.fulfill({
      json: {
        mode: 'google',
        providerId: 'google',
        region: 'AU',
        regionalApiOrigins: {},
        regionalDirectoryEnabled: false,
      },
    }),
  );
  await page.route('**/api/auth/sign-in/social', async (route) => {
    const body = route.request().postDataJSON();
    errorCallbackURL = body.errorCallbackURL;
    expect(errorCallbackURL).toBe(
      `${new URL(page.url()).origin}/login?signInFailed=true&region=AU`,
    );
    await route.fulfill({
      json: {
        url: 'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic',
      },
    });
  });
  await page.route('https://accounts.google.com/**', async (route) => {
    await route.fulfill({
      status: 302,
      headers: {
        location: `${errorCallbackURL}&error=sensitive-provider-diagnostic`,
      },
      body: '',
    });
  });
  await page.goto('/login');
  await page
    .getByRole('button', {
      name: 'Continue with Google Workspace',
      exact: true,
    })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Sign in to Luma staff', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toContainText(
    'Google Workspace sign-in was not completed.',
  );
  await expect(page.getByText('sensitive-provider-diagnostic')).toHaveCount(0);
  await expect(
    page.getByRole('button', {
      name: 'Continue with Google Workspace',
      exact: true,
    }),
  ).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.getByRole('alert')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('button', {
      name: 'Continue with Google Workspace',
      exact: true,
    }),
  ).toBeFocused();
  expect(errors).toEqual([]);
});

test('staff sign-in rate limits remain distinct for clients behind a trusted proxy', async ({
  resources: t,
}) => {
  const { page, context, staffOrigin, errors } = await fixture(t);
  await page.goto('/login');
  const origin = new URL(page.url()).origin;
  const unique = randomUUID();
  for (let index = 0; index < 4; index += 1) {
    const response = await context.request.post(
      `${staffOrigin}/auth/sign-in/email`,
      {
        headers: { origin, 'x-forwarded-for': `203.0.113.${81 + index}` },
        data: { email: `distinct_${unique}_${index}@example.test`, password },
      },
    );
    expect(response.status()).toBe(401);
  }
  for (let index = 0; index < 4; index += 1) {
    const response = await context.request.post(
      `${staffOrigin}/auth/sign-in/email`,
      {
        headers: { origin, 'x-forwarded-for': '198.51.100.201' },
        data: { email: `repeated_${unique}_${index}@example.test`, password },
      },
    );
    expect(response.status()).toBe(index === 3 ? 429 : 401);
  }
  expect(errors).toEqual([]);
});

test('regional staff directory keeps partial results and sends account access to the owning API', async ({
  resources: t,
}) => {
  const { page, context, customerApi, customer, workspace, errors } =
    await fixture(t);
  let ownerRequests = 0;
  await page.route('**/api/v1/staff/config', async (route) => {
    const actual = await route.fetch();
    const config = await actual.json();
    await route.fulfill({
      json: {
        ...config,
        regionalDirectoryEnabled: true,
        regionalApiOrigins: {
          EU: 'https://eu.staff.example.test',
          US: 'https://us.staff.example.test',
        },
      },
    });
  });
  await page.route('https://us.staff.example.test/**', (route) =>
    route.abort('failed'),
  );
  await page.route('https://eu.staff.example.test/**', async (route) => {
    const source = new URL(route.request().url());
    const origin = new URL(page.url()).origin;
    const cors = {
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
      'access-control-allow-headers': 'content-type,x-luma-staff-activity',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    };
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: cors, body: '' });

      return;
    }
    const response = await context.request.fetch(
      new URL('/api' + source.pathname + source.search, origin).href,
      {
        method: route.request().method(),
        headers: { origin },
        ...(route.request().postData()
          ? { data: route.request().postDataJSON() }
          : {}),
      },
    );
    if (source.pathname.includes('/accounts/')) ownerRequests++;
    await route.fulfill({
      response,
      headers: { ...response.headers(), ...cors },
    });
  });
  await signIn(page);
  await page.getByLabel('Name, email or workspace').fill('customer@example');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByText('AU: Answered', { exact: true })).toBeVisible();
  await expect(page.getByText('EU: Answered', { exact: true })).toBeVisible();
  await expect(
    page.getByText('US: Results incomplete', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/Results incomplete. Some regions/),
  ).toBeVisible();
  const eu = page
    .getByRole('table', { name: 'Matching customer accounts' })
    .getByRole('row')
    .filter({ has: page.getByText('EU', { exact: true }) });
  await eu
    .getByRole('link', { name: 'Open account customer@example.test' })
    .click();
  expect(new URL(page.url()).searchParams.get('region')).toBe('EU');
  await inspectAccount(
    page,
    customerApi,
    customer.cookie,
    'Investigating regional support routing',
  );
  await expect(
    page.getByRole('table', { name: 'Account workspaces' }),
  ).toContainText(workspace.name);
  expect(ownerRequests).toBeGreaterThanOrEqual(2);
  expect(errors).toEqual([]);
});

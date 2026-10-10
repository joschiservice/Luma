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
  await page.getByLabel('Name, email or workspace').fill('Support North');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: 'Inspect Support North' }).click();
  await page
    .getByLabel('Support reason or ticket reference')
    .fill('Investigating customer access ticket');
  await page
    .getByRole('button', { name: 'Open support access', exact: true })
    .click();
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
  await expect(history.getByRole('row')).toHaveCount(52);
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
  await page.getByLabel('Name, email or workspace').fill('Support North');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: 'Inspect Support North' }).click();
  await page
    .getByLabel('Support reason or ticket reference')
    .fill('Owner departed, customer asked for removal');
  await page
    .getByRole('button', { name: 'Open support access', exact: true })
    .click();
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

test('staff reviews the audit log by event and staff member', async ({
  resources: t,
}) => {
  const { page, db, workspace, errors } = await fixture(t);
  await signIn(page);
  await page.getByLabel('Name, email or workspace').fill('Support North');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: 'Inspect Support North' }).click();
  await page
    .getByLabel('Support reason or ticket reference')
    .fill('Checking the audit trail for this ticket');
  await page
    .getByRole('button', { name: 'Open support access', exact: true })
    .click();
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
  const { page, db, customer, workspace, errors } = await fixture(t);
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
  await page
    .getByRole('button', { name: 'Open account access', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByLabel('Support reason or ticket reference')
    .fill('Investigating a customer sign-in ticket');
  await dialog
    .getByRole('button', { name: 'Open account access', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'customer', exact: true, level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole('table', { name: 'Account workspaces' }),
  ).toContainText(workspace.name);
  await expect(
    page.getByRole('table', { name: 'Account workspaces' }),
  ).toContainText('Owner');
  // The header row and the session created at sign-up.
  await expect(
    page
      .getByRole('table', { name: 'Active customer sessions' })
      .getByRole('row'),
  ).toHaveCount(2);
  await expect(
    page.getByRole('heading', { name: 'No security activity' }),
  ).toBeVisible();
  const audit = await db.owner.query(
    "SELECT event,details->>'userId' AS \"userId\" FROM staff_audit WHERE event LIKE 'account.%' ORDER BY event",
  );
  expect(audit.rows).toEqual([
    { event: 'account.access.opened', userId: customer.userId },
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
  await expect(
    page.getByRole('button', { name: 'Open support access', exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test('staff access removal clears customer details and rejects direct API calls', async ({
  resources: t,
}) => {
  const { page, context, db, errors } = await fixture(t);
  await signIn(page);
  const denied = await context.request.post('/api/auth/sign-up/email', {
    headers: { origin: new URL(page.url()).origin },
    data: { email: 'unexpected@example.test', password, name: 'Unexpected' },
  });
  expect(denied.status()).toBe(404);
  await page.getByLabel('Name, email or workspace').fill('Support North');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: 'Inspect Support North' }).click();
  await page
    .getByLabel('Support reason or ticket reference')
    .fill('Checking support offboarding behavior');
  await page
    .getByRole('button', { name: 'Open support access', exact: true })
    .click();
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
    route.fulfill({ json: { mode: 'google', providerId: 'google' } }),
  );
  await page.route('**/api/auth/sign-in/social', async (route) => {
    const body = route.request().postDataJSON();
    errorCallbackURL = body.errorCallbackURL;
    expect(errorCallbackURL).toBe(
      `${new URL(page.url()).origin}/login?signInFailed=true`,
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

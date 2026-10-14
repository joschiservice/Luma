/* global document, window, innerWidth, requestAnimationFrame */
import { expect, test } from './browser-fixtures.mjs';
import { availablePort, database, startApi, startProcess } from './helpers.mjs';

let origin;

const password = 'browser-test-password-123';

async function fixture(t) {
  const port = await availablePort();
  origin = `http://127.0.0.1:${port}`;
  const db = await database(t);
  await db.migrate();
  await db.grantRuntime();
  const api = await startApi(t, db, origin);
  const web = startProcess(
    t,
    'e2e/web-server.mjs',
    { TEST_API_ORIGIN: api.origin, TEST_WEB_PORT: String(port) },
    true,
  );
  await web.message('listening');
  const context = await t.newContext({
    baseURL: origin,
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(15_000);

  return { db, api, context, page, errors };
}

async function heading(page, name) {
  try {
    await page.getByRole('heading', { name, exact: true }).waitFor();
  } catch (cause) {
    throw new Error(
      `${page.url()}\n${await page.locator('body').innerText()}`,
      { cause },
    );
  }
}

async function register(page, email = 'ada@example.test') {
  await page.goto('/sign-up');
  await page.getByRole('radio', { name: /Australia/ }).check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Ada');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page
    .getByRole('button', { name: 'Create account', exact: true })
    .click();
  await heading(page, 'Create a workspace');
}

async function createWorkspace(page, name) {
  await page.getByLabel('Workspace name').fill(name);
  await page
    .getByRole('button', { name: 'Create workspace', exact: true })
    .click();
  await heading(page, 'Needs your attention');

  return new URL(page.url()).pathname.split('/')[2];
}

async function signIn(page, email = 'ada@example.test') {
  await heading(page, 'Sign in to Luma');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test('registers, creates AU workspaces, restores links, switches tabs and revokes sessions', async ({
  resources: t,
}) => {
  const { db, page, context, errors } = await fixture(t);
  await page.goto('/');
  expect(await page.title()).toBe('Luma');
  await page.getByRole('link', { name: 'Create account' }).waitFor();
  await register(page);
  const first = await createWorkspace(page, 'North Studio');
  const row = await db.owner.query(
    'SELECT data_region FROM organizations WHERE id = $1',
    [first],
  );
  expect(row.rows[0].data_region).toBe('AU');
  await page.screenshot({ path: '/tmp/luma-30-desktop.png', fullPage: true });
  await page.goto('/app');
  await page.waitForURL(`**/app/${first}/home*`);
  await page.goto('/sign-out');
  await heading(page, 'Sign in to Luma');
  await page.goto(`/app/${first}/exceptions`);
  await heading(page, 'Sign in to Luma');
  // The list's view is not in the address; the member's remembered view decides it.
  expect(new URL(page.url()).searchParams.get('returnTo')).toBe(
    `/app/${first}/exceptions`,
  );
  await signIn(page);
  await heading(page, 'Issues');
  expect(new URL(page.url()).pathname).toBe(`/app/${first}/exceptions`);
  await page
    .getByRole('button', { name: 'Needs review', exact: true })
    .waitFor();
  await page.goto('/app/workspaces/new');
  const second = await createWorkspace(page, 'South Studio');
  await page.goto('/app');
  await heading(page, 'Choose a workspace');
  await page.getByRole('link', { name: 'North Studio' }).click();
  await page.waitForURL(`**/app/${first}/home*`);
  const tab = await context.newPage();
  await tab.goto(`/app/${second}/home`);
  await heading(tab, 'Needs your attention');
  expect(await page.locator('.workspace-switcher-name').textContent()).toBe(
    'North Studio',
  );
  expect(await tab.locator('.workspace-switcher-name').textContent()).toBe(
    'South Studio',
  );
  await page.getByRole('button', { name: /Switch workspace/ }).click();
  await page
    .getByRole('menuitem', { name: 'South Studio', exact: true })
    .click();
  await page.waitForURL(`**/app/${second}/home*`);
  await heading(page, 'Needs your attention');
  // Deliver the previous workspace's access response after a browser-history switch.
  let release;
  let received;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const requested = new Promise((resolve) => {
    received = resolve;
  });
  t.onTestFinished(() => release());
  await page.route(
    `**/api/v1/organizations/${second}/context`,
    async (route) => {
      const response = await route.fetch();
      received();
      await held;
      await route.fulfill({ response }).catch(() => undefined);
    },
  );
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await requested;
  await page.goBack();
  await page.waitForURL(`**/app/${first}/home*`);
  await heading(page, 'Needs your attention');
  release();
  await page.unroute(`**/api/v1/organizations/${second}/context`);
  expect(await page.locator('.workspace-switcher-name').textContent()).toBe(
    'North Studio',
  );
  await page.getByRole('button', { name: /Switch workspace/ }).click();
  await page
    .getByRole('menuitem', { name: 'South Studio', exact: true })
    .click();
  await page.waitForURL(`**/app/${second}/home*`);
  await heading(page, 'Needs your attention');
  await page.setViewportSize({ width: 390, height: 844 });
  const menu = page.getByRole('button', { name: 'Menu', exact: true });
  await menu.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Escape');
  await expect
    .poll(() => menu.evaluate((element) => element === document.activeElement))
    .toBe(true);
  await menu.click();
  await page.getByRole('dialog').getByRole('link', { name: 'Apps' }).click();
  await heading(page, 'Apps');
  await page.screenshot({ path: '/tmp/luma-30-mobile.png', fullPage: true });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await db.owner.query('DELETE FROM sessions');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await heading(page, 'Sign in to Luma');
  expect(await page.getByText('South Studio', { exact: true }).count()).toBe(0);
  await page.goBack();
  await heading(page, 'Sign in to Luma');
  await page.goto('/sign-in?returnTo=https://evil.test');
  await signIn(page);
  await heading(page, 'Choose a workspace');
  expect(new URL(page.url()).origin).toBe(origin);
  expect(errors).toEqual([]);
});

test('keeps failures recoverable and hides inaccessible tenant content', async ({
  resources: t,
}) => {
  const { db, page, errors } = await fixture(t);
  await page.goto('/sign-up');
  await page.getByRole('radio', { name: /Australia/ }).check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page
    .getByRole('button', { name: 'Create account', exact: true })
    .click();
  await page.getByText('Enter your name.', { exact: true }).waitFor();
  await register(page);
  // A lost response must not cause an automatic second creation.
  let creations = 0;
  await page.route('**/api/v1/organizations', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    creations++;
    await route.fetch();
    await route.abort('failed');
  });
  await page.getByLabel('Workspace name').fill('Created once');
  await page
    .getByRole('button', { name: 'Create workspace', exact: true })
    .click();
  await page
    .getByText(
      'Luma couldn’t confirm that the workspace was created. Check your workspace list before you try again.',
    )
    .waitFor();
  expect(creations).toBe(1);
  expect(
    await page
      .getByRole('button', { name: 'Create workspace', exact: true })
      .isDisabled(),
  ).toBe(true);
  await page.unroute('**/api/v1/organizations');
  await page.getByRole('link', { name: 'Check workspace list' }).click();
  await page.getByRole('link', { name: 'Created once' }).click();
  await heading(page, 'Needs your attention');
  const organizationId = new URL(page.url()).pathname.split('/')[2];
  await db.owner.query(
    "UPDATE organizations SET status = 'suspended' WHERE id = $1",
    [organizationId],
  );
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await heading(page, 'Workspace unavailable');
  expect(await page.locator('.desk').count()).toBe(0);
  await db.owner.query(
    "UPDATE organizations SET status = 'active' WHERE id = $1",
    [organizationId],
  );
  await page.goto('/app/11111111-1111-4111-8111-111111111111/home');
  await heading(page, 'Workspace unavailable');
  const unavailableText = await page.locator('main').textContent();
  const outsider = await t.newContext({ baseURL: origin });
  const outsiderPage = await outsider.newPage();
  await register(outsiderPage, 'outsider@example.test');
  await outsiderPage.goto(`/app/${organizationId}/home`);
  await heading(outsiderPage, 'Workspace unavailable');
  expect(await outsiderPage.locator('main').textContent()).toBe(
    unavailableText,
  );
  await outsider.close();
  await page.route('**/api/v1/organizations/*/context', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 'NOT_READY',
        message: 'Unavailable',
        requestId: 'test',
      }),
    }),
  );
  await page.goto(`/app/${organizationId}/home`);
  await heading(page, 'Luma couldn’t connect');
  expect(page.url()).toContain(`/app/${organizationId}/home`);
  await page.unroute('**/api/v1/organizations/*/context');
  await page.getByRole('button', { name: 'Try again' }).click();
  await heading(page, 'Needs your attention');
  await page.route('**/api/auth/sign-out', (route) => route.abort('failed'));
  await page.goto('/sign-out');
  await heading(page, 'Sign-out not confirmed');
  expect(await page.locator('.desk').count()).toBe(0);
  await page.unroute('**/api/auth/sign-out');
  await page.getByRole('button', { name: 'Retry sign-out' }).click();
  await heading(page, 'Sign in to Luma');
  await page.getByLabel('Email', { exact: true }).fill('ada@example.test');
  await page.getByLabel('Password', { exact: true }).fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page
    .getByText('The email or password isn’t correct. Check both and try again.')
    .waitFor();
  expect(await page.getByLabel('Email', { exact: true }).inputValue()).toBe(
    'ada@example.test',
  );
  expect(await page.getByLabel('Password', { exact: true }).inputValue()).toBe(
    '',
  );
  expect(errors).toEqual([]);
});

test('handles missing sessions, uncertain registration, conflicts and permission failures', async ({
  resources: t,
}) => {
  const { page, context } = await fixture(t);
  let registrations = 0;
  await page.route('**/api/auth/sign-up/email', async (route) => {
    registrations++;
    await route.fetch();
    await route.abort('failed');
  });
  await page.goto('/sign-up');
  await page.getByRole('radio', { name: /Australia/ }).check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Ada');
  await page.getByLabel('Email', { exact: true }).fill('ada@example.test');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page
    .getByRole('button', { name: 'Create account', exact: true })
    .click();
  await page
    .getByText(
      'Luma couldn’t confirm that your account was created. Check your connection, then try signing in before you create another account.',
    )
    .waitFor();
  expect(registrations).toBe(1);
  expect(await page.getByLabel('Name', { exact: true }).inputValue()).toBe(
    'Ada',
  );
  expect(await page.getByLabel('Email', { exact: true }).inputValue()).toBe(
    'ada@example.test',
  );
  expect(await page.getByLabel('Password', { exact: true }).inputValue()).toBe(
    '',
  );
  await page.unroute('**/api/auth/sign-up/email');
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await signIn(page);
  await heading(page, 'Create a workspace');
  const cookies = await context.cookies();
  expect(
    cookies.find((cookie) => cookie.name.includes('session_token'))?.httpOnly,
  ).toBe(true);
  // The proxy must preserve an untrusted Origin, not replace it with the public host.
  const rejected = await context.request.post('/api/v1/organizations', {
    headers: { origin: 'https://untrusted.example' },
    data: { name: 'Rejected', slug: 'rejected', dataRegion: 'AU' },
  });
  expect(rejected.status()).toBe(403);
  for (const [status, code, message] of [
    [400, 'VALIDATION_ERROR', 'Check the workspace name and try again.'],
    [
      409,
      'CONFLICT',
      'That workspace address is already in use. Try again and Luma will choose another one.',
    ],
  ]) {
    await page.route('**/api/v1/organizations', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({
            status,
            contentType: 'application/json',
            body: JSON.stringify({
              code,
              message: 'Rejected',
              requestId: 'test',
            }),
          })
        : route.continue(),
    );
    await page.getByLabel('Workspace name').fill('Recoverable');
    await page
      .getByRole('button', { name: 'Create workspace', exact: true })
      .click();
    await page.getByText(message, { exact: true }).waitFor();
    expect(
      await page
        .getByRole('button', { name: 'Create workspace', exact: true })
        .isEnabled(),
    ).toBe(true);
    await page.unroute('**/api/v1/organizations');
  }
  const id = await createWorkspace(page, 'Allowed workspace');
  await page.route('**/api/v1/organizations/*/context', (route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 'FORBIDDEN',
        message: 'Denied',
        requestId: 'test',
      }),
    }),
  );
  await page.reload();
  await heading(page, 'You don’t have access');
  expect(await page.locator('.desk').count()).toBe(0);
  await page.unroute('**/api/v1/organizations/*/context');
  await page.route('**/api/auth/get-session', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Unavailable' }),
    }),
  );
  await page.goto(`/app/${id}/home`);
  await heading(page, 'Luma couldn’t connect');
  expect(page.url()).toContain(`/app/${id}/home`);
  await page.unroute('**/api/auth/get-session');
  await page.getByRole('button', { name: 'Try again' }).click();
  await heading(page, 'Needs your attention');
  await page.goto('/sign-out');
  await heading(page, 'Sign in to Luma');
  // Registration can succeed without issuing a session under another account policy.
  await page.route('**/api/auth/get-session', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: 'null',
    }),
  );
  await page.goto('/sign-up');
  await page.getByRole('radio', { name: /Australia/ }).check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Grace');
  await page.getByLabel('Email', { exact: true }).fill('grace@example.test');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page
    .getByRole('button', { name: 'Create account', exact: true })
    .click();
  await heading(page, 'Sign in to Luma');
});

test('preserves workspace drafts during session revalidation and clears them on session loss', async ({
  resources: t,
}) => {
  const { db, page } = await fixture(t);
  await register(page);
  const name = page.getByLabel('Workspace name');
  await name.fill('Draft workspace');
  let release;
  let received;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const requested = new Promise((resolve) => {
    received = resolve;
  });
  t.onTestFinished(() => release());
  await page.route('**/api/auth/get-session', async (route) => {
    const response = await route.fetch();
    received();
    await held;
    await route.fulfill({ response });
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await requested;
  expect(await name.isVisible()).toBe(true);
  expect(await name.inputValue()).toBe('Draft workspace');
  await name.fill('Updated draft workspace');
  const refreshed = page.waitForResponse('**/api/auth/get-session');
  release();
  await refreshed;
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  expect(await name.inputValue()).toBe('Updated draft workspace');
  await page.unroute('**/api/auth/get-session');
  await db.owner.query('DELETE FROM sessions');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await heading(page, 'Sign in to Luma');
  expect(await name.count()).toBe(0);
});

test('shows a suspended membership as Access suspended until it is reactivated', async ({
  resources: t,
}) => {
  const { db, page, errors } = await fixture(t);
  await register(page);
  const kept = await createWorkspace(page, 'Kept access');
  await page.goto('/app/workspaces/new');
  const suspended = await createWorkspace(page, 'Suspended access');
  const setStatus = (status) =>
    db.owner.query(
      status === 'suspended'
        ? "UPDATE memberships SET status='suspended',suspended_at=now(),suspended_by_kind='staff',suspended_by=gen_random_uuid(),suspension_reason='Browser journey suspension' WHERE tenant_id=$1"
        : "UPDATE memberships SET status='active',suspended_at=NULL,suspended_by_kind=NULL,suspended_by=NULL,suspension_reason=NULL WHERE tenant_id=$1",
      [suspended],
    );

  // The open workspace rejects the next read and explains why.
  await setStatus('suspended');
  await page.reload();
  await heading(page, 'Access suspended');
  await expect(page.locator('body')).toContainText(
    'Your account and your other workspaces aren’t affected.',
  );
  await page.getByRole('link', { name: 'Choose a workspace' }).click();
  await heading(page, 'Choose a workspace');
  const entry = page.getByRole('link', { name: /Suspended access/ });
  await expect(entry).toContainText('Access suspended');
  await expect(
    page.getByRole('link', { name: 'Kept access', exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Kept access', exact: true }).click();
  await heading(page, 'Needs your attention');
  expect(new URL(page.url()).pathname.split('/')[2]).toBe(kept);
  await page
    .getByRole('button', { name: 'Kept access. Switch workspace' })
    .click();
  await expect(
    page.getByRole('menuitem', { name: /Suspended access/ }),
  ).toContainText('Access suspended');
  await page.keyboard.press('Escape');

  // Reactivation restores the same workspace and role.
  await setStatus('active');
  await page.goto(`/app/${suspended}/settings/team`);
  await expect(page.getByText('Owner', { exact: true }).first()).toBeVisible();
  await expect(page.locator('body')).not.toContainText('Access suspended');
  expect(errors).toEqual([]);
});

test('requires regional confirmation before account creation and keeps it visible in onboarding', async ({
  resources: t,
}) => {
  const { page, db, errors } = await fixture(t);
  await page.goto('/sign-up');
  await heading(page, 'Choose your data region');
  await expect(page.getByLabel('Name', { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('radio', { name: /Australia/ }),
  ).not.toBeChecked();
  await expect(page.getByRole('radio', { name: /Europe/ })).toBeDisabled();
  await expect(
    page.getByRole('radio', { name: /United States/ }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Continue', exact: true }),
  ).toBeDisabled();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole('radio', { name: /Australia/ }).focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await heading(page, 'Create your account');
  await expect(
    page.getByText('Account region: Australia', { exact: true }),
  ).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Regional owner');
  await page
    .getByLabel('Email', { exact: true })
    .fill('regional-owner@example.test');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page
    .getByRole('button', { name: 'Create account', exact: true })
    .click();
  await heading(page, 'Create a workspace');
  await expect(
    page.getByText(
      'This workspace will be created in Australia. Its region cannot be changed here.',
      { exact: true },
    ),
  ).toBeVisible();
  const workspaceId = await createWorkspace(page, 'Regional studio');
  const persisted = await db.owner.query(
    'SELECT data_region FROM organizations WHERE id=$1',
    [workspaceId],
  );
  expect(persisted.rows[0].data_region).toBe('AU');
  const account = await db.owner.query(
    'SELECT confirmed_data_region,region_confirmed_at FROM users WHERE email=$1',
    ['regional-owner@example.test'],
  );
  expect(account.rows[0].confirmed_data_region).toBe('AU');
  expect(account.rows[0].region_confirmed_at).toBeTruthy();
  expect(errors).toEqual([]);
});

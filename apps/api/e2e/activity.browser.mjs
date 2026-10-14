/* global document, innerWidth */
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

import { seedActivity } from './activity-fixture.mjs';
import { expect, test } from './browser-fixtures.mjs';
import { availablePort, database, startApi, startProcess } from './helpers.mjs';

test('filters, saves views, expands, returns, paginates and recovers workspace activity on desktop and narrow screens', async ({
  resources: t,
}) => {
  const port = await availablePort(),
    origin = `http://127.0.0.1:${port}`;
  const db = await database(t);
  await db.migrate();
  await db.grantRuntime();
  // Connection and system filters list the workspace connections.
  const api = await startApi(t, db, origin, 'e2e/connections-server.mjs', {
    FEATURE_FLAG_OVERRIDES: 'adaptive-saved-views=true',
  });
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
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/sign-up');
  await page.getByRole('radio', { name: /Australia/ }).check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Ada Lovelace');
  await page.getByLabel('Email', { exact: true }).fill('activity@example.test');
  await page
    .getByLabel('Password', { exact: true })
    .fill('browser-test-password-123');
  await page
    .getByRole('button', { name: 'Create account', exact: true })
    .click();
  await page.getByLabel('Workspace name').fill('Activity studio');
  await page
    .getByRole('button', { name: 'Create workspace', exact: true })
    .click();
  await page.getByRole('heading', { name: 'Needs your attention' }).waitFor();
  const tenantId = new URL(page.url()).pathname.split('/')[2];
  const actor = (
    await db.owner.query('SELECT user_id FROM memberships WHERE tenant_id=$1', [
      tenantId,
    ])
  ).rows[0].user_id;
  const fixture = await seedActivity(db, tenantId, actor);
  await page.getByRole('link', { name: 'Activity', exact: true }).click();
  await page.locator('.activity-event').first().waitFor();
  // Wide screens list every Activity filter in a docked panel.
  const addFilter = async (category, option) =>
    page
      .getByRole('complementary', { name: 'Filters' })
      .getByRole('region', { name: category, exact: true })
      .getByRole('button', { name: option, exact: true })
      .click();
  const param = (name) => new URL(page.url()).searchParams.get(name);
  // Filters are the view's conditions, so they can be saved and shared.
  const condition = (field) =>
    JSON.parse(param('where') ?? '{"conditions":[]}').conditions.find(
      (item) => item.field === field,
    )?.value;
  await addFilter('System', 'jtl-cloud');
  await expect.poll(() => condition('system')).toEqual(['jtl-cloud']);
  const search = page.getByRole('searchbox', { name: 'Search activity' });
  // People are shown and found by name rather than by user ID.
  await search.fill('lovelace');
  await search.press('Enter');
  await expect.poll(() => param('q')).toBe('lovelace');
  await page.locator('.activity-event').first().waitFor();
  await page.getByText('Ada Lovelace · jtl-cloud').first().waitFor();
  expect(await page.getByText(actor).count()).toBe(0);
  await addFilter('Outcome', 'Outcome unclear');
  await expect.poll(() => condition('outcome')).toEqual(['uncertain']);
  await page
    .getByRole('button', { name: /Change attempt finished/ })
    .first()
    .click();
  await page.getByText('observation:shipping-1042', { exact: true }).waitFor();
  const filtered = page.url();
  await page.reload();
  await page.getByText('observation:shipping-1042', { exact: true }).waitFor();
  await page
    .getByRole('link', { name: 'Open issue and evidence', exact: true })
    .click();
  await page.goBack();
  expect(page.url()).toBe(filtered);
  await page.getByText('observation:shipping-1042', { exact: true }).waitFor();
  await page
    .getByRole('button', {
      name: 'Remove Outcome filter: Outcome unclear',
      exact: true,
    })
    .click();
  // Applying both endpoints together allows a valid range outside the current year.
  await page
    .getByRole('button', {
      name: 'Edit Recorded filter: Last 30 days',
      exact: true,
    })
    .click();
  const picker = page.getByRole('dialog', { name: 'Recorded' });
  await picker.getByLabel('From', { exact: true }).fill('2020-01-01');
  await picker.getByLabel('Through', { exact: true }).fill('2020-01-31');
  await picker
    .getByRole('button', { name: 'Apply range', exact: true })
    .click();
  await page
    .getByRole('heading', { name: 'No activity matches these filters' })
    .waitFor();
  expect(condition('time')).toEqual({ from: '2020-01-01', to: '2020-01-31' });
  await page.reload();
  // Removing the explicit range returns to the default last 30 days.
  await page
    .getByRole('button', {
      name: 'Remove Recorded filter: 1 – 31 Jan 2020',
      exact: true,
    })
    .click();
  await page
    .getByRole('button', {
      name: 'Edit Recorded filter: Last 30 days',
      exact: true,
    })
    .waitFor();
  expect(condition('time')).toBeUndefined();
  await page.locator('.activity-event').first().waitFor();

  // Who recorded an event narrows the timeline: Luma recorded none of these events.
  await addFilter('Recorded by', 'Luma');
  await page
    .getByRole('heading', { name: 'No activity matches these filters' })
    .waitFor();
  await addFilter('Recorded by', 'Luma');
  await addFilter('Recorded by', 'Me');
  await expect.poll(() => condition('actor')).toEqual([{ dynamic: 'me' }]);
  await page.locator('.activity-event').first().waitFor();
  // The combination is kept as a personal view and comes back when Activity opens again.
  await page.getByText('Modified', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Save as new view' }).click();
  const save = page.getByRole('dialog', { name: 'Save as new view' });
  await save.getByLabel('Name').fill('My connection activity');
  await save.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForURL((url) =>
    /^[0-9a-f-]{36}$/.test(url.searchParams.get('view') ?? ''),
  );
  const viewId = param('view');
  await expect
    .poll(
      async () =>
        (
          await (
            await context.request.get(
              `/api/v1/organizations/${tenantId}/collections/activity/state`,
            )
          ).json()
        ).state?.view,
    )
    .toBe(viewId);
  await page.goto(`/app/${tenantId}/activity`);
  await page.waitForURL((url) => url.searchParams.get('view') === viewId);
  await page
    .getByRole('button', { name: 'My connection activity', exact: true })
    .waitFor();
  const panel = page.getByRole('complementary', { name: 'Filters' });
  await expect(
    panel
      .getByRole('region', { name: 'Recorded by', exact: true })
      .getByRole('button', { name: 'Me', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    panel
      .getByRole('region', { name: 'System', exact: true })
      .getByRole('button', { name: 'jtl-cloud', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.activity-event').first().waitFor();
  let failOlder = true;
  const olderPattern = `**/v1/organizations/${tenantId}/activity?*`;
  let olderRequests = 0;
  await page.route(olderPattern, (route) => {
    if (new URL(route.request().url()).searchParams.has('cursor')) {
      olderRequests++;
      if (failOlder)
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'SERVICE_UNAVAILABLE',
            message: 'Unavailable',
          }),
        });
    }

    return route.continue();
  });
  await page.getByRole('button', { name: 'Older events', exact: true }).click();
  await page
    .getByRole('alert')
    .filter({ hasText: 'Activity couldn’t be updated' })
    .waitFor();
  expect(await page.locator('.activity-event').count()).toBe(0);
  failOlder = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(() => page.locator('.activity-event').count()).toBe(6);
  expect(olderRequests).toBe(2);
  await page.unroute(olderPattern);

  const older = page.url();
  await page.reload();
  expect(page.url()).toBe(older);
  // A refresh during the first load joins that read; the late event must arrive after it.
  await expect.poll(() => page.locator('.activity-event').count()).toBe(6);
  await page
    .getByRole('button', { name: 'Refresh activity', exact: true })
    .click();
  expect(page.url()).toBe(older);
  const lateId = randomUUID();
  await db.owner.query(
    'INSERT INTO audit_entries(id,tenant_id,event_key,proposal_id,document) VALUES($1::uuid,$2,$1::text,$3,$4)',
    [
      lateId,
      tenantId,
      fixture.proposalId,
      {
        id: lateId,
        tenantId,
        eventKey: lateId,
        proposalId: fixture.proposalId,
        connectionId: fixture.connectionId,
        eventType: 'execution.prepared',
        occurredAt: fixture.at,
        actor: { kind: 'user', id: actor },
        details: {},
        evidenceRefs: [],
      },
    ],
  );
  await page
    .getByRole('button', { name: 'Refresh activity', exact: true })
    .click();
  await page
    .getByRole('button', {
      name: 'New events available. Show latest',
      exact: true,
    })
    .waitFor();
  expect(page.url()).toBe(older);
  expect(await page.locator('.activity-event').count()).toBe(6);
  await context.setOffline(true);
  await page.getByText(/You’re offline/).waitFor();
  await context.setOffline(false);
  await page
    .getByRole('button', { name: 'Latest events', exact: true })
    .click();
  await expect.poll(() => page.locator('.activity-event').count()).toBe(30);
  const pattern = `**/v1/organizations/${tenantId}/activity?*`;
  await page.route(pattern, (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Unavailable',
      }),
    }),
  );
  await page
    .getByRole('button', { name: 'Refresh activity', exact: true })
    .click();
  await page
    .getByRole('alert')
    .filter({ hasText: 'Activity couldn’t be updated' })
    .waitFor();
  expect(await page.locator('.activity-event').count()).toBe(30);
  await page.unroute(pattern);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByRole('alert').waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 390, height: 844 });
  const first = page
    .getByRole('button', {
      name: /Change attempt finished|System connected|Approved under workspace rules/,
    })
    .first();
  await first.focus();
  await page.keyboard.press('Enter');
  await page.locator('.activity-evidence').waitFor();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await mkdir('/tmp/luma64-screenshots', { recursive: true });
  await page.screenshot({
    path: '/tmp/luma64-screenshots/activity-mobile.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await db.owner.query(
    "UPDATE memberships SET role='member' WHERE tenant_id=$1 AND user_id=$2",
    [tenantId, actor],
  );
  await page
    .getByRole('button', { name: 'Refresh activity', exact: true })
    .click();
  await expect
    .poll(() => page.getByRole('button', { name: /System connected/ }).count())
    .toBe(0);
  const second = await context.request.post('/api/v1/organizations', {
    headers: { origin },
    data: { name: 'Other studio', slug: 'other-studio', dataRegion: 'AU' },
  });
  expect(second.status()).toBe(201);
  const secondId = (await second.json()).id;
  await page.goto(`/app/${secondId}/activity`);
  await page
    .getByRole('heading', { name: 'No activity in the last 30 days' })
    .waitFor();
  expect(await page.locator('.activity-event').count()).toBe(0);
  await page.goBack();
  await page.locator('.activity-event').first().waitFor();
  await db.owner.query(
    'DELETE FROM memberships WHERE tenant_id=$1 AND user_id=$2',
    [tenantId, actor],
  );
  await page
    .getByRole('button', { name: 'Refresh activity', exact: true })
    .click();
  await expect.poll(() => page.locator('.activity-event').count()).toBe(0);
  await page.goto(`/app/${randomUUID()}/activity`);
  await expect.poll(() => page.locator('.activity-event').count()).toBe(0);
  expect(errors).toEqual([]);
});

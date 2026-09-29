/* global document, innerWidth */
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

import { seedActivity } from './activity-fixture.mjs';
import { expect, test } from './browser-fixtures.mjs';
import { availablePort, database, startApi, startProcess } from './helpers.mjs';

test('filters, expands, returns, paginates and recovers workspace activity on desktop and narrow screens', async ({
  resources: t,
}) => {
  const port = await availablePort(),
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
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/sign-up');
  await page.getByLabel('Name', { exact: true }).fill('Ada');
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
  await page.getByLabel('System', { exact: true }).fill('jtl-cloud');
  await page.getByLabel('Search activity').fill(actor);
  await page.locator('.activity-event').first().waitFor();
  await page.getByLabel('Outcome', { exact: true }).selectOption('uncertain');
  await page
    .getByRole('button', { name: /Execution completed/ })
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
  await page.getByLabel('Outcome', { exact: true }).selectOption('');
  // Applying both endpoints together allows a valid range outside the current year.
  const rangeFrom = await page
    .getByLabel('From (workspace time)', { exact: true })
    .inputValue();
  const rangeTo = await page
    .getByLabel('Through (workspace time)', { exact: true })
    .inputValue();
  await page
    .getByLabel('From (workspace time)', { exact: true })
    .fill('2020-01-01');
  await page
    .getByLabel('Through (workspace time)', { exact: true })
    .fill('2020-01-31');
  await page.getByRole('button', { name: 'Apply dates', exact: true }).click();
  await page
    .getByRole('heading', { name: 'No matching recorded activity' })
    .waitFor();
  expect(new URL(page.url()).searchParams.get('from')).toBe('2020-01-01');
  await page.reload();
  expect(
    await page
      .getByLabel('Through (workspace time)', { exact: true })
      .inputValue(),
  ).toBe('2020-01-31');
  await page
    .getByLabel('From (workspace time)', { exact: true })
    .fill(rangeFrom);
  await page
    .getByLabel('Through (workspace time)', { exact: true })
    .fill(rangeTo);
  await page.getByRole('button', { name: 'Apply dates', exact: true }).click();
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
    .filter({ hasText: 'Activity could not be updated' })
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
      name: 'New events available — view latest',
      exact: true,
    })
    .waitFor();
  expect(page.url()).toBe(older);
  expect(await page.locator('.activity-event').count()).toBe(6);
  await context.setOffline(true);
  await page.getByText(/You are offline/).waitFor();
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
    .filter({ hasText: 'Activity could not be updated' })
    .waitFor();
  expect(await page.locator('.activity-event').count()).toBe(30);
  await page.unroute(pattern);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByRole('alert').waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 390, height: 844 });
  const first = page
    .getByRole('button', {
      name: /Execution completed|Connection connected|Policy approved/,
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
    .poll(() =>
      page.getByRole('button', { name: /Connection connected/ }).count(),
    )
    .toBe(0);
  const second = await context.request.post('/api/v1/organizations', {
    headers: { origin },
    data: { name: 'Other studio', slug: 'other-studio', dataRegion: 'EU' },
  });
  expect(second.status()).toBe(201);
  const secondId = (await second.json()).id;
  await page.goto(`/app/${secondId}/activity`);
  await page
    .getByRole('heading', { name: 'No matching recorded activity' })
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

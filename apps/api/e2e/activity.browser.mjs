/* global document, innerWidth */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';

import { seedActivity } from './activity-fixture.mjs';
import { expect, test } from './browser-fixtures.mjs';
import { availablePort, database, startApi, startProcess } from './helpers.mjs';

test('filters, saves views, previews, returns, loads older and new events and recovers workspace activity on desktop and narrow screens', async ({
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
  await page.getByRole('heading', { name: 'Needs you' }).waitFor();
  const tenantId = new URL(page.url()).pathname.split('/')[2];
  const actor = (
    await db.owner.query('SELECT user_id FROM memberships WHERE tenant_id=$1', [
      tenantId,
    ])
  ).rows[0].user_id;
  const fixture = await seedActivity(db, tenantId, actor, 35, true);
  await page.getByRole('link', { name: 'Activity', exact: true }).click();
  const rows = page.locator('.activity-feed [data-list-row]');
  await rows.first().waitFor();
  // Every filter is a pill; a multi-choice picker stays open until Done.
  const addFilter = async (category, option, multi = false) => {
    await page
      .getByRole('button', {
        name: new RegExp(`^(Add ${category} filter|Edit ${category} filter: )`),
      })
      .click();
    const picker = page.getByRole('dialog', { name: category, exact: true });
    await picker.getByRole('button', { name: option, exact: true }).click();
    if (multi)
      await picker.getByRole('button', { name: 'Done', exact: true }).click();
    await picker.waitFor({ state: 'hidden' });
  };
  const param = (name) => new URL(page.url()).searchParams.get(name);
  // Filters are the view's conditions, so they can be saved and shared.
  const condition = (field) =>
    JSON.parse(param('where') ?? '{"conditions":[]}').conditions.find(
      (item) => item.field === field,
    )?.value;
  await addFilter('System', 'JTL Cloud');
  await expect.poll(() => condition('system')).toEqual(['jtl-cloud']);
  const search = page.getByRole('searchbox', { name: 'Search activity' });
  // People are shown and found by name rather than by user ID.
  await search.fill('lovelace');
  await search.press('Enter');
  await expect.poll(() => param('q')).toBe('lovelace');
  await rows.first().waitFor();
  await page
    .getByText(/Ada Lovelace · JTL Cloud$/)
    .first()
    .waitFor();
  expect(await page.getByText(actor).count()).toBe(0);
  await addFilter('Outcome', 'Outcome unclear', true);
  await expect.poll(() => condition('outcome')).toEqual(['uncertain']);
  // An open event shows beside the list and survives a reload and a visit to its issue.
  await page
    .getByRole('link', { name: /^Change the order’s shipping method\./ })
    .first()
    .click();
  const preview = page.getByRole('region', { name: 'Event details' });
  await preview
    .getByText('observation:shipping-1042', { exact: true })
    .waitFor();
  await preview
    .getByText(/Luma couldn’t tell whether this took effect/)
    .waitFor();
  const filtered = page.url();
  await page.reload();
  await preview
    .getByText('observation:shipping-1042', { exact: true })
    .waitFor();
  await preview
    .getByRole('link', { name: 'Open issue and evidence', exact: true })
    .click();
  await page.waitForURL((url) => url.pathname.includes('/exceptions/'));
  await page.goBack();
  expect(page.url()).toBe(filtered);
  await preview
    .getByText('observation:shipping-1042', { exact: true })
    .waitFor();
  await page
    .getByRole('button', {
      name: 'Remove Outcome filter: Outcome unclear',
      exact: true,
    })
    .click();
  expect(param('event')).toBeNull();
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
  await rows.first().waitFor();

  // Who recorded an event narrows the timeline: Luma recorded none of these events.
  await addFilter('Recorded by', 'Luma', true);
  await page
    .getByRole('heading', { name: 'No activity matches these filters' })
    .waitFor();
  await page
    .getByRole('button', { name: 'Edit Recorded by filter: Luma', exact: true })
    .click();
  const people = page.getByRole('dialog', { name: 'Recorded by', exact: true });
  await people.getByRole('button', { name: 'Luma', exact: true }).click();
  await people.getByRole('button', { name: 'Me', exact: true }).click();
  await people.getByRole('button', { name: 'Done', exact: true }).click();
  await expect.poll(() => condition('actor')).toEqual([{ dynamic: 'me' }]);
  await rows.first().waitFor();
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
  await page
    .getByRole('button', { name: 'Edit Recorded by filter: Me', exact: true })
    .waitFor();
  await page
    .getByRole('button', { name: 'Edit System filter: JTL Cloud', exact: true })
    .waitFor();
  await expect.poll(() => rows.count()).toBe(30);

  // Older events load below the newest; a failed read keeps the list and can be retried.
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
  await page
    .getByRole('button', { name: 'Show older events', exact: true })
    .click();
  await page
    .getByRole('alert')
    .filter({ hasText: 'Older events couldn’t be loaded.' })
    .waitFor();
  expect(await rows.count()).toBe(30);
  failOlder = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(() => rows.count()).toBe(36);
  expect(olderRequests).toBe(2);
  await page.getByText('No older events in this date range.').waitFor();
  await page.unroute(olderPattern);
  // Each quick view counts what it lists under the other filters.
  await page.getByRole('tab', { name: /^All\s*36$/ }).waitFor();

  // A link to an event below the first page opens it without loading the pages above it.
  const olderLink = await rows.last().getByRole('link').getAttribute('href');
  await page.goto(olderLink);
  await page
    .getByRole('region', { name: 'Event details' })
    .getByRole('link', { name: 'Open issue and evidence', exact: true })
    .waitFor();
  expect(await rows.count()).toBe(30);
  await page
    .getByRole('button', { name: 'Close preview', exact: true })
    .click();

  // An export downloads every matching event as CSV with the reader's headings.
  const download = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Export as CSV', exact: true })
    .click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^activity-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = await readFile(await file.path(), 'utf8');
  expect(csv.split('\r\n')[0]).toContain('Outcome');
  await page.getByText(/^Exported \d+ events\.$/).waitFor();
  await rows.first().waitFor();

  // A new event is offered at the top without moving the list being read.
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
  // Returning to the tab checks for new events at once.
  await page.evaluate(() =>
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true })),
  );
  // The poll may still list the list's newest event below the new one, and then counts it.
  const showNew = page.getByRole('button', {
    name: /^(New events\. Show latest|Show \d+ new events?)$/,
  });
  await showNew.waitFor();
  expect(await rows.count()).toBe(30);
  await showNew.click();
  await expect
    .poll(() => rows.first().getByRole('link').getAttribute('aria-label'))
    .toMatch(/Started/);
  await showNew.waitFor({ state: 'hidden' });

  await context.setOffline(true);
  await page.getByText(/You’re offline/).waitFor();
  await context.setOffline(false);
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
  expect(await rows.count()).toBeGreaterThan(0);
  await page.unroute(pattern);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page
    .getByRole('alert')
    .filter({ hasText: 'Activity couldn’t be updated' })
    .waitFor({ state: 'hidden' });

  // On a phone the open event fills the screen without horizontal scrolling.
  await page.setViewportSize({ width: 390, height: 844 });
  const first = rows.first().getByRole('link');
  await first.focus();
  await page.keyboard.press('Enter');
  await page.locator('.activity-detail').waitFor();
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
  await page.getByRole('button', { name: 'Back to list', exact: true }).click();
  expect(param('event')).toBeNull();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await db.owner.query(
    "UPDATE memberships SET role='member' WHERE tenant_id=$1 AND user_id=$2",
    [tenantId, actor],
  );
  await page
    .getByRole('button', { name: 'Refresh activity', exact: true })
    .click();
  await expect
    .poll(() => page.getByRole('link', { name: /^System connected\./ }).count())
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
  expect(await rows.count()).toBe(0);
  await page.goBack();
  await rows.first().waitFor();
  await db.owner.query(
    'DELETE FROM memberships WHERE tenant_id=$1 AND user_id=$2',
    [tenantId, actor],
  );
  await page
    .getByRole('button', { name: 'Refresh activity', exact: true })
    .click();
  await expect.poll(() => rows.count()).toBe(0);
  await page.goto(`/app/${randomUUID()}/activity`);
  await expect.poll(() => rows.count()).toBe(0);
  expect(errors).toEqual([]);
});

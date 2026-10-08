/* global document, innerWidth, getComputedStyle */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { createDetectionServices } from '@luma/application-runtime';
import { defaultConfiguration } from '@luma/exceptions';
import {
  builtInMembership,
  makeTenantContext,
} from '@luma/identity/composition';

import { expect, test } from './browser-fixtures.mjs';
import { availablePort, database, startApi, startProcess } from './helpers.mjs';

test('opens contextual issue guides and preserves the investigation across help navigation', async ({
  resources: t,
}) => {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const db = await database(t);
  await db.migrate();
  await db.grantRuntime();
  await db.owner.query(
    `GRANT luma_connectors,luma_exceptions TO "${new URL(db.runtimeUrl).username}"`,
  );
  const api = await startApi(t, db, origin, 'e2e/connections-server.mjs');
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
  const signup = await context.request.post('/api/auth/sign-up/email', {
    headers: { origin },
    data: {
      name: 'Ada',
      email: 'help@example.test',
      password: 'help-browser-password-123',
    },
  });
  expect(signup.status()).toBe(200);
  const user = (await signup.json()).user;
  const creation = await context.request.post('/api/v1/organizations', {
    headers: { origin },
    data: {
      name: 'North Studio',
      slug: `help-${randomUUID()}`,
      dataRegion: 'EU',
    },
  });
  expect(creation.status()).toBe(201);
  const organization = await creation.json();
  const organizationId = organization.id;
  const tenant = makeTenantContext(
    { userId: user.id, sessionId: randomUUID() },
    { ...organization, status: 'active' },
    builtInMembership(
      { id: randomUUID(), organizationId, userId: user.id },
      'owner',
    ),
    randomUUID(),
  );
  const services = createDetectionServices(db.runtimeUrl);
  t.onTestFinished(() => services.close());
  const corpus = JSON.parse(
    await readFile(
      new URL(
        '../../../packages/exceptions/fixtures/exceptions-v0.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const connectionId = randomUUID();
  const key = 'help-scan';
  const result = await services.exceptions.ingest(tenant, {
    key,
    input: {
      exceptionClass: 'sync_failure',
      facts: {
        ...corpus.bases.sync_failure,
        tenantId: organizationId,
        evidenceTenantId: organizationId,
        connectionId,
        subjectId: connectionId,
        evidenceRefs: [key],
      },
    },
    configuration: defaultConfiguration,
    evidence: [
      {
        key,
        tenantId: organizationId,
        connectionId,
        observedAt: new Date().toISOString(),
        sourceUpdatedAt: null,
        adapterVersion: 'fixture-v1',
        schemaVersion: 1,
        source: {
          provider: 'Shopify',
          resource: 'Orders',
          externalId: key,
          scopeKey: 'orders',
        },
        facts: { errorCode: 'authentication' },
      },
    ],
  });
  const exceptionId = result.incident.id;
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const inbox = `/app/${organizationId}/exceptions?view=active&class=sync_failure`;
  await page.goto(inbox);
  const row = page.locator(`#case-${exceptionId}`);
  await row.waitFor();
  const helpButton = page.getByRole('button', { name: 'Help for this page' });
  const help = page.getByRole('dialog', { name: 'Help', exact: true });
  const inboxUrl = page.url();
  await helpButton.click();
  await help
    .getByRole('heading', { name: 'Find and prioritize issues', exact: true })
    .waitFor();
  await help
    .getByRole('navigation', { name: 'On this page' })
    .getByRole('link', { name: 'Filter the list' })
    .click();
  await expect
    .poll(() =>
      help
        .locator('#help-filter-the-list')
        .evaluate((element) => element === document.activeElement),
    )
    .toBe(true);
  expect(page.url()).toBe(inboxUrl);
  await help
    .getByRole('navigation', { name: 'Guides' })
    .getByRole('link', { name: 'Investigate an issue' })
    .click();
  await help
    .getByRole('heading', { name: 'Investigate an issue', exact: true })
    .waitFor();
  await help.getByRole('button', { name: 'Back', exact: true }).click();
  await help
    .getByRole('heading', { name: 'Find and prioritize issues', exact: true })
    .waitFor();
  await help
    .getByRole('searchbox', { name: 'Search documentation' })
    .fill('reverse');
  await help.locator('.docs-search-results a').first().click();
  await help
    .getByRole('heading', { name: 'Resolve an issue', exact: true })
    .waitFor();
  const popupPromise = page.waitForEvent('popup');
  await help.getByRole('link', { name: /Open full documentation/ }).click();
  const docsTab = await popupPromise;
  await docsTab
    .getByRole('heading', { name: 'Resolve an issue', exact: true })
    .waitFor();
  await docsTab.close();
  expect(page.url()).toBe(inboxUrl);
  await page.keyboard.press('Escape');
  await help.waitFor({ state: 'hidden' });
  await expect
    .poll(() =>
      helpButton.evaluate((element) => element === document.activeElement),
    )
    .toBe(true);
  await row.click();
  await page.getByRole('link', { name: 'Open full page' }).waitFor();
  const selectedUrl = page.url();
  await helpButton.click();
  await help
    .getByRole('heading', { name: 'Investigate an issue', exact: true })
    .waitFor();
  await expect
    .poll(() => help.evaluate((element) => getComputedStyle(element).opacity))
    .toBe('1');
  expect(await help.boundingBox()).toMatchObject({
    x: 880,
    y: 0,
    width: 560,
    height: 1000,
  });
  await page.screenshot({
    path: '/tmp/luma-help-drawer-desktop.png',
    fullPage: true,
  });
  await page.keyboard.press('Escape');
  await help.waitFor({ state: 'hidden' });
  expect(page.url()).toBe(selectedUrl);
  await page.getByRole('link', { name: 'Open full page' }).click();
  await page.locator('.issue-page').waitFor();
  const fullUrl = page.url();
  await helpButton.click();
  await help
    .getByRole('heading', { name: 'Investigate an issue', exact: true })
    .waitFor();
  await page.keyboard.press('Escape');
  await help.waitFor({ state: 'hidden' });
  expect(page.url()).toBe(fullUrl);
  await page.screenshot({
    path: '/tmp/luma-help-issue-header.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: '/tmp/luma-help-issue-header-mobile.png',
    fullPage: true,
  });
  await helpButton.click();
  await help
    .getByRole('heading', { name: 'Investigate an issue', exact: true })
    .waitFor();
  expect(Math.round((await help.boundingBox()).width)).toBe(390);
  await expect
    .poll(() => help.evaluate((element) => getComputedStyle(element).opacity))
    .toBe('1');
  await page.screenshot({
    path: '/tmp/luma-help-drawer-mobile.png',
    fullPage: true,
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect
    .poll(() => page.locator('html').getAttribute('class'))
    .toContain('dark');
  await page.screenshot({
    path: '/tmp/luma-help-drawer-dark.png',
    fullPage: true,
  });
  await help.getByRole('button', { name: 'Close', exact: true }).click();
  await help.waitFor({ state: 'hidden' });
  expect(page.url()).toBe(fullUrl);
  await page.getByRole('link', { name: 'Back to issues' }).click();
  expect(page.url()).toBe(selectedUrl);
  await page.goto(`/app/${organizationId}/home`);
  await page.getByRole('heading', { name: 'Needs your attention' }).waitFor();
  await helpButton.click();
  await help
    .getByRole('heading', { name: 'Start your day on Home', exact: true })
    .waitFor();
  await page.keyboard.press('Escape');
  await help.waitFor({ state: 'hidden' });
  expect(await page.locator('vite-error-overlay').count()).toBe(0);
  expect(errors).toEqual([]);
});

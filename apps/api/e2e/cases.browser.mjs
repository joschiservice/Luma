/* global document, innerWidth, window */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { chromium } from 'playwright';
import { expect, it } from 'vitest';

import { createDetectionServices } from '../dist/app.js';
import { defaultConfiguration } from '../dist/modules/exceptions/index.js';
import { makeTenantContext } from '../dist/modules/identity/composition.js';
import { availablePort, database, startApi, startProcess } from './helpers.mjs';

it('reads persisted cases, restores desktop/mobile routes and focus, and denies other tenants', async (t) => {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const db = await database(t);
  await db.migrate();
  await db.grantRuntime();
  const role = new URL(db.runtimeUrl).username;
  await db.owner.query(`GRANT luma_connectors,luma_exceptions TO "${role}"`);
  const api = await startApi(t, db, origin, 'e2e/connections-server.mjs');
  const web = startProcess(
    t,
    'e2e/web-server.mjs',
    { TEST_API_ORIGIN: api.origin, TEST_WEB_PORT: String(port) },
    true,
  );
  await web.message('listening');
  const browser = await chromium.launch();
  t.onTestFinished(() => browser.close());
  const context = await browser.newContext({
    baseURL: origin,
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/sign-up');
  await page.getByLabel('Name', { exact: true }).fill('Ada');
  await page.getByLabel('Email', { exact: true }).fill('cases@example.test');
  await page
    .getByLabel('Password', { exact: true })
    .fill('browser-test-password-123');
  await page
    .getByRole('button', { name: 'Create account', exact: true })
    .click();
  await page.getByLabel('Workspace name').fill('North Studio');
  await page
    .getByRole('button', { name: 'Create workspace', exact: true })
    .click();
  await page.getByRole('heading', { name: 'Operations overview' }).waitFor();
  const organizationId = new URL(page.url()).pathname.split('/')[2];
  await page
    .getByRole('heading', { name: 'Connect your first system.' })
    .waitFor();
  expect(await page.getByText('Unavailable', { exact: true }).count()).toBe(2);
  await page.getByLabel('Resolution window').selectOption('7d');
  await page.waitForURL('**/overview?window=7d');
  await page.reload();
  expect(await page.getByLabel('Resolution window').inputValue()).toBe('7d');
  const overviewDenied = await context.request.get(
    `/api/v1/organizations/${randomUUID()}/operations/overview`,
  );
  expect(overviewDenied.status()).toBe(404);
  const anonymous = await browser.newContext({ baseURL: origin });
  expect(
    (
      await anonymous.request.get(
        `/api/v1/organizations/${organizationId}/operations/overview`,
      )
    ).status(),
  ).toBe(401);
  await anonymous.close();
  const inbox = `/app/${organizationId}/exceptions`;
  await page.goto(inbox);
  await page.getByText('Nothing needs review', { exact: true }).waitFor();
  await page.getByText('No data received yet', { exact: true }).waitFor();
  await page.getByText('No active connections', { exact: true }).waitFor();
  await page.keyboard.press('Control+k');
  await page.getByRole('dialog', { name: 'Go to a page' }).waitFor();
  await page.getByRole('textbox', { name: 'Search pages' }).fill('issue');
  await page
    .getByRole('navigation', { name: 'Search results' })
    .getByRole('link', { name: 'Issues' })
    .click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect
    .poll(() => page.locator('html').getAttribute('class'))
    .toContain('dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect
    .poll(() => page.locator('html').getAttribute('class'))
    .not.toContain('dark');

  const services = createDetectionServices(db.runtimeUrl);
  t.onTestFinished(() => services.close());
  const actorId = randomUUID();
  const tenant = makeTenantContext(
    { userId: actorId, sessionId: randomUUID() },
    {
      id: organizationId,
      name: 'North Studio',
      slug: 'north',
      dataRegion: 'EU',
      status: 'active',
    },
    { id: randomUUID(), organizationId, userId: actorId, role: 'owner' },
    randomUUID(),
  );
  const corpus = JSON.parse(
    await readFile(
      new URL('../../../docs/fixtures/exceptions-v0.json', import.meta.url),
      'utf8',
    ),
  );
  const ids = [];
  for (let i = 0; i < 27; i++) {
    const connectionId = randomUUID(),
      key = `scan-${i}`,
      now = new Date().toISOString();
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
          observedAt: now,
          sourceUpdatedAt: null,
          adapterVersion: 'fixture-v1',
          schemaVersion: 1,
          source: {
            provider: 'Shopify',
            resource: 'Orders',
            externalId: `scan-${i}`,
            scopeKey: 'orders',
          },
          facts: { errorCode: 'authentication' },
        },
      ],
    });
    ids.push(result.incident.id);
  }
  await page.getByRole('link', { name: 'All open', exact: true }).click();
  await page.locator('.inbox-rows li').first().waitFor();
  expect(await page.locator('.inbox-rows li').count()).toBe(25);
  await page.getByText('Page 1 of 2', { exact: true }).waitFor();
  await page.getByText('1–25 of 27 issues', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect.poll(() => page.locator('.inbox-rows li').count()).toBe(2);
  await page.getByText('Page 2 of 2', { exact: true }).waitFor();
  await page.getByText('26–27 of 27 issues', { exact: true }).waitFor();
  await page.reload();
  await page.getByText('Page 2 of 2', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Return to first page' }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Previous', exact: true }).click();
  await page.getByText('Filter issues', { exact: true }).click();
  await page.getByLabel('Class', { exact: true }).selectOption('sync_failure');
  const row = page.locator(`#case-${ids[0]}`);
  await row.click();
  await page
    .locator('.inbox-detail')
    .getByText('Investigation pending', { exact: true })
    .waitFor();
  await expect
    .poll(() =>
      page
        .locator('.inbox-detail')
        .evaluate((el) => el === document.activeElement),
    )
    .toBe(true);
  await page.reload();
  await page
    .locator('.inbox-detail')
    .getByText('Investigation pending', { exact: true })
    .waitFor();
  expect(await page.getByLabel('Class', { exact: true }).inputValue()).toBe(
    'sync_failure',
  );
  expect(await row.isVisible()).toBe(true);
  await page.getByText('Live', { exact: true }).waitFor();
  await services.diagnoses.run(tenant, ids[0]);
  // The credentialed stream refreshes the completed investigation without a click.
  await page
    .getByRole('heading', {
      name: 'The connection read needs investigation',
      exact: true,
    })
    .waitFor();
  expect(await page.getByRole('button', { name: /approve/i }).count()).toBe(0);
  // Exercise presentation of authoritative HTTP snapshots through the live host.
  const caseApi = `/api/v1/organizations/${organizationId}/exceptions/${ids[0]}`;
  const baseline = await (await context.request.get(caseApi)).json();
  const baselineProgress = await (
    await context.request.get(`${caseApi}/progress`)
  ).json();
  let snapshotState = 'awaiting_approval';
  const executionId = randomUUID();
  await page.route(`**${caseApi}`, (route) =>
    route.fulfill({ json: { ...baseline, state: snapshotState } }),
  );
  await page.route(`**${caseApi}/progress`, (route) =>
    route.fulfill({
      json: {
        ...baselineProgress,
        state: snapshotState,
        execution:
          snapshotState === 'awaiting_approval'
            ? null
            : {
                id: executionId,
                proposalId: executionId,
                attemptId: executionId,
                attempt: 1,
                state:
                  snapshotState === 'failed'
                    ? 'failed'
                    : snapshotState === 'executing'
                      ? 'prepared'
                      : 'succeeded',
                requestedBy: 'test-worker',
                executor: { kind: 'connector', id: 'test-connector' },
                startedAt: baseline.detectedAt,
                finishedAt:
                  snapshotState === 'executing' ? null : baseline.detectedAt,
                effectEvidenceRefs: ['effect-ref'],
                verification:
                  snapshotState === 'resolved'
                    ? {
                        outcome: 'passed',
                        observationRefs: ['verified-ref'],
                        observedAt: baseline.detectedAt,
                        evaluatorVersion: 'test-v1',
                      }
                    : null,
              },
        resolution:
          snapshotState === 'resolved'
            ? {
                kind: 'verification',
                at: baseline.detectedAt,
                actorId: 'verifier',
                evidenceRefs: ['verified-ref'],
              }
            : null,
        workflow: {
          availability: 'available',
          progress: {
            phase: snapshotState === 'failed' ? 'escalated' : snapshotState,
          },
        },
      },
    }),
  );
  for (const state of [
    'awaiting_approval',
    'executing',
    'verifying',
    'resolved',
    'failed',
    'escalated',
  ]) {
    snapshotState = state;
    await page.getByRole('button', { name: 'Refresh progress' }).click();
    await expect
      .poll(() => page.locator('.case-progress-state strong').textContent())
      .toBe(state.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase()));
    if (state === 'verifying') {
      expect(await page.getByText('Succeeded', { exact: true }).count()).toBe(
        1,
      );
      expect(
        await page
          .getByText('Recorded verified resolution', { exact: true })
          .count(),
      ).toBe(0);
    }
    if (state === 'resolved')
      await page
        .getByText('Recorded verified resolution', { exact: true })
        .waitFor();
    expect(await page.getByRole('button', { name: /retry/i }).count()).toBe(0);
  }
  await page.unroute(`**${caseApi}`);
  await page.unroute(`**${caseApi}/progress`);
  await page.getByRole('button', { name: 'Refresh progress' }).click();
  await expect
    .poll(() => page.locator('.case-progress-state strong').textContent())
    .toBe(
      baselineProgress.state
        .replaceAll('_', ' ')
        .replace(/^./, (c) => c.toUpperCase()),
    );
  await page.getByText('Live', { exact: true }).waitFor();
  const recordedTimeline = await (
    await context.request.get(`${caseApi}/timeline?limit=100`)
  ).json();
  const slowEvent = {
    id: randomUUID(),
    type: 'review.slow_refresh_completed',
    occurredAt: baseline.detectedAt,
    actorId: null,
    proposalId: null,
    outcome: null,
    evidenceRefs: [],
  };
  let slowRefresh = true;
  let releasePage;
  const pageGate = new Promise((resolve) => {
    releasePage = resolve;
  });
  await page.route(`**${caseApi}/timeline?**`, async (route) => {
    const laterPage = new URL(route.request().url()).searchParams.has('cursor');
    if (slowRefresh) await new Promise((resolve) => setTimeout(resolve, 6500));
    if (laterPage) await pageGate;
    await route.fulfill({
      json: {
        items: laterPage
          ? [
              {
                ...slowEvent,
                id: randomUUID(),
                type: 'review.history_page_loaded',
              },
            ]
          : [...recordedTimeline.items, slowEvent],
        nextCursor: laterPage ? null : 'review-page-2',
      },
    });
  });
  const recommendations = await page.locator('.case-step').allTextContents();
  expect(recommendations.length).toBeGreaterThan(0);
  // The request spans a second SSE heartbeat. It must finish without being cancelled.
  await page.waitForRequest((request) =>
    request.url().includes(`${caseApi}/timeline?`),
  );
  await page.getByText('Refreshing', { exact: true }).waitFor();
  expect(await page.locator('.case-step').allTextContents()).toEqual(
    recommendations,
  );
  expect(
    await page.getByText('Evidence is stale', { exact: true }).count(),
  ).toBe(0);
  await page
    .getByText('Review slow refresh completed', { exact: true })
    .waitFor();
  slowRefresh = false;
  const auditDetails = page.locator('.case-audit details').first();
  await auditDetails.locator('summary').click();
  await auditDetails.evaluate((element) => {
    element.dataset.retained = 'true';
  });
  await Promise.all([
    page.waitForRequest((request) =>
      request.url().includes('cursor=review-page-2'),
    ),
    page
      .getByRole('button', { name: 'Load more history and evidence' })
      .click(),
  ]);
  expect(await auditDetails.getAttribute('open')).not.toBeNull();
  expect(await auditDetails.getAttribute('data-retained')).toBe('true');
  expect(await page.getByLabel('Loading issues').count()).toBe(0);
  releasePage();
  await page.getByText('Review history page loaded', { exact: true }).waitFor();
  expect(await auditDetails.getAttribute('data-retained')).toBe('true');
  await page.unroute(`**${caseApi}/timeline?**`);
  await page
    .locator('.failed-disclosure > summary')
    .filter({ hasText: 'Findings & evidence' })
    .click();
  const evidence = page.locator('.case-evidence summary').first();
  await evidence.focus();
  await page.keyboard.press('Enter');
  await expect
    .poll(() =>
      evidence.evaluate((el) => el.parentElement.hasAttribute('open')),
    )
    .toBe(true);
  await page.locator('.inbox-detail').evaluate((el) => {
    el.scrollTop = 0;
  });
  expect(
    await page.evaluate(() => ({
      height: document.documentElement.scrollHeight,
      viewport: window.innerHeight,
    })),
  ).toEqual({ height: 1000, viewport: 1000 });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin,
  });
  await page.getByText('Issue details', { exact: true }).click();
  await page
    .getByRole('button', { name: 'Copy issue ID', exact: true })
    .click();
  await page.getByText('Issue ID copied', { exact: true }).waitFor();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    ids[0],
  );
  expect(await page.locator('.issue-id code').textContent()).toBe(ids[0]);
  await page.getByText('Issue details', { exact: true }).click();
  await page.locator('.inbox-detail').evaluate((el) => {
    el.scrollTop = 0;
  });
  const inspectorHeader = page.locator('.inbox-case-nav');
  const headerTop = await inspectorHeader.evaluate(
    (el) => el.getBoundingClientRect().top,
  );
  await page.locator('.inbox-detail').evaluate((el) => {
    el.scrollTop = 500;
  });
  expect(
    await inspectorHeader.evaluate((el) => el.getBoundingClientRect().top),
  ).toBe(headerTop);
  expect(await inspectorHeader.getByRole('heading').isVisible()).toBe(true);
  expect(
    await inspectorHeader
      .getByText('Connection issue', { exact: true })
      .isVisible(),
  ).toBe(true);
  expect(
    await inspectorHeader.locator('.issue-context-subject strong').isVisible(),
  ).toBe(true);
  expect(await inspectorHeader.getByText('High severity').isVisible()).toBe(
    true,
  );
  await page.locator('.inbox-detail').evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.screenshot({ path: '/tmp/luma-21-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await row.isVisible()).toBe(false);
  await page.screenshot({ path: '/tmp/luma-21-mobile.png', fullPage: true });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole('button', { name: 'Refresh issue', exact: true })
    .click();
  await page.getByRole('button', { name: 'Close panel' }).click();
  // The completed diagnosis moved this row beyond page one; focus falls back to the inbox.
  await expect
    .poll(() =>
      page
        .locator('.inbox-list')
        .evaluate((el) => el === document.activeElement),
    )
    .toBe(true);
  const stableRow = page.locator(`#case-${ids[10]}`);
  await stableRow.scrollIntoViewIfNeeded();
  const scroll = await page
    .locator('.inbox-list')
    .evaluate((el) => el.scrollTop);
  await stableRow.click();
  await page.keyboard.press('Escape');
  await expect
    .poll(() => stableRow.evaluate((el) => el === document.activeElement))
    .toBe(true);
  await stableRow.click();
  await page.goBack();
  await expect
    .poll(() => stableRow.evaluate((el) => el === document.activeElement))
    .toBe(true);
  expect(await page.locator('.inbox-list').evaluate((el) => el.scrollTop)).toBe(
    scroll,
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${inbox}/${ids[0]}?view=active&class=sync_failure`);
  await page
    .getByRole('heading', {
      name: 'The connection read needs investigation',
      exact: true,
    })
    .waitFor();
  await page.getByRole('link', { name: 'Needs review', exact: true }).click();
  await page
    .getByRole('heading', {
      name: 'The connection read needs investigation',
      exact: true,
    })
    .waitFor();
  const audit = page.locator('.case-audit > li');
  const eventCount = await audit.count();
  await page.getByRole('button', { name: 'Refresh progress' }).click();
  await expect.poll(() => audit.count()).toBe(eventCount);
  await page.getByText('Live', { exact: true }).waitFor();
  // An offline notification can precede the transport's error event.
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.getByText('Connection lost', { exact: true }).waitFor();
  await page
    .getByText('Current state is unconfirmed', { exact: true })
    .waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.getByText('Live', { exact: true }).waitFor();
  await context.setOffline(true);
  await page.getByText('Connection lost', { exact: true }).waitFor();
  await page
    .getByText('Current state is unconfirmed', { exact: true })
    .waitFor();
  await context.setOffline(false);
  await page.getByText('Live', { exact: true }).waitFor();
  await services.exceptions.resolve(tenant, ids[0], {
    kind: 'human_disposition',
    reason: 'Handled by operator',
    evidenceRefs: ['scan-0'],
  });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page
    .getByText('This issue has left the current view', { exact: true })
    .waitFor();
  await page
    .getByRole('heading', { name: 'Closed by human disposition' })
    .waitFor();
  await page.reload();
  await page
    .getByRole('heading', { name: 'Closed by human disposition' })
    .waitFor();
  await page.getByText('Live', { exact: true }).waitFor();
  await page
    .locator('.case-progress')
    .screenshot({ path: '/tmp/luma36-timeline.png' });
  expect(new URL(page.url()).pathname).toContain(ids[0]);
  const foreign = randomUUID();
  const denied = await context.request.get(
    `/api/v1/organizations/${foreign}/exceptions/${ids[0]}`,
  );
  expect(denied.status()).toBe(404);
  expect(await denied.text()).not.toContain('scan-0');
  await page.goto(`${inbox}/${randomUUID()}?view=active`);
  await page
    .getByRole('alert')
    .getByText('Issue unavailable', { exact: true })
    .waitFor();
  expect(
    await page.getByRole('article', { name: 'Issue investigation' }).count(),
  ).toBe(0);
  await page.route('**/api/v1/organizations/*/exceptions?**', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 'INTERNAL_ERROR',
        message: 'Read failed',
        requestId: 'test',
      }),
    }),
  );
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page
    .getByText('Inbox could not be refreshed', { exact: true })
    .waitFor();
  await services.diagnoses.run(tenant, ids[1]);
  await page.goto(`/app/${organizationId}/overview`);
  await page.locator('.operations-decisions a').first().waitFor();
  const authoritative = await context.request.get(
    `/api/v1/organizations/${organizationId}/operations/overview`,
  );
  expect(authoritative.status()).toBe(200);
  const summary = await authoritative.json();
  expect(
    await page.locator('.operations-metrics strong').first().textContent(),
  ).toBe(String(summary.attentionCount));
  expect(
    await page.locator('.operations-decisions a').first().getAttribute('href'),
  ).toContain(summary.prioritizedDecisions[0].id);
  await page.unroute('**/api/v1/organizations/*/exceptions?**');
  await page.locator('.operations-decisions a').first().click();
  await page.getByRole('article', { name: 'Issue investigation' }).waitFor();
  expect(new URL(page.url()).searchParams.get('view')).toBe('needs_you');
  await page.goto(`/app/${organizationId}/overview`);
  await page.locator('.operations-decisions a').first().waitFor();
  await page.route(
    '**/api/v1/organizations/*/operations/overview?**',
    (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: '{}',
      }),
  );
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page
    .getByText('Operations overview unavailable', { exact: true })
    .waitFor();
  expect(await page.locator('.operations-metrics').count()).toBe(0);
  await page.unroute('**/api/v1/organizations/*/operations/overview?**');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.locator('.operations-decisions a').first().waitFor();
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page
    .getByText('Updates paused while offline', { exact: true })
    .waitFor();
  expect(await page.locator('.operations-metrics').count()).toBe(0);
  expect(
    await page
      .getByRole('button', { name: 'Refresh', exact: true })
      .isDisabled(),
  ).toBe(true);
  await context.setOffline(false);
  await page.locator('.operations-decisions a').first().waitFor();
  await page.screenshot({
    path: '/tmp/luma33-overview-desktop.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: '/tmp/luma33-overview-mobile.png',
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

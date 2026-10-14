/* global document, innerWidth, window */
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

test('reads persisted cases, restores desktop/mobile routes and focus, and denies other tenants', async ({
  resources: t,
}) => {
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
  const context = await t.newContext({
    baseURL: origin,
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/sign-up');
  await page.getByRole('radio', { name: /Australia/ }).check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
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
  await page.getByRole('heading', { name: 'Needs your attention' }).waitFor();
  const organizationId = new URL(page.url()).pathname.split('/')[2];
  await page
    .getByRole('heading', { name: 'Connect your first system.' })
    .waitFor();
  await page.getByRole('heading', { name: 'Luma is handling' }).waitFor();
  await page.getByRole('combobox', { name: 'Time period' }).click();
  await page.getByRole('option', { name: 'Last 7 days', exact: true }).click();
  await page.waitForURL('**/home?window=7d');
  await page.reload();
  await page
    .getByRole('combobox', { name: 'Time period' })
    .getByText('Last 7 days', { exact: true })
    .waitFor();
  const overviewDenied = await context.request.get(
    `/api/v1/organizations/${randomUUID()}/operations/overview`,
  );
  expect(overviewDenied.status()).toBe(404);
  const anonymous = await t.newContext({ baseURL: origin });
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
  await page.getByText('No issues need your review', { exact: true }).waitFor();
  await page.getByText('No data received yet', { exact: true }).waitFor();
  await page.getByText('No active connections', { exact: true }).waitFor();
  await page.keyboard.press('Control+k');
  await page.getByRole('dialog', { name: 'Go to a page' }).waitFor();
  await page.getByRole('textbox', { name: 'Search workspace' }).fill('issue');
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
      dataRegion: 'AU',
      status: 'active',
    },
    builtInMembership(
      { id: randomUUID(), organizationId, userId: actorId },
      'owner',
    ),
    randomUUID(),
  );
  const corpus = JSON.parse(
    await readFile(
      new URL(
        '../../../packages/exceptions/fixtures/exceptions-v0.json',
        import.meta.url,
      ),
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
  await page.getByRole('tab', { name: 'All open', exact: true }).click();
  const issueRows = page
    .getByRole('list', { name: 'Issues', exact: true })
    .getByRole('listitem');
  await issueRows.first().waitFor();
  expect(await issueRows.count()).toBe(25);
  await page.getByText('Page 1 of 2', { exact: true }).waitFor();
  await page.getByText('1–25 of 27 issues', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect.poll(() => issueRows.count()).toBe(2);
  await page.getByText('Page 2 of 2', { exact: true }).waitFor();
  await page.getByText('26–27 of 27 issues', { exact: true }).waitFor();
  // The page and the way back survive a reload.
  await page.reload();
  await page.getByText('Page 2 of 2', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Previous', exact: true }).click();
  await page.getByText('Page 1 of 2', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Previous', exact: true }).click();
  // Search finds a record without entering the address; the owner pill writes a condition.
  const searched = await (
    await context.request.get(
      `/api/v1/organizations/${organizationId}/exceptions/${ids[3]}`,
    )
  ).json();
  const search = page.getByRole('searchbox', { name: 'Search issues' });
  await search.fill(searched.subject.id);
  await expect.poll(() => issueRows.count()).toBe(1);
  await page.locator(`#case-${ids[3]}`).waitFor();
  expect(new URL(page.url()).searchParams.has('q')).toBe(false);
  await search.fill('');
  await expect.poll(() => issueRows.count()).toBe(25);
  await page
    .getByRole('button', { name: 'Add Case owner filter', exact: true })
    .click();
  await page.getByRole('button', { name: 'Unassigned', exact: true }).click();
  await page
    .getByRole('button', {
      name: 'Edit Case owner filter: Unassigned',
      exact: true,
    })
    .waitFor();
  expect(new URL(page.url()).searchParams.get('where')).toContain('empty');
  await page.getByText('1–25 of 27 issues', { exact: true }).waitFor();
  await page
    .getByRole('button', {
      name: 'Remove Case owner filter: Unassigned',
      exact: true,
    })
    .click();
  await page
    .getByRole('button', { name: 'Add Issue type filter', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Connection issue', exact: true })
    .click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  const issueTypeFilter = page.getByRole('button', {
    name: 'Edit Issue type filter: Connection issue',
    exact: true,
  });
  await issueTypeFilter.waitFor();
  const detailPane = page.getByRole('region', { name: 'Selected issue' });
  const issueSection = (name) =>
    detailPane.getByRole('region', { name, exact: true });
  // Inspector sections other than Overview and Findings start collapsed.
  const expandSection = async (name) => {
    const disclosure = issueSection(name).locator('details').first();
    if ((await disclosure.getAttribute('open')) === null)
      await disclosure.locator('summary').first().click();
  };
  const row = page.locator(`#case-${ids[0]}`);
  await row.click();
  await detailPane
    .getByText('Investigation in progress', { exact: true })
    .waitFor();
  await expect
    .poll(() => detailPane.evaluate((el) => el === document.activeElement))
    .toBe(true);
  await page.reload();
  await detailPane
    .getByText('Investigation in progress', { exact: true })
    .waitFor();
  await issueTypeFilter.waitFor();
  expect(await row.isVisible()).toBe(true);
  await expandSection('Change and outcome check');
  await detailPane
    .getByRole('combobox', { name: 'Assignee', exact: true })
    .click();
  await page.getByRole('option').filter({ hasText: 'Ada' }).first().click();
  await expect(
    detailPane.getByText('Case owner: Ada', { exact: true }),
  ).toBeVisible();
  const ownerApi = `/api/v1/organizations/${organizationId}/exceptions/${ids[0]}/owner`;
  const owned = await (
    await context.request.get(
      `/api/v1/organizations/${organizationId}/exceptions/${ids[0]}`,
    )
  ).json();
  expect(owned.owner).toMatchObject({ revision: 1, name: 'Ada' });
  const staleOwner = await context.request.post(ownerApi, {
    headers: { origin },
    data: { userId: null, revision: 0 },
  });
  expect(staleOwner.status()).toBe(409);
  await detailPane
    .getByRole('button', { name: 'Clear owner', exact: true })
    .click();
  await expect(
    detailPane.getByText('Case owner: Unassigned', { exact: true }),
  ).toBeVisible();

  await page.getByText('Live updates', { exact: true }).waitFor();
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
  const refreshIssue = page.getByRole('button', {
    name: 'Refresh issue',
    exact: true,
  });
  // The inspector records the issue state in the Change details metadata.
  const caseState = issueSection('Change and outcome check').locator(
    'dt:text-is("Issue state") + dd',
  );
  for (const [state, label] of [
    ['awaiting_approval', 'Needs approval'],
    ['executing', 'Sending change'],
    ['verifying', 'Checking outcome'],
    ['resolved', 'Resolved'],
    ['failed', 'Change failed'],
    ['escalated', 'Escalated'],
  ]) {
    snapshotState = state;
    await refreshIssue.click();
    await expect.poll(() => caseState.textContent()).toBe(label);
    if (state === 'verifying') {
      expect(await page.getByText('Accepted', { exact: true }).count()).toBe(1);
      expect(
        await page
          .getByText('Confirmed by a fresh check', { exact: true })
          .count(),
      ).toBe(0);
    }
    if (state === 'resolved')
      await page
        .getByText('Confirmed by a fresh check', { exact: true })
        .waitFor();
    expect(await page.getByRole('button', { name: /retry/i }).count()).toBe(0);
  }
  await page.unroute(`**${caseApi}`);
  await page.unroute(`**${caseApi}/progress`);
  await refreshIssue.click();
  await expect
    .poll(() => caseState.textContent())
    .toBe(
      baselineProgress.state
        .replaceAll('_', ' ')
        .replace(/^./, (c) => c.toUpperCase()),
    );
  await page.getByText('Live updates', { exact: true }).waitFor();
  const recordedTimeline = await (
    await context.request.get(`${caseApi}/timeline?limit=100`)
  ).json();
  const slowEvent = {
    id: randomUUID(),
    type: 'review.slow_refresh_completed',
    occurredAt: baseline.detectedAt,
    actor: {
      kind: 'unrecorded',
      id: null,
      name: null,
      email: null,
      workflow: null,
    },
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
  await issueSection('Overview')
    .getByText('Steps and checks', { exact: true })
    .click();
  const recommendationSteps = issueSection('Overview').getByRole('listitem');
  const recommendations = await recommendationSteps.allTextContents();
  expect(recommendations.length).toBeGreaterThan(0);
  // The request spans a second SSE heartbeat. It must finish without being cancelled.
  await page.waitForRequest((request) =>
    request.url().includes(`${caseApi}/timeline?`),
  );
  // History refreshes independently; current case observation stays live.
  await expect(page.getByText('Live updates', { exact: true })).toBeVisible();
  expect(await recommendationSteps.allTextContents()).toEqual(recommendations);
  expect(
    await page.getByText('Evidence is out of date', { exact: true }).count(),
  ).toBe(0);
  await expandSection('History');
  // The trigger without a count appears once the slow page reports older history.
  await page
    .getByRole('button', { name: 'View full history', exact: true })
    .click();
  const auditHistory = page.getByRole('region', {
    name: 'History',
    exact: true,
  });
  await auditHistory
    .getByText('Review slow refresh completed', { exact: true })
    .waitFor();
  slowRefresh = false;
  const auditDetails = auditHistory.locator('details').first();
  await auditDetails.locator('summary').click();
  await auditDetails.evaluate((element) => {
    element.dataset.retained = 'true';
  });
  await Promise.all([
    page.waitForRequest((request) =>
      request.url().includes('cursor=review-page-2'),
    ),
    auditHistory
      .getByRole('button', { name: 'Load older events', exact: true })
      .click(),
  ]);
  expect(await auditDetails.getAttribute('open')).not.toBeNull();
  expect(await auditDetails.getAttribute('data-retained')).toBe('true');
  expect(await page.getByLabel('Loading issues').count()).toBe(0);
  releasePage();
  await auditHistory
    .getByText('Review history page loaded', { exact: true })
    .waitFor();
  expect(await auditDetails.getAttribute('data-retained')).toBe('true');
  await page.unroute(`**${caseApi}/timeline?**`);
  await page
    .getByRole('button', { name: 'Back to issue', exact: true })
    .click();
  await issueSection('Findings')
    .getByRole('button', { name: 'View supporting evidence', exact: true })
    .click();
  const evidence = page
    .getByRole('region', { name: 'Supporting evidence' })
    .locator('summary')
    .first();
  await evidence.focus();
  await page.keyboard.press('Enter');
  await expect
    .poll(() =>
      evidence.evaluate((el) => el.parentElement.hasAttribute('open')),
    )
    .toBe(true);
  await page
    .getByRole('button', { name: 'Back to issue', exact: true })
    .click();
  await detailPane.evaluate((el) => {
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
  await expandSection('Issue details');
  await page
    .getByRole('button', { name: 'Copy issue ID', exact: true })
    .click();
  await page.getByText('Issue ID copied', { exact: true }).waitFor();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    ids[0],
  );
  expect(
    await issueSection('Issue details')
      .getByText(ids[0], { exact: true })
      .isVisible(),
  ).toBe(true);
  await issueSection('Issue details').locator('summary').first().click();
  await detailPane.evaluate((el) => {
    el.scrollTop = 0;
  });
  const inspectorHeader = detailPane.locator('.issue-inspector-header');
  const headerTop = await inspectorHeader.evaluate(
    (el) => el.getBoundingClientRect().top,
  );
  await detailPane.evaluate((el) => {
    el.scrollTop = 500;
  });
  expect(
    await inspectorHeader.evaluate((el) => el.getBoundingClientRect().top),
  ).toBe(headerTop);
  expect(await inspectorHeader.getByRole('heading').isVisible()).toBe(true);
  // The compact header shows status and severity; issue type and subject moved to the sections.
  expect(await inspectorHeader.locator('.lu-state-pill').isVisible()).toBe(
    true,
  );
  expect(await inspectorHeader.getByText('High severity').isVisible()).toBe(
    true,
  );
  await detailPane.evaluate((el) => {
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
  await refreshIssue.click();
  await page.getByRole('button', { name: 'Close panel' }).click();
  const issueInbox = page.getByLabel('Issue inbox', { exact: true });
  // The completed diagnosis moved this row beyond page one; focus falls back to the inbox.
  await expect
    .poll(() => issueInbox.evaluate((el) => el === document.activeElement))
    .toBe(true);
  const stableRow = page.locator(`#case-${ids[10]}`);
  await stableRow.scrollIntoViewIfNeeded();
  const scroll = await issueInbox.evaluate((el) => el.scrollTop);
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
  expect(await issueInbox.evaluate((el) => el.scrollTop)).toBe(scroll);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${inbox}/${ids[0]}?view=active&class=sync_failure`);
  await page
    .getByRole('heading', {
      name: 'The connection read needs investigation',
      exact: true,
    })
    .waitFor();
  await page.getByRole('tab', { name: 'Needs review', exact: true }).click();
  await page
    .getByRole('heading', {
      name: 'The connection read needs investigation',
      exact: true,
    })
    .waitFor();
  await expandSection('History');
  const recordedEvents = issueSection('History').getByText(/^\d+\+? events?$/);
  const eventCount = await recordedEvents.textContent();
  await issueSection('History')
    .getByRole('button', { name: 'Refresh history', exact: true })
    .click();
  await expect.poll(() => recordedEvents.textContent()).toBe(eventCount);
  await expandSection('Change and outcome check');
  await page.getByText('Live updates', { exact: true }).waitFor();
  // An offline notification can precede the transport's error event.
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.getByText('Connection lost', { exact: true }).waitFor();
  await page
    .getByText('Current state not confirmed', { exact: true })
    .waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.getByText('Live updates', { exact: true }).waitFor();
  await context.setOffline(true);
  await page.getByText('Connection lost', { exact: true }).waitFor();
  await page
    .getByText('Current state not confirmed', { exact: true })
    .waitFor();
  await context.setOffline(false);
  await page.getByText('Live updates', { exact: true }).waitFor();
  await expandSection('Proposed change');
  await page.getByRole('button', { name: 'Close issue', exact: true }).click();
  const closeDialog = page.getByRole('dialog', {
    name: 'Close issue',
    exact: true,
  });
  await expect(
    closeDialog.getByRole('button', { name: 'Close issue', exact: true }),
  ).toBeDisabled();
  await closeDialog
    .getByLabel('Reason for closing (required)')
    .fill('Handled by operator');
  const running = closeDialog.getByRole('checkbox');
  if (await running.count()) await running.check();
  await closeDialog
    .getByRole('button', { name: 'Close issue', exact: true })
    .click();
  await expect(closeDialog).not.toBeVisible();
  const refreshIssues = page.getByRole('button', {
    name: 'Refresh issues',
    exact: true,
  });
  await refreshIssues.click();
  await page
    .getByText('This issue has left the current view', { exact: true })
    .waitFor();
  const closedProgress = await (
    await page.request.get(`${caseApi}/progress`)
  ).json();
  const signedInSession = await (
    await page.request.get('/api/auth/get-session')
  ).json();
  expect(closedProgress.resolution).toMatchObject({
    kind: 'human_disposition',
    reason: 'Handled by operator',
    actorId: signedInSession.user.id,
  });
  // The resolution record names who closed the issue.
  const humanClosure = issueSection('Change and outcome check')
    .getByRole('heading', { name: 'Closed manually' })
    .last();
  await humanClosure.waitFor();
  await page.reload();
  await expandSection('Change and outcome check');
  await humanClosure.waitFor();
  await page.getByText('Live updates', { exact: true }).waitFor();
  await page
    .getByRole('region', { name: 'Change, history and evidence' })
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
  await refreshIssues.click();
  await page
    .getByText('The list couldn’t be refreshed', { exact: false })
    .waitFor();
  await services.diagnoses.run(tenant, ids[1]);
  await page.goto(`/app/${organizationId}/home`);
  const decisions = page
    .getByRole('region', { name: 'Needs your attention' })
    .getByRole('list')
    .getByRole('link');
  // Handling totals come from the operations overview and disappear when it is unavailable.
  const handlingTotals = page
    .getByRole('region', { name: 'Luma is handling' })
    .getByRole('term');
  await decisions.first().waitFor();
  // Home's decisions come from the Needs you queue, in the same order.
  const authoritative = await context.request.get(
    `/api/v1/organizations/${organizationId}/decisions?limit=5`,
  );
  expect(authoritative.status()).toBe(200);
  const summary = await authoritative.json();
  // Apps that aren't installed have no decisions; they are not unavailable sources.
  expect(summary.sources.every((source) => source.state === 'available')).toBe(
    true,
  );
  await decisions
    .first()
    .getByText(summary.items[0].title, { exact: true })
    .waitFor();
  expect(
    await page
      .getByText('so some decisions may be missing', { exact: false })
      .count(),
  ).toBe(0);
  expect(await decisions.first().getAttribute('href')).toContain(
    summary.items[0].owner.exceptionId,
  );
  await page.unroute('**/api/v1/organizations/*/exceptions?**');
  await decisions.first().click();
  await page
    .getByRole('region', { name: 'Selected decision' })
    .getByRole('heading', { name: summary.items[0].title })
    .waitFor();
  expect(new URL(page.url()).searchParams.get('item')).toBe(
    summary.items[0].id,
  );
  await page.goto(`/app/${organizationId}/home`);
  await decisions.first().waitFor();
  expect(await handlingTotals.count()).toBeGreaterThan(0);
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
  expect(await handlingTotals.count()).toBe(0);
  await page.unroute('**/api/v1/organizations/*/operations/overview?**');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await decisions.first().waitFor();
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page
    .getByText('Updates paused while offline', { exact: true })
    .waitFor();
  expect(await handlingTotals.count()).toBe(0);
  expect(
    await page
      .getByRole('button', { name: 'Refresh', exact: true })
      .isDisabled(),
  ).toBe(true);
  await context.setOffline(false);
  await decisions.first().waitFor();
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

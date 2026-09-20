/* global document, innerWidth */
import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { database, startApi, startProcess, availablePort } from './helpers.mjs';
import { createDetectionServices } from '../dist/app.js';
import { makeTenantContext } from '../dist/modules/identity/composition.js';
import { defaultConfiguration } from '../dist/modules/exceptions/index.js';
import { readFile } from 'node:fs/promises';

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
  await page.getByRole('heading', { name: 'Room to focus.' }).waitFor();
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
  await page.getByText('Nothing needs you.', { exact: true }).waitFor();
  await page.getByText('No observations yet', { exact: true }).waitFor();
  await page.getByText('No active connections', { exact: true }).waitFor();
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
  await page.getByRole('link', { name: 'Active', exact: true }).click();
  await page.locator('.inbox-rows li').first().waitFor();
  expect(await page.locator('.inbox-rows li').count()).toBe(25);
  await page.getByRole('link', { name: 'Next page →' }).click();
  await expect.poll(() => page.locator('.inbox-rows li').count()).toBe(2);
  await page.getByRole('link', { name: 'First page' }).click();
  await page.getByLabel('Class', { exact: true }).selectOption('sync_failure');
  const row = page.locator(`#case-${ids[0]}`);
  await row.click();
  await page.getByText('Investigation pending', { exact: true }).waitFor();
  await expect
    .poll(() =>
      page
        .locator('.inbox-detail')
        .evaluate((el) => el === document.activeElement),
    )
    .toBe(true);
  await page.reload();
  await page.getByText('Investigation pending', { exact: true }).waitFor();
  expect(await page.getByLabel('Class', { exact: true }).inputValue()).toBe(
    'sync_failure',
  );
  expect(await row.isVisible()).toBe(true);
  await page.getByText('Live', { exact: true }).waitFor();
  await services.diagnoses.run(tenant, ids[0]);
  // The credentialed stream refreshes the completed investigation without a click.
  await page
    .getByRole('heading', {
      name: 'The connection read needs investigation.',
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
  await page.screenshot({ path: '/tmp/luma-21-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await row.isVisible()).toBe(false);
  await page.screenshot({ path: '/tmp/luma-21-mobile.png', fullPage: true });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole('button', { name: 'Refresh case', exact: true }).click();
  await page.getByRole('link', { name: '← Back to inbox' }).click();
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
      name: 'The connection read needs investigation.',
      exact: true,
    })
    .waitFor();
  await page.getByRole('link', { name: 'Needs you', exact: true }).click();
  await page
    .getByRole('heading', {
      name: 'The connection read needs investigation.',
      exact: true,
    })
    .waitFor();
  const audit = page.locator('.case-audit > li');
  const eventCount = await audit.count();
  await page.getByRole('button', { name: 'Refresh progress' }).click();
  await expect.poll(() => audit.count()).toBe(eventCount);
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
    .getByText('This case has left the current view', { exact: true })
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
  await page.getByText('Case unavailable', { exact: true }).waitFor();
  expect(
    await page.getByRole('article', { name: 'Case investigation' }).count(),
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
  await page.getByRole('article', { name: 'Case investigation' }).waitFor();
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

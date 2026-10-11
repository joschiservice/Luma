/* global document, innerWidth, window */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { createDetectionServices } from '@luma/application-runtime';
import { defaultConfiguration } from '@luma/exceptions';
import {
  builtInMembership,
  makeTenantContext,
} from '@luma/identity/composition';

import { inventoryCase } from '../../../packages/ui/src/components/issues/case-fixtures.ts';
import {
  resolutionProgress,
  resolutionReview,
} from '../../../packages/ui/src/components/issues/resolution-fixtures.ts';
import { expect, test } from './browser-fixtures.mjs';
import { availablePort, database, startApi, startProcess } from './helpers.mjs';

test('reviews decisions, recovers ambiguous commands and escalates through the connected API', async ({
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
  await page.getByLabel('Name', { exact: true }).fill('Ada');
  await page
    .getByLabel('Email', { exact: true })
    .fill('resolution@example.test');
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
  const inbox = `/app/${organizationId}/exceptions`;
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
  for (let i = 0; i < 1; i++) {
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
  const exceptionId = ids[0];
  const path = `/api/v1/organizations/${organizationId}/exceptions/${exceptionId}`;
  const detailUrl = `${inbox}/${exceptionId}?view=active`;
  let review = structuredClone(resolutionReview);
  let progress = structuredClone(resolutionProgress);
  let posts = [];
  let mode = 'pending';
  let release;
  let receipt;
  let receiptReady = false;
  let holdReview = false;
  const reviewReleases = [];
  const json = (route, body, status = 200) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  let diagnosisOffset = 0;
  let historyFailure = false;
  await page.route(`**${path}`, (route) =>
    json(route, {
      ...inventoryCase,
      id: exceptionId,
      revision: progress.caseRevision,
      state: progress.state,
      diagnosis: {
        ...inventoryCase.diagnosis,
        exceptionId,
        revision: progress.diagnosisRevision + diagnosisOffset,
      },
    }),
  );
  await page.route(`**${path}/timeline?*`, (route) =>
    historyFailure
      ? json(route, { message: 'Unavailable' }, 503)
      : route.continue(),
  );
  await page.route(`**${path}/review`, async (route) => {
    if (holdReview)
      await new Promise((resolve) => {
        reviewReleases.push(resolve);
      });

    return json(route, review);
  });
  await page.route(`**${path}/progress`, (route) => json(route, progress));
  await page.route(`**${path}/decisions/*`, (route) =>
    receiptReady
      ? json(route, receipt)
      : json(
          route,
          { code: 'NOT_FOUND', message: 'Not recorded', requestId: 'test' },
          404,
        ),
  );
  await page.route(`**${path}/decisions`, async (route) => {
    const command = route.request().postDataJSON();
    posts.push(command);
    receipt = {
      id: command.commandId,
      exceptionId,
      kind: command.kind,
      actorId,
      caseRevision: 4,
      approvalId: null,
      reason: command.reason,
      createdAt: new Date().toISOString(),
    };
    if (mode === 'pending')
      await new Promise((resolve) => {
        release = resolve;
      });
    if (mode === 'ambiguous') return route.abort('failed');
    if (mode === 'conflict') {
      review = { ...review, caseRevision: 5, permittedDecisions: ['escalate'] };
      progress = { ...progress, caseRevision: 5 };

      return json(
        route,
        { code: 'CONFLICT', message: 'Replaced', requestId: 'test' },
        409,
      );
    }
    if (mode === 'forbidden' || mode === 'expired') {
      review = { ...review, permittedDecisions: [] };

      return json(
        route,
        { code: 'FORBIDDEN', message: 'Access changed', requestId: 'test' },
        mode === 'expired' ? 401 : 403,
      );
    }
    review = { ...review, permittedDecisions: [] };

    return json(route, receipt);
  });
  // Inspector sections other than Findings start collapsed on every mount.
  const openSection = async (name) => {
    const section = page.getByRole('region', { name, exact: true });
    const open = await section
      .locator('details')
      .first()
      .evaluate((details) => details.open);
    if (!open) await section.locator('summary').first().click();
  };
  const execution = page.getByRole('region', {
    name: 'Change and outcome check',
    exact: true,
  });
  await page.goto(detailUrl);
  await openSection('Proposed change');
  await page.getByText('Approval needed', { exact: true }).waitFor();
  const approve = page.getByRole('button', {
    name: 'Approve change',
    exact: true,
  });
  expect(await approve.isDisabled()).toBe(true);
  await page
    .getByLabel('Reason for your decision (required)')
    .fill('Reviewed source order');
  await expect.poll(() => approve.isEnabled()).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.getByText('You’re offline', { exact: true }).waitFor();
  expect(await approve.isDisabled()).toBe(true);
  expect(
    await page.getByLabel('Reason for your decision (required)').inputValue(),
  ).toBe('Reviewed source order');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => approve.isEnabled()).toBe(true);

  // Connectivity must recover even when the selected case is closed while offline.
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.getByRole('button', { name: 'Close panel', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.locator(`#case-${exceptionId}`).click();
  await openSection('Proposed change');
  await page
    .getByLabel('Reason for your decision (required)')
    .fill('Reviewed source order');
  await expect.poll(() => approve.isEnabled()).toBe(true);

  // An interrupted stream still permits decisions after successful authenticated reads.
  await page.route(`**${path}/events`, (route) => route.abort('failed'));
  await page
    .getByRole('button', { name: 'Refresh issue', exact: true })
    .click();
  await openSection('Change and outcome check');
  await page.getByText('Live updates interrupted', { exact: true }).waitFor();
  await expect.poll(() => approve.isEnabled()).toBe(true);
  await page.screenshot({
    path: '/tmp/luma-observation-stream.png',
    fullPage: true,
  });

  await page.route(
    `**/api/v1/organizations/${organizationId}/exceptions?*`,
    (route) => json(route, { message: 'Unavailable' }, 503),
  );
  await page
    .getByRole('button', { name: 'Refresh issues', exact: true })
    .click();
  await page
    .getByText('Issues couldn’t be refreshed', { exact: true })
    .waitFor();
  await expect.poll(() => approve.isEnabled()).toBe(true);
  await page.unroute(`**/api/v1/organizations/${organizationId}/exceptions?*`);

  historyFailure = true;
  await page
    .getByRole('button', { name: 'Refresh issues', exact: true })
    .click();
  await openSection('Evidence');
  await page
    .getByText('History couldn’t be refreshed', { exact: true })
    .waitFor();
  await expect.poll(() => approve.isEnabled()).toBe(true);
  await page.screenshot({
    path: '/tmp/luma-observation-history.png',
    fullPage: true,
  });
  historyFailure = false;
  await page
    .getByRole('button', { name: 'Retry history', exact: true })
    .click();
  await expect
    .poll(() =>
      page.getByText('History couldn’t be refreshed', { exact: true }).count(),
    )
    .toBe(0);

  diagnosisOffset = 1;
  await page
    .getByRole('button', { name: 'Refresh issues', exact: true })
    .click();
  await page
    .getByText('Resolution review unavailable', { exact: true })
    .waitFor();
  expect(await approve.isDisabled()).toBe(true);
  diagnosisOffset = 0;
  await page
    .getByRole('button', { name: 'Refresh issues', exact: true })
    .click();
  await expect.poll(() => approve.isEnabled()).toBe(true);
  expect(
    await page.getByLabel('Reason for your decision (required)').inputValue(),
  ).toBe('Reviewed source order');
  // Exercise real background polling while the operator continues typing.
  const reason = page.getByLabel('Reason for your decision (required)');
  await reason.focus();
  const reevaluatedDecisionId = randomUUID();
  review = {
    ...review,
    caseRevision: 5,
    proposal: {
      ...review.proposal,
      policy: {
        ...review.proposal.policy,
        id: reevaluatedDecisionId,
        evaluatedAt: new Date().toISOString(),
      },
    },
  };
  progress = { ...progress, caseRevision: 5 };
  holdReview = true;
  await expect
    .poll(() => reviewReleases.length > 0, { timeout: 15_000 })
    .toBe(true);
  expect(await reason.isEnabled()).toBe(true);
  expect(await reason.evaluate((el) => el === document.activeElement)).toBe(
    true,
  );
  expect(await approve.isDisabled()).toBe(true);
  await page.keyboard.type(' and risk');
  holdReview = false;
  for (const releaseReview of reviewReleases) releaseReview();
  await expect.poll(() => approve.isEnabled()).toBe(true);
  expect(await reason.inputValue()).toBe('Reviewed source order and risk');
  expect(await reason.evaluate((el) => el === document.activeElement)).toBe(
    true,
  );
  await approve.click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0].decisionId).toBe(reevaluatedDecisionId);
  expect(posts[0].caseRevision).toBe(5);
  expect(posts[0].reason).toBe('Reviewed source order and risk');
  expect(await approve.isDisabled()).toBe(true);
  expect(
    await page
      .getByRole('button', { name: 'Reject change', exact: true })
      .isDisabled(),
  ).toBe(true);
  release();
  await page.getByText('Approval recorded', { exact: true }).waitFor();
  await openSection('Change and outcome check');
  expect(
    await execution
      .getByText(
        'The change needs approval before Luma sends it. Nothing has been sent yet.',
        { exact: true },
      )
      .isVisible(),
  ).toBe(true);
  expect(
    await page.getByText('Resolved and confirmed', { exact: true }).count(),
  ).toBe(0);
  review = structuredClone(resolutionReview);
  progress = structuredClone(resolutionProgress);
  await page.reload();
  await openSection('Proposed change');
  await page
    .getByLabel('Reason for your decision (required)')
    .fill('Reason for old proposal');
  review = {
    ...review,
    caseRevision: 5,
    proposal: { ...review.proposal, version: 2 },
  };
  progress = { ...progress, caseRevision: 5 };
  await page
    .getByRole('button', { name: 'Refresh issues', exact: true })
    .click();
  await expect
    .poll(() =>
      page.getByLabel('Reason for your decision (required)').inputValue(),
    )
    .toBe('');
  expect(await approve.isDisabled()).toBe(true);
  await reason.fill('Reason before policy change');
  review = {
    ...review,
    proposal: {
      ...review.proposal,
      policy: {
        ...review.proposal.policy,
        reason: 'An additional risk needs operator review.',
      },
    },
  };
  await page
    .getByRole('button', { name: 'Refresh issues', exact: true })
    .click();
  await expect.poll(() => reason.inputValue()).toBe('');
  for (const [scenario, kind, message] of [
    ['success', 'Reject change', 'Rejection recorded'],
    [
      'conflict',
      'Approve change',
      'The proposal or issue changed. Review the current state before deciding again.',
    ],
    [
      'forbidden',
      'Approve change',
      'You no longer have permission to make this decision.',
    ],
    [
      'expired',
      'Approve change',
      'Your session expired. Sign in again to review this issue.',
    ],
  ]) {
    mode = scenario;
    review = structuredClone(resolutionReview);
    progress = structuredClone(resolutionProgress);
    await page.reload();
    await openSection('Proposed change');
    await page
      .getByLabel('Reason for your decision (required)')
      .fill('Checked current evidence');
    await page.getByRole('button', { name: kind, exact: true }).click();
    await page.getByText(message, { exact: true }).waitFor();
    await expect.poll(() => approve.count()).toBe(0);
  }
  mode = 'ambiguous';
  review = structuredClone(resolutionReview);
  progress = structuredClone(resolutionProgress);
  await page.reload();
  await openSection('Proposed change');
  await page
    .getByLabel('Reason for your decision (required)')
    .fill('Checked again');
  await approve.click();
  await page
    .getByRole('button', { name: 'Check if it was recorded' })
    .waitFor();
  const original = posts.at(-1);
  await page.getByRole('button', { name: 'Send same decision again' }).click();
  await expect
    .poll(() => posts.filter((p) => p.commandId === original.commandId).length)
    .toBe(2);
  expect(posts.at(-1)).toEqual(original);
  receiptReady = true;
  review = { ...review, permittedDecisions: [] };
  await page.getByRole('button', { name: 'Check if it was recorded' }).click();
  await page.getByText('Approval recorded', { exact: true }).waitFor();
  await expect
    .poll(() =>
      page.getByRole('button', { name: 'Send same decision again' }).count(),
    )
    .toBe(0);
  await page.screenshot({ path: '/tmp/luma-35-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole('article', { name: 'Proposed change' })
    .scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: '/tmp/luma-35-mobile.png', fullPage: true });
  review = { ...structuredClone(resolutionReview), observeOnly: true };
  progress = structuredClone(resolutionProgress);
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    await page.reload();
    await openSection('Proposed change');
    await page.getByText('Observe-only', { exact: true }).waitFor();
    await expect(
      page.getByText('Would run when writes are enabled.', { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Approve change', exact: true }),
    ).toHaveCount(0);
    await page.screenshot({
      path: `/tmp/luma173-observe-${colorScheme}.png`,
      fullPage: true,
    });
  }
  // Remove only fixture endpoints; the final decision reaches authenticated policy services and PostgreSQL.
  await page.unroute(`**${path}`);
  await page.unroute(`**${path}/events`);
  await page.unroute(`**${path}/timeline?*`);
  await page.unroute(`**${path}/review`);
  await page.unroute(`**${path}/progress`);
  await page.unroute(`**${path}/decisions/*`);
  await page.unroute(`**${path}/decisions`);
  await page.reload();
  await openSection('Proposed change');
  // Without a proposal, escalation is the only decision and opens on request.
  await page
    .getByRole('button', { name: 'Escalate issue', exact: true })
    .click();
  await page
    .getByLabel('Why does this need escalation?')
    .fill('Requires specialist review');
  const responsePromise = page.waitForResponse(
    (r) =>
      r.url().endsWith(`${path}/decisions`) && r.request().method() === 'POST',
  );
  await page
    .getByRole('button', { name: 'Confirm escalation', exact: true })
    .click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const committed = await response.json();
  expect(committed.kind).toBe('escalate');
  const recovered = await context.request.get(
    `${path}/decisions/${committed.id}`,
  );
  expect(await recovered.json()).toEqual(committed);
  await page.getByText('Escalation recorded', { exact: true }).waitFor();
  await page
    .getByRole('button', { name: 'View change progress', exact: true })
    .click();
  await execution.locator('summary', { hasText: 'Change details' }).click();
  await execution.getByText('Escalated', { exact: true }).waitFor();
  expect(errors).toEqual([]);
});

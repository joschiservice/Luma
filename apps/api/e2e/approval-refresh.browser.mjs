import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TestWorkflowEnvironment } from '@temporalio/testing';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';

import { createPilot } from '../../../tooling/pilot/runtime.mjs';
import { seedPilot } from '../../../tooling/pilot/seed.mjs';
import { parseAction } from '../dist/modules/execution/composition.js';
import { availablePort, database, secret, startProcess } from './helpers.mjs';

it('refreshes an expired proposal automatically, preserves the review, and executes one approved change', async (t) => {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const db = await database(t);
  await db.migrate();
  await db.grantRuntime();
  await db.owner.query(
    `GRANT luma_exceptions,luma_connectors TO "${new URL(db.runtimeUrl).username}"`,
  );
  const directory = await mkdtemp(join(tmpdir(), 'luma-approval-browser-'));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const temporal = await TestWorkflowEnvironment.createLocal();
  t.onTestFinished(() => temporal.teardown());
  const env = {
    IDENTITY_DATABASE_URL: db.runtimeUrl,
    WORKFLOW_DATABASE_URL: db.runtimeUrl,
    BETTER_AUTH_SECRET: secret,
    BETTER_AUTH_URL: origin,
    CONNECTIONS_ACTIVE_KEY_ID: 'test',
    CONNECTIONS_KEYS: JSON.stringify({
      test: randomBytes(32).toString('base64'),
    }),
  };
  const saved = { seedPassword: randomUUID() };
  const manifest = await seedPilot(saved, env, directory, 'approval-required');
  const pilot = await createPilot(
    env,
    directory,
    manifest,
    {
      address: temporal.address,
      namespace: 'default',
      taskQueue: `approval-browser-${manifest.runId}`,
      dataRegion: 'EU',
    },
    { proposalFreshnessMs: 65_000 },
  );
  t.onTestFinished(() => pilot.close());
  const actor = await pilot.context();
  const id = manifest.incidents.workflow_failure;
  const diagnosis = await pilot.detection.diagnoses.get(actor, id);
  const expiredAt = new Date(Date.now() - 1000).toISOString();
  const action = {
    schemaVersion: 1,
    id: manifest.proposalId,
    tenantId: actor.tenantId,
    connectionId: manifest.connections.jtl,
    capability: 'orders.shipping-method.write',
    capabilityVersion: '0',
    target: { kind: 'order', id: manifest.subjects.workflow_failure },
    parameters: {},
    preconditions: {
      evidenceRefs: diagnosis.provenance.evidence.map((item) => item.id),
      validUntil: expiredAt,
    },
    expectedPostcondition: { shippingMethodId: '8' },
    risk: 'high',
    proposedBy: { kind: 'user', id: actor.actor.id },
    expiresAt: expiredAt,
  };
  await pilot.desk.publish(actor, id, diagnosis.revision, action);
  const old = { id: action.id };
  await pilot.safety.policies.evaluate(
    actor,
    action,
    parseAction(action).hash,
    { available: true, minimumRisk: 'high' },
  );
  const apiOrigin = await pilot.app.listen({ host: '127.0.0.1', port: 0 });
  const web = startProcess(
    t,
    'e2e/web-server.mjs',
    { TEST_API_ORIGIN: apiOrigin, TEST_WEB_PORT: String(port) },
    true,
  );
  await web.message('listening');
  const browser = await chromium.launch();
  t.onTestFinished(() => browser.close());
  const page = await browser.newPage({
    baseURL: origin,
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/sign-in');
  await page
    .getByLabel('Email', { exact: true })
    .fill('pilot-operator@example.test');
  await page.getByLabel('Password', { exact: true }).fill(saved.seedPassword);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/app/**');
  await page.goto(`/app/${manifest.organizationId}/exceptions/${id}`);
  await page.getByRole('button', { name: 'Approve', exact: true }).waitFor();
  expect(
    (await pilot.desk.review(await pilot.operator(), id)).proposal.id,
  ).not.toBe(old.id);
  expect(
    await page.getByText('Approval window expired', { exact: true }).count(),
  ).toBe(0);
  const reason = page.getByLabel('Decision reason (required)');
  await reason.fill('Apply the checked shipping correction');
  await page.screenshot({
    path: '/tmp/luma-approval-ready.png',
    fullPage: true,
  });
  const providerPath = join(directory, `provider-${manifest.runId}.json`);
  const originalState = await pilot.provider();
  await writeFile(
    providerPath,
    JSON.stringify({
      ...originalState,
      order: { ...originalState.order, shippingMethodId: '9' },
    }),
  );
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page
    .getByText(
      'The shipping method changed. Review the order before choosing another action.',
      { exact: true },
    )
    .waitFor();
  expect(
    (await pilot.desk.review(await pilot.operator(), id)).proposal.approval,
  ).toBeNull();
  expect(await reason.inputValue()).toBe(
    'Apply the checked shipping correction',
  );
  await writeFile(providerPath, JSON.stringify(originalState));
  // A worker renewal must clear the stale error without a manual retry.
  await expect
    .poll(
      async () =>
        Date.parse(
          (await pilot.desk.review(await pilot.operator(), id)).proposal
            .expiresAt,
        ) - Date.now(),
      { timeout: 10_000 },
    )
    .toBeLessThan(60_000);
  await pilot.desk.refresh(await pilot.operator(), id);
  await expect
    .poll(() =>
      page.getByText('Review needs attention', { exact: true }).count(),
    )
    .toBe(0);
  await page.getByRole('button', { name: 'Approve', exact: true }).waitFor();
  expect(await reason.inputValue()).toBe(
    'Apply the checked shipping correction',
  );
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByText('Approval recorded', { exact: true }).first().waitFor();
  const worker = await pilot.runtime.createWorker();
  const running = worker.run();
  t.onTestFinished(async () => {
    worker.shutdown();
    await running;
    await worker.close();
  });
  {
    await expect
      .poll(
        async () =>
          (await pilot.desk.progress(await pilot.operator(), id)).state,
        { timeout: 20_000 },
      )
      .toBe('resolved');
    await page
      .getByText('Recorded verified resolution', { exact: true })
      .first()
      .waitFor();
  }
  expect((await pilot.provider()).patchRequests).toBe(1);
  expect(errors).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByText('Recorded verified resolution', { exact: true })
    .first()
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: '/tmp/luma-approval-mobile.png',
    fullPage: true,
  });
});

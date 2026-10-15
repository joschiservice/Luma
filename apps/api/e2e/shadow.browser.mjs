/* global document, innerWidth */
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
import { seedPlaybooks } from './playbooks-fixture.mjs';

test('evaluates, retries, reloads and reviews a Shadow case through the real API without execution', async ({
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
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/sign-up');
  await page.getByRole('radio', { name: /Australia/ }).check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Ada');
  await page.getByLabel('Email', { exact: true }).fill('shadow@example.test');
  await page
    .getByLabel('Password', { exact: true })
    .fill('browser-test-password-123');
  await page
    .getByRole('button', { name: 'Create account', exact: true })
    .click();
  await page.getByLabel('Workspace name').fill('Shadow studio');
  await page
    .getByRole('button', { name: 'Create workspace', exact: true })
    .click();
  await page.getByRole('heading', { name: 'Needs you' }).waitFor();
  const tenantId = new URL(page.url()).pathname.split('/')[2];
  const { connectionId } = await seedPlaybooks(db, tenantId);
  const userId = (
    await db.owner.query('SELECT user_id FROM memberships WHERE tenant_id=$1', [
      tenantId,
    ])
  ).rows[0].user_id;
  const tenant = makeTenantContext(
    { userId, sessionId: randomUUID() },
    {
      id: tenantId,
      name: 'Shadow studio',
      slug: 'shadow',
      dataRegion: 'AU',
      status: 'active',
    },
    builtInMembership(
      { id: randomUUID(), organizationId: tenantId, userId },
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
  const key = randomUUID();
  const { incident } = await services.exceptions.ingest(tenant, {
    key,
    input: {
      exceptionClass: 'sync_failure',
      facts: {
        ...corpus.bases.sync_failure,
        tenantId,
        evidenceTenantId: tenantId,
        connectionId,
        subjectId: connectionId,
        evidenceRefs: [key],
      },
    },
    configuration: defaultConfiguration,
    evidence: [
      {
        key,
        tenantId,
        connectionId,
        observedAt: new Date().toISOString(),
        sourceUpdatedAt: null,
        adapterVersion: 'fixture-v1',
        schemaVersion: 1,
        source: {
          provider: 'JTL',
          resource: 'Orders',
          externalId: '1042',
          scopeKey: 'orders',
        },
        facts: { errorCode: 'authentication' },
      },
    ],
  });
  await services.diagnoses.run(tenant, incident.id);
  await page.goto(`/app/${tenantId}/exceptions/${incident.id}?view=active`);
  await page
    .getByRole('region', { name: 'Proposed change', exact: true })
    .locator('summary')
    .first()
    .click();
  await page
    .locator('summary')
    .filter({ hasText: 'Test a Workflow on this issue' })
    .click();
  const panel = page.getByRole('region', { name: 'Workflow test' });
  let lost = false;
  const commands = [];
  await page.route('**/exceptions/*/shadow', async (route) => {
    if (route.request().method() === 'POST') {
      commands.push(route.request().postDataJSON());
      if (!lost) {
        lost = true;
        await route.fetch();
        await route.abort('failed');

        return;
      }
    }
    await route.continue();
  });
  await panel.getByRole('button', { name: 'Run test' }).click();
  await panel.getByRole('button', { name: 'Retry test' }).click();
  await panel
    .getByText('Preview only. Nothing was changed.', { exact: true })
    .waitFor();
  expect(commands).toHaveLength(2);
  expect(commands[0]).toEqual(commands[1]);
  await page.reload();
  await page
    .getByRole('region', { name: 'Proposed change', exact: true })
    .locator('summary')
    .first()
    .click();
  await page
    .locator('summary')
    .filter({ hasText: 'Test a Workflow on this issue' })
    .click();
  await panel
    .getByText('The Workflow didn’t prepare a change for this issue.')
    .waitFor();
  for (const name of [
    'Was a change needed?',
    'Should this Workflow handle this issue?',
  ]) {
    await panel.getByRole('combobox', { name }).click();
    await page.getByRole('option', { name: 'Yes', exact: true }).click();
  }
  await panel.getByRole('checkbox').check();
  await panel.getByRole('button', { name: 'Save review' }).click();
  await panel.getByRole('heading', { name: 'Review saved' }).waitFor();
  await page.reload();
  await page
    .getByRole('region', { name: 'Proposed change', exact: true })
    .locator('summary')
    .first()
    .click();
  await page
    .locator('summary')
    .filter({ hasText: 'Test a Workflow on this issue' })
    .click();
  await panel.getByRole('heading', { name: 'Review saved' }).waitFor();
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/luma47-ui-live-case.png' });
  await panel
    .getByRole('link', { name: 'Compare results across issues' })
    .click();
  await page.getByText('1 issue tested', { exact: true }).waitFor();
  await page.locator('#shadow-report').scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/luma47-ui-live-report.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: '/tmp/luma47-ui-live-mobile.png' });
  expect(
    (await db.owner.query('SELECT count(*)::int AS n FROM shadow_evaluations'))
      .rows[0].n,
  ).toBe(1);
  expect(
    (await db.owner.query('SELECT count(*)::int AS n FROM shadow_reviews'))
      .rows[0].n,
  ).toBe(1);
  expect(
    (await db.owner.query('SELECT count(*)::int AS n FROM executed_actions'))
      .rows[0].n,
  ).toBe(0);
  await db.owner.query(
    "UPDATE memberships SET role='member' WHERE tenant_id=$1",
    [tenantId],
  );
  await page.goto(`/app/${tenantId}/exceptions/${incident.id}?view=active`);
  await page
    .getByRole('region', { name: 'Proposed change', exact: true })
    .locator('summary')
    .first()
    .click();
  await page
    .locator('summary')
    .filter({ hasText: 'Test a Workflow on this issue' })
    .click();
  await page
    .getByText(
      'Your role doesn’t allow testing Workflows. Ask a workspace owner or admin for access.',
    )
    .waitFor();
  expect(await page.getByRole('button', { name: 'Run test' }).count()).toBe(0);
  expect(errors).toEqual([]);
});

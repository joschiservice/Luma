/* global document, innerWidth */
import { mkdir } from 'node:fs/promises';

import { shippingMethodPlaybook } from '@luma/resolution';
import { resolutionWorkflow } from '@luma/workflows';
import { compilePlaybook, defineWorkflow } from '@luma/workflows/composition';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';

import { availablePort, database, startApi, startProcess } from './helpers.mjs';

it('starts a scoped native workflow, preserves uncertain retries and cancels a scheduled start on mobile', async (t) => {
  const port = await availablePort(),
    origin = `http://127.0.0.1:${port}`;
  const db = await database(t);
  await db.migrate();
  await db.grantRuntime();
  await db.owner.query(
    `GRANT luma_connectors TO "${new URL(db.runtimeUrl).username}"`,
  );
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
    viewport: { width: 1440, height: 1100 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/sign-up');
  await page.getByLabel('Name', { exact: true }).fill('Ada');
  await page
    .getByLabel('Email', { exact: true })
    .fill('workflows@example.test');
  await page
    .getByLabel('Password', { exact: true })
    .fill('browser-test-password-123');
  await page
    .getByRole('button', { name: 'Create account', exact: true })
    .click();
  await page.getByLabel('Workspace name').fill('Workflow studio');
  await page
    .getByRole('button', { name: 'Create workspace', exact: true })
    .click();
  await page.getByRole('heading', { name: 'Operations overview' }).waitFor();
  const tenantId = new URL(page.url()).pathname.split('/')[2];

  const { digest, format, ...source } = resolutionWorkflow(
    compilePlaybook(shippingMethodPlaybook),
  );
  expect(digest).toBeTruthy();
  expect(format).toBeTruthy();
  const definition = {
    ...source.definition,
    id: 'manual-order-review',
    name: 'Review an order',
    category: 'operations',
  };
  const manual = defineWorkflow({
    ...source,
    definition,
    applicability: { subjectKind: 'order', trigger: { kind: 'manual' } },
  });
  const scheduled = defineWorkflow({
    ...source,
    definition,
    version: '0.2.0',
    applicability: {
      subjectKind: 'order',
      trigger: {
        kind: 'schedule',
        at: new Date(Date.now() + 86_400_000).toISOString(),
      },
    },
  });
  await db.owner.query(
    'INSERT INTO playbook_definitions(tenant_id,id,document) VALUES($1,$2,$3)',
    [tenantId, definition.id, definition],
  );
  for (const version of [manual, scheduled])
    await db.owner.query(
      'INSERT INTO playbook_versions(tenant_id,definition_id,version,digest,document) VALUES($1,$2,$3,$4,$5)',
      [tenantId, definition.id, version.version, version.digest, version],
    );
  await page.goto(`/app/${tenantId}/workflows/${definition.id}`);
  await page.getByRole('combobox', { name: 'Version', exact: true }).click();
  await page.getByRole('option', { name: 'v0.1.0', exact: true }).click();
  const form = page.getByRole('region', { name: 'Trigger', exact: true });
  await form.getByLabel('order ID').fill('order-1042');
  await form.getByLabel('shippingMethodId').fill('standard');
  for (const field of ['diagnosisReady', 'methodMapped']) {
    await form.getByRole('combobox', { name: field }).click();
    await page.getByRole('option', { name: 'True', exact: true }).click();
  }
  await mkdir('/tmp/luma67-browser', { recursive: true });
  await form.scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/luma67-browser/triggers-desktop.png' });
  // Simulate a lost response after the server commits; retry must use the same body.
  let dropped = false;
  await page.route('**/workflows/*/starts', async (route) => {
    if (!dropped) {
      dropped = true;
      await route.fetch();
      await route.abort('failed');
    } else await route.continue();
  });
  await form
    .getByRole('button', { name: 'Start workflow', exact: true })
    .click();
  await form.getByRole('button', { name: 'Retry same request' }).waitFor();
  expect(await form.getByLabel('order ID').isDisabled()).toBe(true);
  await form.getByRole('button', { name: 'Retry same request' }).click();
  await form
    .getByText(
      'Run started. Review its evidence and admission status in Recent runs.',
    )
    .waitFor();
  expect(
    (
      await db.owner.query(
        'SELECT count(*) FROM workflow_trigger_runs WHERE tenant_id=$1',
        [tenantId],
      )
    ).rows[0].count,
  ).toBe('1');
  await page.reload();
  await page
    .getByRole('heading', { name: 'Recent runs', exact: true })
    .waitFor();
  await page
    .getByText(
      'Trigger received. Execution requires a separate activation and admission.',
      { exact: true },
    )
    .first()
    .waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('combobox', { name: 'Workflow sections' }).click();
  await page.getByRole('option', { name: 'Triggers', exact: true }).click();
  await form.getByLabel('order ID').fill('order-2042');
  await form.getByLabel('shippingMethodId').fill('standard');
  for (const field of ['diagnosisReady', 'methodMapped']) {
    await form.getByRole('combobox', { name: field }).click();
    await page.getByRole('option', { name: 'True', exact: true }).click();
  }
  await page.screenshot({ path: '/tmp/luma67-browser/triggers-mobile.png' });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await form
    .getByRole('button', { name: 'Schedule start', exact: true })
    .click();
  await form
    .getByText('Start scheduled. You can cancel it from Recent runs.')
    .waitFor();
  await page
    .getByRole('button', { name: 'Cancel scheduled start', exact: true })
    .click();
  await page
    .getByText('The scheduled start was cancelled.', { exact: true })
    .first()
    .waitFor();
  await page.reload();
  await page
    .getByText('The scheduled start was cancelled.', { exact: true })
    .first()
    .waitFor();
  expect(
    await page
      .getByRole('button', { name: 'Cancel scheduled start', exact: true })
      .count(),
  ).toBe(0);
  expect(errors).toEqual([]);
});

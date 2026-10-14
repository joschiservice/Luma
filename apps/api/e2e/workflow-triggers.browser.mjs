/* global document, innerWidth */
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

import { shippingMethodPlaybook } from '@luma/resolution';
import { resolutionWorkflow } from '@luma/workflows';
import {
  compilePlaybook,
  compileProcessWorkflow,
  defineWorkflow,
} from '@luma/workflows/composition';

import { expect, test } from './browser-fixtures.mjs';
import { availablePort, database, startApi, startProcess } from './helpers.mjs';

test('starts a scoped native workflow, preserves uncertain retries and cancels a scheduled start on mobile', async ({
  resources: t,
}) => {
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
  const context = await t.newContext({
    baseURL: origin,
    viewport: { width: 1440, height: 1100 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/sign-up');
  await page.getByRole('radio', { name: /Australia/ }).check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
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
  await page.getByRole('heading', { name: 'Needs your attention' }).waitFor();
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
    .getByText('Run started. Follow its progress and approvals in Recent runs.')
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
  await page.getByRole('option', { name: 'Rules', exact: true }).click();
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

  const process = compileProcessWorkflow({
    schemaVersion: 2,
    definition: {
      id: 'inventory-check',
      name: 'Inventory check',
      intent: 'Review current stock before continuing.',
      category: 'operations',
    },
    version: '1.0.0',
    applicability: { trigger: { kind: 'manual' }, subjectKind: 'order' },
    inputs: {},
    context: {
      kind: 'inventory',
      fields: { ready: 'boolean' },
      maxAgeSeconds: 300,
    },
    steps: [
      {
        id: 'refresh',
        kind: 'read',
        source: 'inventory',
        fields: { ready: 'boolean' },
      },
      {
        id: 'check',
        kind: 'condition',
        field: 'ready',
        equals: true,
        onFalse: 'escalate',
      },
      { id: 'finish', kind: 'end', outcome: 'Stock reviewed' },
    ],
    provenance: {
      kind: 'resolution',
      reference: 'browser-fixture',
      authoredBy: 'operator',
      evidenceRefs: ['inventory'],
    },
  });
  const processId = randomUUID();
  const timestamp = new Date().toISOString();
  const run = {
    id: processId,
    tenantId,
    definitionId: process.definition.id,
    version: process.version,
    versionDigest: process.digest,
    activationId: null,
    artifactDigest: null,
    trigger: { kind: 'manual' },
    subject: { kind: 'order', id: 'order-1042' },
    actor: {
      kind: 'user',
      id: (
        await db.owner.query(
          'SELECT user_id FROM memberships WHERE tenant_id=$1',
          [tenantId],
        )
      ).rows[0].user_id,
    },
    context: {
      inputs: {},
      evidence: {
        kind: 'inventory',
        facts: { ready: true },
        observations: [
          { id: randomUUID(), observedAt: timestamp, source: 'inventory' },
        ],
      },
      provenance: { reference: 'inventory', capturedAt: timestamp },
    },
    contextDigest: 'a'.repeat(64),
    evidence: { sourceId: 'inventory-check', occurredAt: timestamp },
    requestDigest: 'b'.repeat(64),
    createdAt: timestamp,
    state: 'awaiting_admission',
    triggeredAt: timestamp,
  };
  await db.owner.query(
    'INSERT INTO playbook_definitions(tenant_id,id,document) VALUES($1,$2,$3)',
    [tenantId, process.definition.id, process.definition],
  );
  await db.owner.query(
    'INSERT INTO playbook_versions(tenant_id,definition_id,version,digest,document) VALUES($1,$2,$3,$4,$5)',
    [tenantId, process.definition.id, process.version, process.digest, process],
  );
  await db.owner.query(
    'INSERT INTO workflow_trigger_runs(tenant_id,id,definition_id,version,version_digest,dedupe_key,request_digest,document,state,triggered_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [
      tenantId,
      processId,
      process.definition.id,
      process.version,
      process.digest,
      'inventory-check',
      run.requestDigest,
      run,
      run.state,
      timestamp,
    ],
  );
  for (const output of [
    {
      stepId: 'refresh',
      kind: 'read',
      state: 'completed',
      values: { ready: true },
      evidenceRefs: ['inventory-read'],
      observedAt: timestamp,
      recordedAt: timestamp,
    },
    {
      stepId: 'check',
      kind: 'condition',
      state: 'completed',
      values: { matched: true },
      evidenceRefs: ['inventory-read'],
      recordedAt: timestamp,
    },
    {
      stepId: 'finish',
      kind: 'end',
      state: 'completed',
      values: { outcome: 'Stock reviewed' },
      evidenceRefs: [`temporal:${processId}:finish`],
      recordedAt: timestamp,
    },
  ])
    await db.owner.query(
      'INSERT INTO workflow_process_steps(tenant_id,run_id,step_id,state,document) VALUES($1,$2,$3,$4,$5)',
      [tenantId, processId, output.stepId, output.state, output],
    );
  await page.goto(`/app/${tenantId}/workflows/${process.definition.id}`);
  await page
    .getByRole('heading', { name: 'Inventory check' })
    .first()
    .waitFor();
  await page.getByRole('combobox', { name: 'Workflow sections' }).click();
  await page.getByRole('option', { name: 'Activity' }).click();
  const timeline = page.getByRole('list', { name: 'Step progress' });
  // Steps read by their business title, not their ID.
  await timeline.getByText('Refresh context', { exact: true }).waitFor();
  expect(await timeline.getByRole('listitem').count()).toBe(3);
  await page.screenshot({ path: '/tmp/luma67-browser/process-mobile.png' });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.screenshot({ path: '/tmp/luma67-browser/process-desktop.png' });
  expect(errors).toEqual([]);
});

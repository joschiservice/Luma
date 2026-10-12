/* global document, innerWidth */
import { randomUUID } from 'node:crypto';

import { createAuditLog } from '@luma/audit/composition';
import {
  builtInMembership,
  makeTenantContext,
} from '@luma/identity/composition';
import { createTenantDatabase } from '@luma/platform/composition';
import {
  compileProcessWorkflow,
  createCoordination,
  createWorkflows,
  createWorkflowTriggerStore,
} from '@luma/workflows/composition';
import { Pool } from 'pg';

import { expect, test } from './browser-fixtures.mjs';
import { availablePort, database, startApi, startProcess } from './helpers.mjs';

test('answers a human handoff in Needs you with keyboard use and narrow light and dark layouts', async ({
  resources: t,
}) => {
  const port = await availablePort(),
    origin = `http://127.0.0.1:${port}`;
  const db = await database(t);
  await db.migrate();
  await db.grantRuntime();
  const api = await startApi(t, db, origin);
  await startProcess(
    t,
    'e2e/web-server.mjs',
    { TEST_API_ORIGIN: api.origin, TEST_WEB_PORT: String(port) },
    true,
  ).message('listening');
  const page = await t.newPage({
    baseURL: origin,
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/sign-up');
  await page.getByLabel('Name', { exact: true }).fill('Ada');
  await page.getByLabel('Email', { exact: true }).fill('handoff@example.test');
  await page
    .getByLabel('Password', { exact: true })
    .fill('browser-test-password-123');
  await page
    .getByRole('button', { name: 'Create account', exact: true })
    .click();
  await page.getByLabel('Workspace name').fill('Human handoffs');
  await page
    .getByRole('button', { name: 'Create workspace', exact: true })
    .click();
  await page.getByRole('heading', { name: 'Needs your attention' }).waitFor();
  const tenantId = new URL(page.url()).pathname.split('/')[2];
  const user = (
    await db.owner.query(
      'SELECT u.id,m.id AS membership_id FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.tenant_id=$1',
      [tenantId],
    )
  ).rows[0];
  const context = makeTenantContext(
    { userId: user.id, sessionId: 'fixture' },
    {
      id: tenantId,
      name: 'Human handoffs',
      slug: 'human-handoffs',
      status: 'active',
      dataRegion: 'EU',
    },
    builtInMembership(
      { id: user.membership_id, organizationId: tenantId, userId: user.id },
      'owner',
    ),
    'browser-fixture',
  );
  const pool = new Pool({ connectionString: db.runtimeUrl });
  t.onTestFinished(() => pool.end());
  const tenantDb = createTenantDatabase(pool);
  const coordination = createCoordination(
    tenantDb,
    {
      refreshContext: async (value) => value,
      resolveWorkflowContext: async () => context,
      listMembers: async () => [{ userId: user.id, role: { id: 'owner' } }],
    },
    createAuditLog,
  );
  const catalog = createWorkflows(tenantDb, {}, async (value) => value, {
    approvalRequirement: async () => ({
      mode: 'every_action',
      reason: 'minimum_risk',
    }),
  });
  const version = compileProcessWorkflow({
    schemaVersion: 2,
    definition: {
      id: 'picking-handoff',
      name: 'Confirm picking',
      intent: 'Ask the warehouse to confirm picking.',
      category: 'operations',
    },
    version: '1.0.0',
    applicability: { trigger: { kind: 'manual' }, subjectKind: 'order' },
    inputs: {},
    context: {
      kind: 'warehouse',
      fields: { ready: 'boolean' },
      maxAgeSeconds: 300,
    },
    steps: [
      {
        id: 'confirm',
        kind: 'human_task',
        assignee: { kind: 'person', id: user.id },
        instructions: 'Confirm whether picking has started.',
        choices: ['Started', 'Blocked'],
        evidence: 'text',
        dueAfterSeconds: 3600,
        escalationTarget: { kind: 'role', key: 'owner' },
      },
      { id: 'end', kind: 'end', outcome: 'Warehouse answer recorded' },
    ],
    provenance: {
      kind: 'native',
      reference: 'browser-fixture',
      authoredBy: user.id,
      evidenceRefs: ['fixture'],
    },
  });
  await catalog.publish(context, version);
  const now = new Date().toISOString();
  const started = await catalog.fire(context, version.definition.id, {
    version: version.version,
    reviewedDigest: version.digest,
    subject: { kind: 'order', id: randomUUID() },
    signal: { kind: 'manual', sourceId: randomUUID(), occurredAt: now },
    context: {
      inputs: {},
      evidence: {
        kind: 'warehouse',
        facts: { ready: true },
        observations: [
          { id: randomUUID(), observedAt: now, source: 'warehouse' },
        ],
      },
      provenance: { reference: 'fixture', capturedAt: now },
    },
  });
  const run = await createWorkflowTriggerStore(tenantDb).run(
    context,
    started.id,
  );
  expect(
    await coordination.coordinate(run, version.steps[0], [], now),
  ).toMatchObject({ state: 'pending' });
  await page.reload();
  await page
    .getByText('Confirm whether picking has started.', { exact: true })
    .first()
    .click();
  await page.getByLabel('Answer', { exact: true }).waitFor();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect
    .poll(() => page.locator('html').getAttribute('class'))
    .toContain('dark');
  await page.screenshot({
    path: '/tmp/luma-a667004c-human-desktop-dark.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect
    .poll(() => page.locator('html').getAttribute('class'))
    .not.toContain('dark');
  await page.screenshot({
    path: '/tmp/luma-a667004c-human-mobile-light.png',
    fullPage: true,
  });
  await page.getByLabel('Answer', { exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('option', { name: 'Started', exact: true }).click();
  await page
    .getByLabel('Required evidence', { exact: true })
    .fill('Warehouse confirmed picking on the order.');
  await page
    .getByLabel('Note (optional)', { exact: true })
    .fill('Confirmed by warehouse staff.');
  await page
    .getByRole('button', { name: 'Submit answer', exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await coordination.task(context, run.id, 'confirm')).answer?.choice,
    )
    .toBe('Started');
  expect((await coordination.pending(context)).length).toBe(0);
  expect(errors).toEqual([]);
});

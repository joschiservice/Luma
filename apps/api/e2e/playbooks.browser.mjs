/* global document, innerWidth, window */
import { randomUUID } from 'node:crypto';

import { expect, test } from './browser-fixtures.mjs';
import { createAccount, database, startApi } from './helpers.mjs';
import { seedPlaybooks } from './playbooks-fixture.mjs';

test('finds, reviews, activates, reloads and revokes a persisted workflow with workspace and member isolation', async ({
  resources: t,
  web,
}) => {
  const origin = web.origin;
  const db = await database(t);
  await db.migrate();
  await db.grantRuntime();
  await db.owner.query(
    `GRANT luma_connectors TO "${new URL(db.runtimeUrl).username}"`,
  );
  const api = await startApi(t, db, origin, 'e2e/connections-server.mjs');
  await web.route(api.origin);
  const context = await t.newContext({
    baseURL: origin,
    viewport: { width: 1440, height: 1100 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createAccount(page, db, {
    name: 'Ada',
    email: 'workflows@example.test',
    password: 'browser-test-password-123',
  });
  await page.getByLabel('Workspace name').fill('Workflow studio');
  await page
    .getByRole('button', { name: 'Create workspace', exact: true })
    .click();
  await page.getByRole('heading', { name: 'Needs you' }).waitFor();
  const tenantId = new URL(page.url()).pathname.split('/')[2];
  const { version, connectionId, targetId } = await seedPlaybooks(db, tenantId);
  const url = `/app/${tenantId}/workflows`,
    name = version.definition.name;
  await page.getByRole('link', { name: 'Workflows', exact: true }).click();
  expect(await page.title()).toBe('Luma');
  page.on('console', (message) => {
    if (
      ['error', 'warning'].includes(message.type()) &&
      !/Failed to load resource.*(?:net::ERR_FAILED|status of (?:401|404|409))/.test(
        message.text(),
      )
    )
      errors.push(message.text());
  });
  await page.getByRole('link', { name }).waitFor();
  await page.goto(`/app/${tenantId}/playbooks?q=shipping`);
  await page.waitForURL(`**/app/${tenantId}/workflows?q=shipping*`);
  await page.getByRole('button', { name: 'Add System filter' }).click();
  await page.getByRole('button', { name: 'JTL Cloud', exact: true }).click();
  await page.getByRole('link', { name }).waitFor();
  await page
    .getByRole('button', { name: 'Remove System filter: JTL Cloud' })
    .click();
  await page.getByRole('link', { name }).waitFor();
  await page.getByRole('tab', { name: /^On 0$/ }).click();
  await page.getByRole('heading', { name: 'No matching workflows' }).waitFor();
  await page.getByRole('tab', { name: /^All workflows 1$/ }).click();
  await page.getByRole('link', { name }).waitFor();
  await page.getByLabel('Search workflows').fill('missing');
  await page.getByRole('heading', { name: 'No matching workflows' }).waitFor();
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await page.getByLabel('Search workflows').fill('shipping');
  await page.getByLabel('Search workflows').press('Enter');
  await page.waitForURL((url) =>
    (url.searchParams.get('q') ?? '').includes('shipping'),
  );
  await page.getByRole('link', { name }).click();
  // A workflow that is off opens on how it works, with the setup step first.
  await page
    .getByRole('tab', { name: 'How it works', selected: true })
    .waitFor();
  await page.getByRole('heading', { name: 'Review activation' }).waitFor();
  await page.getByText('Off', { exact: true }).first().waitFor();
  await page
    .getByRole('button', { name: 'Review activation', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Connection' }).click();
  await page.getByRole('option', { name: 'JTL warehouse' }).click();
  await dialog
    .getByRole('checkbox', { name: new RegExp('Order 1042') })
    .check();
  await dialog
    .getByRole('checkbox', {
      name: 'I reviewed this version, order scope and approval requirements.',
    })
    .check();
  // A background refresh must invalidate approval of the previous requirements.
  const detailUrl = `**/v1/organizations/${tenantId}/workflows/${version.definition.id}`;
  let policyVersion;
  let reads = 0;
  await page.route(detailUrl, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    reads += 1;
    await route.fulfill({
      response,
      json: { ...body, ...(policyVersion ? { policyVersion } : {}) },
    });
  });
  const review = dialog.getByRole('checkbox', {
    name: 'I reviewed this version, order scope and approval requirements.',
  });
  for (const change of ['connection', 'policy', 'restore']) {
    if (change === 'connection')
      await db.owner.query(
        "UPDATE connector_installations SET version=3,document=jsonb_set(document,'{version}','3') WHERE id=$1",
        [connectionId],
      );
    policyVersion = change === 'policy' ? 'v0.2' : undefined;
    const before = reads;
    await page.evaluate(() =>
      window.dispatchEvent(new Event('visibilitychange')),
    );
    await expect.poll(() => reads).toBeGreaterThan(before);
    await expect.poll(() => review.isChecked()).toBe(false);
    expect(
      await dialog
        .getByRole('button', { name: 'Activate reviewed version', exact: true })
        .isEnabled(),
    ).toBe(false);
    await review.check();
  }
  // Drop a successful response once; retry must recover the original persisted activation.
  let lost = false;
  await page.route('**/workflows/*/activations', async (route) => {
    if (route.request().method() === 'POST' && !lost) {
      lost = true;
      await route.fetch();
      await route.abort('failed');
    } else await route.continue();
  });
  await dialog
    .getByRole('button', { name: 'Activate reviewed version', exact: true })
    .click();
  await dialog.getByRole('button', { name: 'Retry activation' }).click();
  await page.getByText('On', { exact: true }).first().waitFor();
  // Turning it on keeps the reader on the tab they chose.
  await page
    .getByRole('tab', { name: 'How it works', selected: true })
    .waitFor();
  await page.getByRole('tab', { name: 'Setup' }).click();
  await page.getByText('Version 0.1.0 · Active', { exact: true }).waitFor();
  // Losing write access keeps the workflow enabled but visibly blocked, with the repair.
  await db.owner.query(
    `UPDATE connector_installations SET document=jsonb_set(document,'{granted}','["orders.read"]') WHERE id=$1`,
    [connectionId],
  );
  await page.reload();
  await page.getByText('Can’t run', { exact: true }).first().waitFor();
  await page
    .getByRole('heading', { name: 'Repair access in Connections' })
    .waitFor();
  const repair = page
    .getByRole('link', { name: 'Repair access in Connections' })
    .first();
  expect(await repair.getAttribute('href')).toContain(
    `#connection-${connectionId}`,
  );
  await page
    .getByRole('navigation', { name: 'Breadcrumb' })
    .getByRole('link', { name: 'Workflows' })
    .click();
  await page.getByRole('tab', { name: /^Needs attention 1$/ }).click();
  await page.getByRole('link', { name }).waitFor();
  await page.getByText('Can’t run', { exact: true }).first().waitFor();
  await db.owner.query(
    `UPDATE connector_installations SET document=jsonb_set(document,'{granted}','["orders.read","orders.shipping-method.write"]') WHERE id=$1`,
    [connectionId],
  );
  await page.getByRole('link', { name }).click();
  await page.getByText('On', { exact: true }).first().waitFor();
  // A workflow that is on opens on its runs.
  await page.getByRole('tab', { name: /^Runs/, selected: true }).waitFor();
  expect(
    (
      await db.owner.query(
        'SELECT count(*)::int AS n FROM playbook_activations',
      )
    ).rows[0].n,
  ).toBe(1);
  const activation = (
    await db.owner.query('SELECT id FROM playbook_activations')
  ).rows[0].id;
  const runId = randomUUID();
  const run = {
    id: runId,
    tenantId,
    activationId: activation,
    definitionId: version.definition.id,
    version: version.version,
    versionDigest: version.digest,
    principalId: randomUUID(),
    incidentId: randomUUID(),
    diagnosisRevision: 1,
    snapshotDigest: 'a'.repeat(64),
    snapshot: {
      evidence: { facts: { diagnosisReady: true, methodMapped: true } },
    },
    action: { id: runId, target: { kind: 'order', id: targetId } },
    createdAt: new Date().toISOString(),
  };
  await db.owner.query(
    'INSERT INTO playbook_runs(tenant_id,id,activation_id,definition_id,version,version_digest,document) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [
      tenantId,
      runId,
      activation,
      version.definition.id,
      version.version,
      version.digest,
      run,
    ],
  );
  const outcome = {
    proposalId: runId,
    state: 'awaiting_approval',
    reason: 'approval_required',
    stepId: 'approve',
  };
  await db.owner.query(
    'INSERT INTO playbook_outcomes(tenant_id,run_id,digest,document) VALUES($1,$2,$3,$4)',
    [tenantId, runId, 'b'.repeat(64), outcome],
  );
  await page.reload();
  // The only recent run opens straight away.
  await page
    .getByRole('button', {
      name: /Waiting for approval.*Workflow issue detected/,
    })
    .and(page.locator('[aria-expanded="true"]'))
    .waitFor();
  await page
    .getByText(
      'Waiting for someone else who can approve changes to decide on the proposed change.',
    )
    .waitFor();
  await page
    .getByText('The expected correction has not been verified.', {
      exact: true,
    })
    .waitFor();
  await db.owner.query(
    'INSERT INTO playbook_outcomes(tenant_id,run_id,digest,document) VALUES($1,$2,$3,$4)',
    [
      tenantId,
      runId,
      'c'.repeat(64),
      {
        ...outcome,
        state: 'escalated',
        reason: 'verification_inconclusive',
        stepId: 'verify-correction',
        execution: { state: 'succeeded' },
      },
    ],
  );
  await page.getByRole('button', { name: 'Refresh runs', exact: true }).click();
  await page
    .getByText('The expected correction could not be confirmed.', {
      exact: true,
    })
    .waitFor();
  await page.getByText('succeeded', { exact: true }).waitFor();
  await page
    .getByText(
      'The diagnosis was ready for a proposed correction. An approved shipping-method mapping was available.',
      { exact: true },
    )
    .waitFor();
  await page
    .getByRole('heading', { name: 'Recent runs', exact: true })
    .scrollIntoViewIfNeeded();
  expect(await page.locator('body').innerText()).not.toMatch(/playbook/i);

  await page.getByRole('tab', { name: 'Setup' }).click();
  await page.getByText('Version 0.1.0 · Active', { exact: true }).waitFor();
  await page.getByText('Orders: Order 1042', { exact: true }).waitFor();
  await page.getByText('Scope and review details', { exact: true }).click();
  await page.getByText(`Orders: ${targetId}`, { exact: true }).waitFor();
  await page
    .getByRole('button', { name: 'Revoke activation', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Confirm revocation', exact: true })
    .click();
  await page.getByText('Version 0.1.0 · Revoked', { exact: true }).waitFor();
  await page.reload();
  await page.getByText('Version 0.1.0 · Revoked', { exact: true }).waitFor();
  await page
    .getByRole('navigation', { name: 'Breadcrumb' })
    .getByRole('link', { name: 'Workflows' })
    .click();
  expect(await page.getByLabel('Search workflows').inputValue()).toBe(
    'shipping',
  );
  await page.getByRole('link', { name }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  // Every activation was revoked, so the workflow is paused and opens on its runs.
  await page.getByRole('tab', { name: /^Runs/, selected: true }).waitFor();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole('tab', { name: 'How it works' }).click();
  await page.getByRole('heading', { name: 'Verify the result' }).waitFor();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole('tab', { name: 'Setup' }).click();
  await page.waitForURL((url) => url.hash === '#rules');
  await page.getByText('Version 0.1.0 · Revoked', { exact: true }).waitFor();
  expect(
    await page
      .getByRole('button', { name: 'Review activation', exact: true })
      .isEnabled(),
  ).toBe(true);
  await db.owner.query(
    "UPDATE memberships SET role='member' WHERE tenant_id=$1",
    [tenantId],
  );
  await page.reload();
  await page
    .getByText(
      'You can view this workflow. Your role doesn’t allow activating workflows, so you can’t activate or revoke it.',
    )
    .waitFor();
  expect(
    await page
      .getByRole('button', { name: 'Review activation', exact: true })
      .isDisabled(),
  ).toBe(true);
  expect(
    await page
      .getByRole('button', { name: 'Revoke activation', exact: true })
      .count(),
  ).toBe(0);
  const user = (
    await db.owner.query('SELECT user_id FROM memberships WHERE tenant_id=$1', [
      tenantId,
    ])
  ).rows[0].user_id;
  const other = randomUUID();
  await db.owner.query(
    "INSERT INTO organizations(id,name,slug,data_region,status,created_at) VALUES($1,'Other studio',$2,'AU','active',now())",
    [other, `other-${other}`],
  );
  await db.owner.query(
    "INSERT INTO memberships(id,tenant_id,user_id,role,created_at) VALUES($1,$2,$3,'owner',now())",
    [randomUUID(), other, user],
  );
  await page.goto(`/app/${other}/workflows`);
  await page.getByRole('link', { name: /Replenish low stock/ }).waitFor();
  expect(await page.getByText(name, { exact: true }).count()).toBe(0);
  await page.goto(`/app/${other}/workflows/${version.definition.id}`);
  await page.getByText('Workflow not found', { exact: false }).waitFor();
  expect(await page.getByText('Order 1042', { exact: false }).count()).toBe(0);
  expect(errors).toEqual([]);
  await page.goto(`/app/${tenantId}/playbooks?q=shipping`);
  await page.waitForURL(`**/app/${tenantId}/workflows?q=shipping*`);
  await page.goto(url);
  await page.getByRole('link', { name }).waitFor();
});

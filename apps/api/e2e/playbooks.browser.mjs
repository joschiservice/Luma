/* global document, innerWidth, window */
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

import { chromium } from 'playwright';
import { expect, it } from 'vitest';

import { availablePort, database, startApi, startProcess } from './helpers.mjs';
import { seedPlaybooks } from './playbooks-fixture.mjs';

it('finds, reviews, activates, reloads and revokes a persisted playbook with workspace and member isolation', async (t) => {
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
    .fill('playbooks@example.test');
  await page
    .getByLabel('Password', { exact: true })
    .fill('browser-test-password-123');
  await page
    .getByRole('button', { name: 'Create account', exact: true })
    .click();
  await page.getByLabel('Workspace name').fill('Playbook studio');
  await page
    .getByRole('button', { name: 'Create workspace', exact: true })
    .click();
  await page.getByRole('heading', { name: 'Operations overview' }).waitFor();
  const tenantId = new URL(page.url()).pathname.split('/')[2];
  const { version, connectionId, targetId } = await seedPlaybooks(db, tenantId);
  const url = `/app/${tenantId}/playbooks`,
    name = version.definition.name;
  await page.getByRole('link', { name: 'Playbooks', exact: true }).click();
  await page.getByRole('link', { name }).waitFor();
  await page.getByLabel('Search by name').fill('missing');
  await page.getByRole('heading', { name: 'No matching playbooks' }).waitFor();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.getByLabel('Search by name').fill('shipping');
  await page.getByRole('link', { name }).click();
  await page
    .getByRole('heading', { name: 'How this playbook works' })
    .waitFor();
  await page
    .getByRole('button', { name: 'Review activation', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByLabel('Connection', { exact: true })
    .selectOption(connectionId);
  await dialog
    .getByRole('checkbox', { name: new RegExp('Order 1042') })
    .check();
  await dialog
    .getByRole('checkbox', {
      name: 'I reviewed this version, order scope and approval requirements.',
    })
    .check();
  // A background refresh must invalidate approval of the previous requirements.
  const detailUrl = `**/v1/organizations/${tenantId}/playbooks/${version.definition.id}`;
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
  await page.route('**/playbooks/*/activations', async (route) => {
    if (route.request().method() === 'POST' && !lost) {
      lost = true;
      await route.fetch();
      await route.abort('failed');
    } else await route.continue();
  });
  await dialog
    .getByRole('button', { name: 'Activate reviewed version', exact: true })
    .click();
  await dialog.getByRole('button', { name: 'Retry same activation' }).click();
  await page.getByText('Version 0.1.0 · Active', { exact: true }).waitFor();
  expect(
    (
      await db.owner.query(
        'SELECT count(*)::int AS n FROM playbook_activations',
      )
    ).rows[0].n,
  ).toBe(1);
  await page.reload();
  await page.getByText('Version 0.1.0 · Active', { exact: true }).waitFor();
  await page.getByText(`Orders: ${targetId}`, { exact: true }).waitFor();
  await mkdir('/tmp/luma62-browser', { recursive: true });
  await page.screenshot({
    path: '/tmp/luma62-browser/detail-desktop.png',
    fullPage: true,
  });
  await page
    .getByRole('button', { name: 'Revoke activation', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Confirm revocation', exact: true })
    .click();
  await page.getByText('Version 0.1.0 · Revoked', { exact: true }).waitFor();
  await page.reload();
  await page.getByText('Version 0.1.0 · Revoked', { exact: true }).waitFor();
  await page.getByRole('link', { name: 'All playbooks' }).click();
  expect(await page.getByLabel('Search by name').inputValue()).toBe('shipping');
  await page.getByRole('link', { name }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page
    .getByRole('heading', { name: 'How this playbook works' })
    .waitFor();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByLabel('Version', { exact: true }).focus();
  await page.keyboard.press('Tab');
  expect(
    await page
      .getByRole('button', { name: 'Review activation', exact: true })
      .evaluate((node) => node === document.activeElement),
  ).toBe(true);
  await page.screenshot({
    path: '/tmp/luma62-browser/detail-mobile.png',
    fullPage: true,
  });
  await db.owner.query(
    "UPDATE memberships SET role='member' WHERE tenant_id=$1",
    [tenantId],
  );
  await page.reload();
  await page
    .getByText(
      'You can inspect playbooks. Only workspace owners and admins can activate or revoke them.',
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
    "INSERT INTO organizations(id,name,slug,data_region,status,created_at) VALUES($1,'Other studio',$2,'EU','active',now())",
    [other, `other-${other}`],
  );
  await db.owner.query(
    "INSERT INTO memberships(id,tenant_id,user_id,role,created_at) VALUES($1,$2,$3,'owner',now())",
    [randomUUID(), other, user],
  );
  await page.goto(`/app/${other}/playbooks`);
  await page.getByRole('heading', { name: 'No published playbooks' }).waitFor();
  expect(await page.getByText(name, { exact: true }).count()).toBe(0);
  await page.goto(`/app/${other}/playbooks/${version.definition.id}`);
  await page.getByText('Playbook not found', { exact: false }).waitFor();
  expect(await page.getByText('Order 1042', { exact: false }).count()).toBe(0);
  expect(errors).toEqual([]);
  await page.goto(url);
  await page.getByRole('link', { name }).waitFor();
});

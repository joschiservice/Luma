import { randomUUID } from 'node:crypto';

import { createStockProtectionAdmission } from '@luma/policies/composition';
import { expect, onTestFinished, test } from 'vitest';

import { protectionFixture } from './stock-protection-fixture.mjs';

test('incident holds are verified, owned across reconstruction, tightened only down, and released to fresh ERP stock', async (t) => {
  const f = await protectionFixture(t);
  await f.service.tick(f.actor, f.incidentId);
  expect((await f.view()).positions[0]).toMatchObject({
    status: 'held',
    before: 12,
    held: 7,
    current: 7,
  });
  expect(f.mutations).toHaveLength(1);
  expect(f.mutations[0].variables.input.referenceDocumentUri).toMatch(
    /^luma:\/\/inventory-holds\//,
  );
  await f.call(
    f.f.owner,
    'preview',
    { ...f.target, requestId: randomUUID() },
    409,
  );
  const restarted = f.recreate();
  t.onTestFinished(() => restarted.close());
  const service = restarted.registry.stockProtection()[0];
  await service.tick(f.actor, f.incidentId);
  expect(f.mutations).toHaveLength(1);
  f.setAuthority(5);
  await service.tick(f.actor, f.incidentId);
  expect((await f.view()).positions[0]).toMatchObject({
    status: 'tightened',
    held: 3,
  });
  expect(f.mutations).toHaveLength(2);
  f.setAuthority(6);
  await service.control(f.actor, { id: f.incidentId, action: 'release' });
  await service.tick(f.actor, f.incidentId);
  expect((await f.view()).positions[0]).toMatchObject({
    status: 'released',
    current: 6,
  });
  expect((await f.view()).state).toBe('released');
  expect(f.mutations).toHaveLength(3);
  await service.tick(f.actor, f.incidentId);
  expect(f.mutations).toHaveLength(3);
  await f.f.db.owner.query(
    "UPDATE shopify_stock_protection_incidents SET created_at=now()-interval '8 days' WHERE tenant_id=$1 AND id=$2",
    [f.actor.tenantId, f.incidentId],
  );
  expect((await f.view()).positions[0].status).toBe('released');
  expect((await f.service.view(f.actor)).incidents).toEqual([]);
});

test('preview records the same held quantity without a Shopify write', async (t) => {
  const f = await protectionFixture(t, 'preview');
  await f.service.tick(f.actor, f.incidentId);
  expect((await f.view()).positions[0]).toMatchObject({
    status: 'preview',
    held: 7,
  });
  expect(f.mutations).toHaveLength(0);
});

test('outside changes end ownership and never re-hold a position in the incident', async (t) => {
  const f = await protectionFixture(t);
  await f.service.tick(f.actor, f.incidentId);
  await f.changeAvailable(6);
  await f.service.tick(f.actor, f.incidentId);
  expect((await f.view()).positions[0].status).toBe('changed_outside_luma');
  await f.service.tick(f.actor, f.incidentId);
  expect(f.mutations).toHaveLength(1);
});

test('one known CAS conflict is reread and recomputed; a lost response is never resent', async (t) => {
  const f = await protectionFixture(t);
  f.race();
  await f.service.tick(f.actor, f.incidentId);
  expect((await f.view()).positions[0]).toMatchObject({
    status: 'held',
    held: 7,
  });
  expect(f.mutations).toHaveLength(2);
  await f.service.control(f.actor, { id: f.incidentId, action: 'release' });
  f.loseResponse();
  await f.service.tick(f.actor, f.incidentId);
  expect((await f.view()).positions[0].status).toBe('unknown');
  expect(f.mutations).toHaveLength(3);
  await f.service.tick(f.actor, f.incidentId);
  await f.service.tick(f.actor, f.incidentId);
  expect(f.mutations).toHaveLength(3);
});

test('turning off requires a disposition and observe-only blocks releases without losing ownership', async (t) => {
  const f = await protectionFixture(t);
  await f.service.tick(f.actor, f.incidentId);
  const settings = (await f.service.view(f.actor)).settings[0];
  await expect(
    f.service.save(f.actor, { settings: { ...settings, mode: 'off' } }),
  ).rejects.toMatchObject({ statusCode: 409 });
  await f.service.save(f.actor, {
    settings: { ...settings, mode: 'off' },
    activeHolds: 'release',
  });
  const workspace = (await f.f.request(f.f.owner, `${f.f.base}/settings`))
    .workspace;
  await f.f.request(
    f.f.owner,
    `${f.f.base}/settings/write-mode`,
    'PATCH',
    f.f.command({ revision: workspace.revision, writeMode: 'observe_only' }),
    409,
  );
  await f.f.request(
    f.f.owner,
    `${f.f.base}/settings/write-mode`,
    'PATCH',
    f.f.command({
      revision: workspace.revision,
      writeMode: 'observe_only',
      acknowledgeStockHolds: true,
    }),
  );
  await f.service.tick(f.actor, f.incidentId);
  expect((await f.view()).positions[0]).toMatchObject({
    status: 'held',
    reason: 'observe_only',
  });
  expect(f.mutations).toHaveLength(1);
  const observe = (await f.f.request(f.f.owner, `${f.f.base}/settings`))
    .workspace;
  await f.f.request(
    f.f.owner,
    `${f.f.base}/settings/write-mode`,
    'PATCH',
    f.f.command({ revision: observe.revision, writeMode: 'writes_enabled' }),
  );
  await f.service.tick(f.actor, f.incidentId);
  expect((await f.view()).positions[0]).toMatchObject({
    status: 'released',
    current: 9,
  });
  expect(f.mutations).toHaveLength(2);
});

test('Always require approval gives one incident decision, and another tenant cannot control its holds', async (t) => {
  const f = await protectionFixture(t);
  const workspace = (await f.f.request(f.f.owner, `${f.f.base}/settings`))
    .workspace;
  await f.f.request(
    f.f.owner,
    `${f.f.base}/settings/approvals`,
    'PATCH',
    f.f.command({
      revision: workspace.policyRevision,
      alwaysRequireApproval: true,
    }),
  );
  await f.service.tick(f.actor, f.incidentId);
  expect((await f.view()).state).toBe('approval_required');
  expect(f.mutations).toHaveLength(0);
  const admin = await f.f.identity.service.resolveWorkflowContext(
    f.admin.id,
    f.actor.tenantId,
    'stock-protection-approve',
  );
  await f.service.control(admin, { id: f.incidentId, action: 'approve' });
  await f.service.tick(f.actor, f.incidentId);
  expect((await f.view()).positions[0].status).toBe('held');
  expect(f.mutations).toHaveLength(1);
  await f.f.request(
    f.f.member,
    `${f.f.base}/apps/shopify/stock-protection-save`,
    'POST',
    { settings: {} },
    403,
  );
  await f.f.request(
    f.f.outsider,
    `${f.f.base}/apps/shopify/stock-protection-control`,
    'POST',
    { id: f.incidentId, action: 'release' },
    404,
  );
});

test('Preview can be explicitly promoted, and UTC budgets reserve once on each dispatch day', async (t) => {
  const f = await protectionFixture(t, 'preview');
  await f.service.tick(f.actor, f.incidentId);
  const settings = (await f.service.view(f.actor)).settings[0];
  await f.service.save(f.actor, { settings: { ...settings, mode: 'on' } });
  await Promise.all([
    f.service.tick(f.actor, f.incidentId),
    f.service.tick(f.actor, f.incidentId),
  ]);
  expect((await f.view()).positions[0]).toMatchObject({
    status: 'held',
    before: 12,
    held: 7,
  });
  expect(f.mutations).toHaveLength(1);
  const run = (
    await f.f.db.owner.query(
      'SELECT document FROM shopify_stock_protection_actions WHERE tenant_id=$1',
      [f.actor.tenantId],
    )
  ).rows[0].document;
  await f.f.db.owner.query(
    "UPDATE stock_protection_budgets SET utc_day=(now() AT TIME ZONE 'UTC')::date-1 WHERE tenant_id=$1 AND proposal_id=$2",
    [f.actor.tenantId, run.id],
  );
  const reserve = createStockProtectionAdmission(f.database);
  expect(
    await reserve(f.actor, {
      ...run.action,
      parameters: { ...run.action.parameters, available: 1 },
    }),
  ).toBe(false);
  expect(await reserve(f.actor, run.action)).toBe(true);
  expect(await reserve(f.actor, run.action)).toBe(true);
  expect(
    (
      await f.f.db.owner.query(
        'SELECT count(*)::int AS count FROM stock_protection_budgets WHERE tenant_id=$1 AND proposal_id=$2',
        [f.actor.tenantId, run.id],
      )
    ).rows[0].count,
  ).toBe(2);
  expect(f.mutations).toHaveLength(1);
});

test('failed point reads cannot authorize holds from a recent stored ERP reading', async (t) => {
  const f = await protectionFixture(t);
  f.setReadFailure(true);
  await f.service.tick(f.actor, f.incidentId);
  expect(f.mutations).toHaveLength(0);
  expect((await f.view()).positions[0]).toMatchObject({
    status: 'unknown',
    startedAt: null,
  });
  f.setReadFailure(false);
  await f.service.tick(f.actor, f.incidentId);
  expect((await f.view()).positions[0].status).toBe('held');
  expect(f.mutations).toHaveLength(1);
});

test('a sync write ends ownership, and a later stall pass never re-holds that SKU', async (t) => {
  const f = await protectionFixture(t);
  await f.service.tick(f.actor, f.incidentId);
  await f.changeAvailable(9);
  await f.service.tick(f.actor, f.incidentId);
  expect((await f.view()).positions[0]).toMatchObject({
    status: 'released_by_sync',
    current: 9,
  });
  await f.service.tick(f.actor, f.incidentId);
  expect(f.mutations).toHaveLength(1);
});

test('the maximum duration escalates once and keeps holds until an explicit release', async (t) => {
  const f = await protectionFixture(t);
  await f.service.tick(f.actor, f.incidentId);
  await f.f.db.owner.query(
    `UPDATE shopify_stock_protection_incidents SET document=jsonb_set(document,'{view,deadline}',to_jsonb($3::text)) WHERE tenant_id=$1 AND id=$2`,
    [
      f.actor.tenantId,
      f.incidentId,
      new Date(Date.now() - 60000).toISOString(),
    ],
  );
  await f.service.tick(f.actor, f.incidentId);
  await f.service.tick(f.actor, f.incidentId);
  expect((await f.view()).state).toBe('escalated');
  expect((await f.view()).positions[0].status).toBe('held');
  expect(f.mutations).toHaveLength(1);
  expect(
    (
      await f.f.db.owner.query(
        `SELECT count(*)::int AS count FROM shopify_stock_protection_events WHERE tenant_id=$1 AND incident_id=$2 AND kind='escalated'`,
        [f.actor.tenantId, f.incidentId],
      )
    ).rows[0].count,
  ).toBe(1);
  await f.service.control(f.actor, { id: f.incidentId, action: 'extend' });
  expect((await f.view()).state).toBe('active');
  await f.service.control(f.actor, { id: f.incidentId, action: 'release' });
  await f.service.tick(f.actor, f.incidentId);
  expect((await f.view()).state).toBe('released');
  expect(f.mutations).toHaveLength(2);
});

test('uninstall retains a visible unknown incident and prevents further Shopify writes', async (t) => {
  const f = await protectionFixture(t);
  await f.service.tick(f.actor, f.incidentId);
  const apps = await f.f.request(f.f.owner, `${f.f.base}/apps`);
  const app = apps.installations.find((app) => app.appId === 'shopify');
  await f.f.request(f.f.owner, `${f.f.base}/apps/shopify/uninstall`, 'POST', {
    version: app.version,
  });
  expect((await f.view()).positions[0].status).toBe('unknown');
  await f.service.tick(f.actor, f.incidentId);
  expect((await f.view()).state).toBe('unknown');
  expect((await f.view()).stopNew).toBe(true);
  expect(f.mutations).toHaveLength(1);
  const view = await f.f.request(
    f.f.owner,
    `${f.f.base}/apps/shopify/stock-protection-view`,
    'POST',
    { incidentId: f.incidentId, limit: 10 },
  );
  expect(view.incidents[0].positions[0].status).toBe('unknown');
});

test('changing a held SKU to continue selling pauses ownership without tightening or releasing it', async (t) => {
  const f = await protectionFixture(t);
  await f.service.tick(f.actor, f.incidentId);
  await f.runShopify({
    kind: 'inventory-policy',
    variant: '1',
    policy: 'CONTINUE',
  });
  f.setAuthority(3);
  await f.service.tick(f.actor, f.incidentId);
  expect((await f.view()).positions[0]).toMatchObject({
    status: 'unknown',
    held: 7,
  });
  expect(f.mutations).toHaveLength(1);
});

test('a confirmed throttled non-dispatch resumes with a new bounded intent and no repeated effect', async (t) => {
  const f = await protectionFixture(t);
  f.throttleMutations(1);
  await f.service.tick(f.actor, f.incidentId);
  expect((await f.view()).positions[0]).toMatchObject({
    status: 'pending',
    reason: 'deferred',
    startedAt: null,
  });
  expect(f.level.quantities.find((q) => q.name === 'available').quantity).toBe(
    12,
  );
  await f.service.tick(f.actor, f.incidentId);
  expect((await f.view()).positions[0]).toMatchObject({
    status: 'held',
    held: 7,
  });
  expect(f.mutations).toHaveLength(2);
  await f.service.tick(f.actor, f.incidentId);
  expect(f.mutations).toHaveLength(2);
});

test('a lost initial hold response still requires an observe-only warning before a hold can be verified', async (t) => {
  const f = await protectionFixture(t);
  f.loseResponse();
  await f.service.tick(f.actor, f.incidentId);
  expect((await f.view()).positions[0]).toMatchObject({
    status: 'unknown',
    startedAt: null,
  });
  expect((await f.view()).uncertainCount).toBe(1);
  const workspace = (await f.f.request(f.f.owner, `${f.f.base}/settings`))
    .workspace;
  await f.f.request(
    f.f.owner,
    `${f.f.base}/settings/write-mode`,
    'PATCH',
    f.f.command({ revision: workspace.revision, writeMode: 'observe_only' }),
    409,
  );
  expect(f.mutations).toHaveLength(1);
});

test.each([
  [
    'bundle',
    {
      kind: 'bundle-recipe',
      variant: '1',
      requiresComponents: true,
      components: [],
    },
    'bundle',
  ],
  [
    'continue selling',
    { kind: 'inventory-policy', variant: '1', policy: 'CONTINUE' },
    'continue_selling',
  ],
])(
  '%s positions are listed as not protected with a reason and no write',
  async (_name, command, reason) => {
    const f = await protectionFixture({ onTestFinished });
    await f.runShopify(command);
    await f.service.tick(f.actor, f.incidentId);
    expect((await f.view()).positions[0]).toMatchObject({
      status: 'not_protected',
      reason,
      startedAt: null,
    });
    expect(f.mutations).toHaveLength(0);
  },
);

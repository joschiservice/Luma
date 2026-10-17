import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { test, vi } from 'vitest';

import { starshipitUpdatesFixture } from './starshipit-updates-fixture.mjs';

test('Starshipit mapped authoritative quantities require independent approval, dispatch once across concurrent starts and API restart, and appear in the order timeline', async (t) => {
  const f = await starshipitUpdatesFixture(t);
  await f.call('inspect', f.target, { cookie: f.member, status: 403 });
  const preview = await f.preview();
  assert.equal(preview.state, 'approval_required');
  assert.equal(preview.canExecute, false);
  assert.equal(
    (await f.call('execute', { id: preview.id })).state,
    'approval_required',
  );
  assert.equal((await f.receipts()).length, 0);
  await f.call(
    'approve',
    { id: preview.id, outcome: 'approved' },
    { status: 409 },
  );
  await f.call(
    'approve',
    { id: preview.id, outcome: 'approved' },
    { cookie: f.approver },
  );
  const sent = await Promise.all([
    f.call('execute', { id: preview.id }),
    f.call('execute', { id: preview.id }),
  ]);
  assert.ok(
    sent.every((view) => ['verified', 'uncertain'].includes(view.state)),
  );
  assert.equal((await f.call('check', { id: preview.id })).state, 'verified');
  assert.equal((await f.receipts()).length, 1);
  f.pilot = await f.restart();
  assert.equal((await f.call('execute', { id: preview.id })).state, 'verified');
  assert.equal((await f.receipts()).length, 1);
  assert.equal(
    (await f.providerOrder()).items.find(
      (item) => String(item.item_id) === f.itemId,
    ).quantity,
    f.quantity,
  );
  const detail = await f.api(`/orders/${f.canonicalOrder}`);
  assert.ok(
    detail.activity.entries.some((entry) => entry.type === 'execution'),
    JSON.stringify(detail.activity.entries),
  );
  assert.ok(
    detail.activity.entries.some(
      (entry) => entry.type === 'verification' && entry.outcome === 'verified',
    ),
    JSON.stringify(detail.activity.entries),
  );
});

test('committed updates with a lost response reconcile after restart without another provider write even after the action release is removed', async (t) => {
  const f = await starshipitUpdatesFixture(t),
    preview = await f.preview();
  await f.call(
    'approve',
    { id: preview.id, outcome: 'approved' },
    { cookie: f.approver },
  );
  await f.hostCall('runs/operations/control', {
    action: 'fault',
    rule: {
      instance: 'starshipit',
      operation: 'orders.quantity.update',
      kind: 'response-loss',
      remaining: 1,
    },
  });
  const attempted = await f.call('execute', { id: preview.id });
  assert.equal(attempted.state, 'uncertain');
  assert.equal(
    (await f.providerOrder()).items.find(
      (item) => String(item.item_id) === f.itemId,
    ).quantity,
    f.quantity,
  );
  f.pilot = await f.restart({
    featureOverrides: {
      'starshipit-fulfillment': true,
      'starshipit-actions': false,
      'shopify-shipment-publishing': true,
    },
  });
  assert.equal((await f.call('check', { id: preview.id })).state, 'verified');
  assert.equal((await f.call('execute', { id: preview.id })).state, 'verified');
  const fence = (
    await f.db.owner.query(
      'SELECT sent_at,settled FROM starshipit_order_updates WHERE tenant_id=$1 AND id=$2',
      [f.manifest.organizationId, preview.id],
    )
  ).rows[0];
  assert.ok(fence.sent_at);
  assert.equal(fence.settled, true);
  assert.equal(
    (await f.receipts()).length,
    0,
    'lost acknowledgement is never fabricated as an acceptance',
  );
});

test('an inconclusive authoritative refresh withholds a correction without closing its review, and a fresh read restores approval', async (t) => {
  const f = await starshipitUpdatesFixture(t),
    preview = await f.preview();
  await f.hostCall('runs/operations/control', {
    action: 'fault',
    rule: {
      instance: 'shopify',
      operation: 'orders.read',
      resource: `gid://shopify/Order/${f.target.orderId}`,
      kind: 'malformed',
      remaining: 100,
    },
  });
  const [fault] = (await f.hostCall('runs/operations')).faults;
  const inspected = await Promise.all([
    f.call('inspect', f.target),
    f.call('inspect', f.target, { cookie: f.approver }),
  ]);
  assert.ok(inspected.every((view) => view.updates[0].state === 'unavailable'));
  assert.ok(inspected.every((view) => view.updates[0].canCheck));
  const pending = await f.api('/decisions?view=all&limit=50');
  const recovery = pending.items.find(
    (item) => item.id === `starshipit:order_update:${preview.id}`,
  );
  assert.equal(recovery?.response, 'check');
  assert.equal(recovery?.reason, 'recovery');
  await f.call(
    'approve',
    { id: preview.id, outcome: 'approved' },
    {
      cookie: f.approver,
      status: 409,
    },
  );
  const stored = await f.db.owner.query(
    'SELECT closed,sent_at FROM starshipit_order_updates WHERE tenant_id=$1 AND id=$2',
    [f.manifest.organizationId, preview.id],
  );
  assert.equal(stored.rows[0].closed, false);
  assert.equal(stored.rows[0].sent_at, null);
  assert.equal((await f.receipts()).length, 0);
  await f.hostCall('runs/operations/control', {
    action: 'disable',
    id: fault.id,
  });
  assert.equal(
    (
      await f.call(
        'approve',
        {
          id: preview.id,
          outcome: 'approved',
        },
        { cookie: f.approver },
      )
    ).state,
    'approved',
  );
  assert.equal((await f.call('execute', { id: preview.id })).state, 'verified');
  assert.equal((await f.receipts()).length, 1);
});

// Three previews, approvals and fresh reads run in sequence, so this journey needs more than the default.
test('labels, changed authority, and cancelled authoritative orders withhold approved shipping corrections', async (t) => {
  const f = await starshipitUpdatesFixture(t),
    preview = await f.preview();
  await f.call(
    'approve',
    { id: preview.id, outcome: 'approved' },
    { cookie: f.approver },
  );
  await f.command('starshipit', {
    kind: 'status',
    order: '1',
    status: 'Printed',
  });
  await f.call('execute', { id: preview.id }, { status: 409 });
  assert.equal((await f.receipts()).length, 0);
  await f.call('check', { id: preview.id });
  await f.command('starshipit', {
    kind: 'status',
    order: '1',
    status: 'Unshipped',
  });
  await f.pilot.observe({ check: false });
  const next = await f.preview();
  await f.call(
    'approve',
    { id: next.id, outcome: 'approved' },
    { cookie: f.approver },
  );
  const authority = await f.api('/source-authority');
  await f.api('/source-authority', {
    method: 'POST',
    body: {
      commandId: randomUUID(),
      revision: authority.revision,
      group: 'order_lines',
      connectionId: f.manifest.connections.jtl,
    },
  });
  await f.call('execute', { id: next.id }, { status: 409 });
  assert.equal((await f.receipts()).length, 0);
  await f.call('check', { id: next.id });
  const current = await f.api('/source-authority');
  await f.api('/source-authority', {
    method: 'POST',
    body: {
      commandId: randomUUID(),
      revision: current.revision,
      group: 'order_lines',
      connectionId: f.manifest.connections.shopify,
    },
  });
  const expired = await f.preview();
  await f.call(
    'approve',
    { id: expired.id, outcome: 'approved' },
    { cookie: f.approver },
  );
  const clock = vi
    .spyOn(Date, 'now')
    .mockReturnValue(Date.parse(expired.expiresAt) + 1);
  try {
    await f.call('execute', { id: expired.id }, { status: 409 });
    await f.call('check', { id: expired.id });
  } finally {
    clock.mockRestore();
  }
  assert.equal((await f.receipts()).length, 0);
  await f.command('shopify', {
    kind: 'cancel',
    order: '1',
    reason: 'CUSTOMER',
  });
  await f.pilot.observe({ check: false });
  await f.preview({ status: 409 });
  assert.equal((await f.receipts()).length, 0);
}, 120_000);

test('observe-only and action-release removal send no shipping correction and another tenant cannot use the saved reference', async (t) => {
  const f = await starshipitUpdatesFixture(t);
  const settings = await f.api('/settings');
  await f.api('/settings/write-mode', {
    method: 'PATCH',
    cookie: f.approver,
    body: {
      commandId: randomUUID(),
      revision: settings.workspace.revision,
      writeMode: 'observe_only',
    },
  });
  const preview = await f.preview();
  assert.equal(preview.observeOnly, true);
  const result = await f.call('execute', { id: preview.id });
  assert.equal(result.state, 'not_executed');
  assert.equal((await f.receipts()).length, 0);
  f.pilot = await f.restart({
    featureOverrides: {
      'starshipit-fulfillment': true,
      'starshipit-actions': false,
      'shopify-shipment-publishing': true,
    },
  });
  await f.preview({ status: 409 });
  assert.equal((await f.receipts()).length, 0);
  const response = await f.pilot.app.inject({
    method: 'POST',
    url: `/v1/organizations/${randomUUID()}/apps/starshipit/order-update-check`,
    headers: { cookie: f.owner, origin: 'http://127.0.0.1:3000' },
    payload: { id: preview.id },
  });
  assert.equal(response.statusCode, 404);
});

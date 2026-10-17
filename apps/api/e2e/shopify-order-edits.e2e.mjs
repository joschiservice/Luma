import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { test } from 'vitest';

import { orderEditFixture } from './shopify-order-edits-fixture.mjs';

const unfulfilled = async (fixture, order, line) =>
  (await fixture.read(order.id)).lines.find(
    (item) => `gid://shopify/LineItem/${item.id}` === line,
  ).unfulfilled;

test('an approved Shopify quantity edit is calculated, committed once and verified independently', async (t) => {
  const fixture = await orderEditFixture(t);
  const { f, admin, installed, call, mutations } = fixture;
  const order = await fixture.order();
  const target = { connectionId: installed.id, orderId: order.gid };
  await call(f.member, 'inspect', target, 403);
  await call(f.outsider, 'inspect', target, 404);
  await call(null, 'inspect', target, 401);

  const inspected = await call(f.owner, 'inspect', target);
  assert.ok(inspected.granted.includes('orders.quantity.edit'));
  assert.equal(inspected.authority.connectionId, installed.id);
  assert.deepEqual(
    inspected.snapshot.lines.map((line) => line.currentQuantity),
    [3, 1],
  );
  await call(
    f.owner,
    'preview',
    {
      ...target,
      requestId: randomUUID(),
      change: {
        lines: [{ lineItemId: order.lines[0], quantity: -1 }],
        restock: true,
      },
    },
    422,
  );
  const change = {
    lines: [{ lineItemId: order.lines[0], quantity: 1 }],
    restock: true,
  };
  const preview = await call(f.owner, 'preview', {
    ...target,
    requestId: randomUUID(),
    change,
  });
  assert.equal(preview.state, 'approval_required');
  assert.deepEqual(preview.lines, [
    { lineItemId: order.lines[0], currentQuantity: 3, quantity: 1 },
  ]);
  // Shopify calculated the money consequences without committing anything.
  assert.equal(Number(preview.before.totals.subtotal.shop.amount), 90);
  assert.equal(Number(preview.calculation.subtotal.shop.amount), 50);
  assert.equal(fixture.commits(), 0);
  assert.equal(await unfulfilled(fixture, order, order.lines[0]), 3);

  const decision = async (user) =>
    (
      await f.request(user, `${f.base}/decisions?domain=orders&scope=all`)
    ).items.find((item) => item.kind === 'order_edit');
  const pending = await decision(admin);
  assert.equal(pending.reason, 'approval');
  assert.equal(pending.response, 'decide');
  assert.deepEqual(pending.owner, {
    kind: 'app_order',
    appId: 'shopify',
    connectionId: installed.id,
    orderId: order.gid,
  });
  assert.ok(pending.change.some((fact) => fact.value === '3 → 1'));
  assert.equal((await decision(f.owner)).response, 'awaiting_other');
  assert.equal(await decision(f.member), undefined);

  await call(f.owner, 'execute', { id: preview.id }, 409);
  await call(f.owner, 'approve', { id: preview.id, outcome: 'approved' }, 409);
  await call(admin, 'approve', { id: preview.id, outcome: 'approved' });
  await call(admin, 'execute', { id: preview.id }, 403);
  const results = await Promise.all([
    call(f.owner, 'execute', { id: preview.id }),
    call(f.owner, 'execute', { id: preview.id }),
  ]);
  assert.equal(fixture.commits(), 1);
  const commit = mutations.find((body) =>
    body.query.includes('orderEditCommit'),
  );
  assert.equal(commit.variables.staffNote, `luma-oe:${preview.id}`);
  assert.match(commit.query, /notifyCustomer: false/);
  assert.ok(results.some((result) => result.acceptance === 'accepted'));
  const verified = await call(f.owner, 'check', { id: preview.id });
  assert.equal(verified.state, 'verified');
  assert.equal(await unfulfilled(fixture, order, order.lines[0]), 1);
  assert.equal(fixture.commits(), 1);

  const evidence = await f.db.owner.query(
    'SELECT kind,document FROM shopify_order_edit_evidence WHERE tenant_id=$1',
    [f.org.id],
  );
  for (const kind of ['observation', 'calculation', 'acceptance'])
    assert.ok(
      evidence.rows.some((row) => row.kind === kind),
      kind,
    );
  for (const { kind, document } of evidence.rows) {
    assert.equal(document.adapterVersion, 'shopify-order-edit/1', kind);
    if (kind === 'acceptance')
      assert.match(document.dispatchIdentity, /shopify-order-edit\/1/);
    else assert.ok(['complete', 'partial'].includes(document.completeness));
  }
  const audit = await f.db.owner.query(
    "SELECT document->>'eventType' AS event FROM audit_entries WHERE tenant_id=$1 AND document->>'proposalId'=$2",
    [f.org.id, preview.id],
  );
  assert.ok(audit.rows.some((row) => row.event === 'execution.completed'));
  const hints = await f.db.owner.query(
    'SELECT capabilities FROM connector_refresh_hints WHERE tenant_id=$1 AND connection_id=$2',
    [f.org.id, installed.id],
  );
  assert.ok(hints.rows.length > 0);
  // A verified edit releases the order for the next one.
  const next = await call(f.owner, 'preview', {
    ...target,
    requestId: randomUUID(),
    change: {
      lines: [{ lineItemId: order.lines[1], quantity: 2 }],
      restock: false,
    },
  });
  assert.equal(next.state, 'approval_required');
  assert.equal(Number(next.calculation.subtotal.shop.amount), 80);
});

test('started fulfillment and observe-only send nothing to Shopify', async (t) => {
  const fixture = await orderEditFixture(t);
  const { f, admin, installed, call } = fixture;
  const order = await fixture.order();
  const target = { connectionId: installed.id, orderId: order.gid };
  await fixture.command({
    kind: 'fulfill',
    order: order.id,
    lines: [{ lineItem: order.lines[0].split('/').at(-1), quantity: 1 }],
    carrier: 'DHL',
    trackingNumber: '123',
    trackingUrl: 'https://tracking.example/123',
  });
  const before = fixture.mutations.length;
  await call(
    f.owner,
    'preview',
    {
      ...target,
      requestId: randomUUID(),
      change: {
        lines: [{ lineItemId: order.lines[0], quantity: 1 }],
        restock: true,
      },
    },
    409,
  );
  assert.equal(fixture.mutations.length, before);

  const settings = await f.request(f.owner, `${f.base}/settings`);
  await f.request(
    f.owner,
    `${f.base}/settings/write-mode`,
    'PATCH',
    f.command({
      revision: settings.workspace.revision,
      writeMode: 'observe_only',
    }),
  );
  const fresh = await fixture.order();
  const preview = await call(f.owner, 'preview', {
    connectionId: installed.id,
    orderId: fresh.gid,
    requestId: randomUUID(),
    change: {
      lines: [{ lineItemId: fresh.lines[1], quantity: 0 }],
      restock: true,
    },
  });
  assert.equal(preview.observeOnly, true);
  assert.equal(preview.calculation, null);
  assert.equal(preview.canApprove, false);
  await call(admin, 'approve', { id: preview.id, outcome: 'approved' }, 409);
  const recorded = await call(f.owner, 'execute', { id: preview.id });
  assert.equal(recorded.observeOnly, true);
  assert.equal(recorded.acceptance, 'not_sent');
  assert.equal(fixture.mutations.length, before);
  const executions = await f.db.owner.query(
    'SELECT count(*)::int AS count FROM executed_actions WHERE tenant_id=$1',
    [f.org.id],
  );
  assert.equal(executions.rows[0].count, 0);
});

test('a changed order withholds the edit and a lost commit is reconciled without a second commit', async (t) => {
  const fixture = await orderEditFixture(t);
  const { f, admin, installed, call } = fixture;
  const order = await fixture.order();
  const target = { connectionId: installed.id, orderId: order.gid };
  const change = {
    lines: [{ lineItemId: order.lines[0], quantity: 2 }],
    restock: false,
  };
  const stale = await call(f.owner, 'preview', {
    ...target,
    requestId: randomUUID(),
    change,
  });
  await call(admin, 'approve', { id: stale.id, outcome: 'approved' });
  // A merchant changes the order in Shopify after approval.
  await fixture.command({
    kind: 'order-edit',
    order: order.id,
    lines: [{ lineItem: order.lines[1].split('/').at(-1), quantity: 0 }],
  });
  await call(f.owner, 'execute', { id: stale.id }, 409);
  assert.equal(fixture.commits(), 0);
  const refreshed = await call(f.owner, 'check', { id: stale.id });
  assert.equal(refreshed.state, 'denied');
  assert.equal(refreshed.denial, 'changed');

  const lost = await call(f.owner, 'preview', {
    ...target,
    requestId: randomUUID(),
    change,
  });
  await call(admin, 'approve', { id: lost.id, outcome: 'approved' });
  fixture.loseCommitResponse();
  const unknown = await call(f.owner, 'execute', { id: lost.id });
  assert.equal(unknown.state, 'uncertain');
  assert.equal(unknown.acceptance, 'unknown');
  assert.equal(fixture.commits(), 1);
  // Retrying never sends the commit again, and another edit waits for reconciliation.
  await call(f.owner, 'execute', { id: lost.id });
  await call(
    f.owner,
    'preview',
    {
      ...target,
      requestId: randomUUID(),
      change: {
        lines: [{ lineItemId: order.lines[0], quantity: 1 }],
        restock: false,
      },
    },
    409,
  );
  const reconciled = await call(f.owner, 'check', { id: lost.id });
  assert.equal(reconciled.state, 'verified');
  assert.equal(fixture.commits(), 1);
  assert.equal(await unfulfilled(fixture, order, order.lines[0]), 2);
  const audit = await f.db.owner.query(
    "SELECT document->>'eventType' AS event FROM audit_entries WHERE tenant_id=$1 AND document->>'proposalId'=$2",
    [f.org.id, lost.id],
  );
  assert.ok(audit.rows.some((row) => row.event === 'execution.reconciled'));
});

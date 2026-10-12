import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { test, vi } from 'vitest';

import { nativeStockFixture } from './native-stock-fixture.mjs';

/** This publication gate is confined to the synthetic pilot's exact owned warehouse. */
test('native stock publication requires exact reviewed scope and approval, dispatches once and independently verifies storage and eligibility', async (t) => {
  const f = await nativeStockFixture(t);
  const target = {
    positionId: f.snapshot.document.entityId,
    connectionId: f.installed.id,
    sourceConnectionId: f.installed.id,
    nativeAllocation: { available: 5 },
  };
  const preview = await f.call(f.f.owner, 'preview', {
    ...target,
    requestId: randomUUID(),
  });
  assert.equal(preview.state, 'approval_required');
  assert.equal(preview.before.source.available, 5);
  assert.equal(preview.before.source.nativeAllocation.scope.mode, 'own');
  assert.equal(preview.before.source.nativeAllocation.available, '12');
  await f.call(f.f.owner, 'execute', { id: preview.id }, 409);
  await f.call(
    f.f.owner,
    'approve',
    { id: preview.id, outcome: 'approved' },
    409,
  );
  const approved = await f.call(f.approverUser, 'approve', {
    id: preview.id,
    outcome: 'approved',
  });
  assert.equal(approved.approved, true);
  const accepted = await f.call(f.f.owner, 'execute', { id: preview.id });
  assert.equal(accepted.acceptance, 'accepted');
  assert.equal(f.mutations.length, 1);
  assert.equal(
    (await f.call(f.f.owner, 'preview', { ...target, requestId: preview.id }))
      .id,
    preview.id,
  );
  const checked = await f.call(f.f.owner, 'check', { id: preview.id });
  assert.equal(checked.state, 'verified');
  await f.call(f.f.owner, 'execute', { id: preview.id });
  assert.equal(f.mutations.length, 1);
  const marker = (
    await f.f.db.owner.query(
      'SELECT * FROM shopify_native_stock_replicas WHERE tenant_id=$1 AND run_id=$2',
      [f.owner.tenantId, preview.id],
    )
  ).rows[0];
  assert.equal(marker.location_id, f.base.locationId);
  assert.equal(marker.scope_version, '3');
  await f.call(f.f.outsider, 'check', { id: preview.id }, 404);
  await f.stockRead(false);
  const replica = await f.store.transaction(f.owner, (tx) =>
    tx.stockEvidence(f.snapshot.id),
  );
  assert.equal(replica.channelReplica, true);
  await assert.rejects(
    f.ledger.reconcile(f.owner, {
      id: randomUUID(),
      key: randomUUID(),
      snapshotId: replica.snapshotId,
    }),
    (error) => error.code === 'review_required',
  );
  await assert.rejects(
    f.native.ownership.prepare(f.owner, {
      id: randomUUID(),
      key: randomUUID(),
      connectionId: f.installed.id,
      locationId: f.base.locationId,
      version: f.own.result.version,
      to: 'observe',
      reason: 'Return the full baseline',
    }),
    (error) => error.code === 'review_required',
  );
  await f.sales.edit(f.owner, f.orderId, {
    commandId: randomUUID(),
    version: f.record.version,
    status: 'cancelled',
  });
  await f.runShopify({
    kind: 'cancel',
    order: f.rawOrder.id,
    reason: 'CUSTOMER',
  });
  await f.stockRead(false);
  const restore = await f.call(f.f.owner, 'preview', {
    ...target,
    nativeAllocation: { available: 12 },
    requestId: randomUUID(),
  });
  await f.call(f.approverUser, 'approve', {
    id: restore.id,
    outcome: 'approved',
  });
  await f.call(f.f.owner, 'execute', { id: restore.id });
  assert.equal(
    (await f.call(f.f.owner, 'check', { id: restore.id })).state,
    'verified',
  );
  await f.stockRead(false);
  const handback = await f.native.ownership.prepare(f.owner, {
    id: randomUUID(),
    key: randomUUID(),
    connectionId: f.installed.id,
    locationId: f.base.locationId,
    version: f.own.result.version,
    to: 'observe',
    reason: 'Hand back the independently aligned baseline',
  });
  assert.ok(
    handback.binding.pools.every(
      (pool) => pool.comparisonId === null && pool.channelHandover,
    ),
  );
  await f.native.ownership.review(f.admin, handback.id, true);
  assert.equal(
    (await f.native.ownership.apply(f.owner, handback.id)).mode,
    'observe',
  );
});

test('native allocation previews reject excess, fractional and observed-only scope, and changed ledger versions invalidate approval', async (t) => {
  const f = await nativeStockFixture(t);
  const target = {
    positionId: f.snapshot.document.entityId,
    connectionId: f.installed.id,
    sourceConnectionId: f.installed.id,
    nativeAllocation: { available: 5 },
  };
  await f.call(
    f.f.owner,
    'preview',
    { ...target, nativeAllocation: { available: 13 }, requestId: randomUUID() },
    409,
  );
  await f.call(
    f.f.owner,
    'preview',
    {
      ...target,
      nativeAllocation: { available: 1.5 },
      requestId: randomUUID(),
    },
    422,
  );
  const preview = await f.call(f.f.owner, 'preview', {
    ...target,
    requestId: randomUUID(),
  });
  await f.call(f.approverUser, 'approve', {
    id: preview.id,
    outcome: 'approved',
  });
  const accounts = await f.store.transaction(f.owner, (tx) =>
    tx.accounts(
      [
        { ...f.base, state: 'available' },
        { ...f.base, state: 'held' },
      ],
      false,
    ),
  );
  await f.ledger.post(f.owner, {
    id: randomUUID(),
    key: randomUUID(),
    purpose: 'movement',
    reason: 'Hold one unit before dispatch',
    effectiveAt: null,
    evidence: [],
    postings: [
      { account: { ...f.base, state: 'available' }, quantity: '-1' },
      { account: { ...f.base, state: 'held' }, quantity: '1' },
    ],
    expected: accounts.map((account) => ({
      account: account.address,
      balance: account.balance,
      version: account.version,
    })),
  });
  await f.call(f.f.owner, 'execute', { id: preview.id }, 409);
  assert.equal(f.mutations.length, 0);
});

test('lost publication responses retain uncertainty and independent checks never replay the mutation', async (t) => {
  const f = await nativeStockFixture(t);
  const target = {
    positionId: f.snapshot.document.entityId,
    connectionId: f.installed.id,
    sourceConnectionId: f.installed.id,
    nativeAllocation: { available: 5 },
  };
  const preview = await f.call(f.f.owner, 'preview', {
    ...target,
    requestId: randomUUID(),
  });
  await f.call(f.approverUser, 'approve', {
    id: preview.id,
    outcome: 'approved',
  });
  f.loseResponse();
  const uncertain = await f.call(f.f.owner, 'execute', { id: preview.id });
  assert.equal(uncertain.state, 'uncertain');
  assert.equal(f.mutations.length, 1);
  await f.call(f.f.owner, 'check', { id: preview.id });
  await f.call(f.f.owner, 'execute', { id: preview.id });
  assert.equal(f.mutations.length, 1);
  assert.equal(
    (
      await f.f.db.owner.query(
        'SELECT count(*)::int count FROM shopify_native_stock_replicas WHERE tenant_id=$1',
        [f.owner.tenantId],
      )
    ).rows[0].count,
    1,
  );
});

test('observe-only retains the native preview without dispatch or a channel-role marker', async (t) => {
  const f = await nativeStockFixture(t);
  const settings = await f.f.request(f.f.owner, `${f.f.base}/settings`);
  await f.f.request(f.f.owner, `${f.f.base}/settings/write-mode`, 'PATCH', {
    commandId: randomUUID(),
    revision: settings.workspace.revision,
    writeMode: 'observe_only',
  });
  const target = {
    positionId: f.snapshot.document.entityId,
    connectionId: f.installed.id,
    sourceConnectionId: f.installed.id,
    nativeAllocation: { available: 5 },
  };
  const preview = await f.call(f.f.owner, 'preview', {
    ...target,
    requestId: randomUUID(),
  });
  assert.equal(preview.observeOnly, true);
  await f.call(f.f.owner, 'execute', { id: preview.id });
  assert.equal(f.mutations.length, 0);
  assert.equal(
    (
      await f.f.db.owner.query(
        'SELECT count(*)::int count FROM shopify_inventory_claims WHERE tenant_id=$1 AND NOT settled',
        [f.owner.tenantId],
      )
    ).rows[0].count,
    0,
  );
  assert.equal(
    (
      await f.f.db.owner.query(
        'SELECT count(*)::int count FROM shopify_native_stock_replicas WHERE tenant_id=$1',
        [f.owner.tenantId],
      )
    ).rows[0].count,
    0,
  );
});

test('publishing stored quantity at an inactive inventory item leaves activation untouched and verifies it independently', async (t) => {
  const f = await nativeStockFixture(t);
  const level = await f.providerStore.get('InventoryLevel', '1.1');
  await f.providerStore.put('InventoryLevel', '1.1', {
    ...level.data,
    isActive: false,
  });
  const target = {
    positionId: f.snapshot.document.entityId,
    connectionId: f.installed.id,
    sourceConnectionId: f.installed.id,
    nativeAllocation: { available: 5 },
  };
  const preview = await f.call(f.f.owner, 'preview', {
    ...target,
    requestId: randomUUID(),
  });
  assert.equal(preview.before.itemActive, false);
  assert.equal(preview.before.locationActive, true);
  await f.call(f.approverUser, 'approve', {
    id: preview.id,
    outcome: 'approved',
  });
  await f.call(f.f.owner, 'execute', { id: preview.id });
  assert.equal(
    (await f.call(f.f.owner, 'check', { id: preview.id })).state,
    'verified',
  );
  assert.equal(
    (await f.providerStore.get('InventoryLevel', '1.1')).data.isActive,
    false,
  );
  assert.equal(f.mutations.length, 1);
  assert.ok(
    f.mutations.every((mutation) =>
      mutation.query.includes('inventorySetQuantities'),
    ),
  );
});

test('the native dispatch fence holds stock versions until the provider attempt finishes', async (t) => {
  let entered, proceed;
  const dispatched = new Promise((resolve) => {
    entered = resolve;
  });
  const release = new Promise((resolve) => {
    proceed = resolve;
  });
  const f = await nativeStockFixture(t, {
    beforeShopifyRequest: async (body) => {
      if (body.query.startsWith('mutation')) {
        entered();
        await release;
      }
    },
  });
  const target = {
    positionId: f.snapshot.document.entityId,
    connectionId: f.installed.id,
    sourceConnectionId: f.installed.id,
    nativeAllocation: { available: 5 },
  };
  const preview = await f.call(f.f.owner, 'preview', {
    ...target,
    requestId: randomUUID(),
  });
  await f.call(f.approverUser, 'approve', {
    id: preview.id,
    outcome: 'approved',
  });
  const dispatch = f.call(f.f.owner, 'execute', { id: preview.id });
  await dispatched;
  const accounts = await f.store.transaction(f.owner, (tx) =>
    tx.accounts(
      [
        { ...f.base, state: 'available' },
        { ...f.base, state: 'held' },
      ],
      false,
    ),
  );
  let finished = false;
  const movement = f.ledger
    .post(f.owner, {
      id: randomUUID(),
      key: randomUUID(),
      purpose: 'movement',
      reason: 'Hold after a pending publication',
      effectiveAt: null,
      evidence: [],
      postings: [
        { account: { ...f.base, state: 'available' }, quantity: '-1' },
        { account: { ...f.base, state: 'held' }, quantity: '1' },
      ],
      expected: accounts.map((account) => ({
        account: account.address,
        balance: account.balance,
        version: account.version,
      })),
    })
    .then((value) => {
      finished = true;

      return value;
    });
  try {
    await vi.waitFor(
      async () => {
        const waiting = (
          await f.f.db.owner.query(
            "SELECT count(*)::int count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%inventory_ledger_accounts%'",
          )
        ).rows[0].count;
        assert.ok(waiting > 0);
      },
      { timeout: 5000 },
    );
    assert.equal(finished, false);
  } finally {
    proceed();
  }
  await dispatch;
  await movement;
  assert.equal(f.mutations.length, 1);
});

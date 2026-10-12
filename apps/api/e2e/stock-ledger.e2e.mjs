import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createInventoryLedgerRuntime } from '@luma/application-runtime';
import { test } from 'vitest';

import { stockItem, stockLocation } from './shopify-inventory-fixture.mjs';
import { ledgerFixture as fixture } from './stock-ledger-fixture.mjs';

test('reviewed openings and exact retry receipts survive service restart and retain an immutable balanced journal', async (t) => {
  const f = await fixture(t);
  const input = {
    id: randomUUID(),
    key: randomUUID(),
    snapshotId: f.snapshot.id,
    reason: 'Reviewed source opening',
    balances: { available: '12' },
  };
  const review = await f.ledger.prepareOpening(f.owner, input);
  await assert.rejects(
    f.ledger.postReviewed(f.owner, review.id),
    (error) => error.code === 'review_required',
  );
  await assert.rejects(
    f.ledger.review(f.owner, review.id, true),
    (error) => error.code === 'review_required',
  );
  await f.ledger.review(f.admin, review.id, true);
  const opening = await f.ledger.postReviewed(f.owner, review.id);
  assert.equal(
    opening.accounts.find((a) => a.address.state === 'available').balance,
    '12',
  );
  assert.equal(
    opening.accounts.find((a) => a.address.state === 'adjustment').balance,
    '-12',
  );
  const restarted = createInventoryLedgerRuntime(f.db, f.f.identity.service);
  assert.deepEqual(await restarted.postReviewed(f.owner, review.id), opening);
  await assert.rejects(
    f.ledger.prepareOpening(f.owner, { ...input, reason: 'Different body' }),
    (error) => error.code === 'changed_command',
  );
  const base = {
    skuId: f.snapshot.document.data.skuId,
    locationId: f.snapshot.document.data.locationId,
    unit: 'each',
  };
  const available = { ...base, state: 'available' },
    reserved = { ...base, state: 'reserved' };
  const accounts = await f.store.transaction(f.owner, (tx) =>
    tx.accounts([available, reserved], false),
  );
  const movement = {
    id: randomUUID(),
    key: randomUUID(),
    purpose: 'reservation',
    reason: 'Exact owner allocation',
    effectiveAt: null,
    evidence: [],
    postings: [
      { account: available, quantity: '-3.125001' },
      { account: reserved, quantity: '3.125001' },
    ],
    expected: accounts.map((a) => ({
      account: a.address,
      balance: a.balance,
      version: a.version,
    })),
  };
  const result = await f.ledger.post(f.owner, movement);
  assert.equal(
    result.accounts.find((a) => a.address.state === 'available').balance,
    '8.874999',
  );
  assert.equal(
    result.accounts.find((a) => a.address.state === 'reserved').balance,
    '3.125001',
  );
  assert.deepEqual(await restarted.post(f.owner, movement), result);
  await assert.rejects(
    f.ledger.post(f.owner, {
      ...movement,
      id: randomUUID(),
      key: randomUUID(),
    }),
    (error) => error.code === 'stale',
  );
  await assert.rejects(
    f.ledger.post(f.owner, { ...movement, reason: 'Changed retry' }),
    (error) => error.code === 'changed_command',
  );
  const prior = await f.ledger.historical(f.owner, {
    account: available,
    effectiveAt: new Date().toISOString(),
    recordedAt: opening.recordedAt,
    maximumVersion: '999',
  });
  assert.equal(prior.knownQuantity, '12');
  assert.equal(prior.unknownQuantity, '0');
  const unknown = await f.ledger.historical(f.owner, {
    account: available,
    effectiveAt: new Date().toISOString(),
    recordedAt: new Date().toISOString(),
    maximumVersion: '2',
  });
  assert.equal(unknown.knownQuantity, '12');
  assert.equal(unknown.unknownQuantity, '-3.125001');
  const reversal = await f.ledger.prepareReversal(f.owner, {
    id: randomUUID(),
    key: randomUUID(),
    entryId: result.entryId,
    reason: 'Cancelled allocation',
    effectiveAt: new Date().toISOString(),
  });
  await f.ledger.review(f.admin, reversal.id, true);
  const reversed = await f.ledger.postReviewed(f.owner, reversal.id);
  assert.equal(
    reversed.accounts.find((a) => a.address.state === 'available').balance,
    '12',
  );
  assert.deepEqual(
    await restarted.postReviewed(f.owner, reversal.id),
    reversed,
  );
  await assert.rejects(
    f.ledger.prepareReversal(f.owner, {
      id: randomUUID(),
      key: randomUUID(),
      entryId: result.entryId,
      reason: 'Duplicate reversal',
      effectiveAt: null,
    }),
    (error) => error.code === 'already_reversed',
  );
  await assert.rejects(
    f.ledger.reconcile(f.owner, {
      id: randomUUID(),
      key: randomUUID(),
      snapshotId: f.snapshot.id,
    }),
    (error) => error.code === 'evidence_stale',
  );
  await f.changeAvailable(15);
  await f.syncRecords('inventory.read', {
    limit: 100,
    sku: { externalId: stockItem, scopeKey: '' },
    location: { externalId: stockLocation, scopeKey: '' },
    includeComposition: true,
  });
  const latest = (
    await f.f.db.owner.query(
      'SELECT snapshot_id FROM inventory_projections WHERE tenant_id=$1 AND connection_id=$2 AND entity_id=$3',
      [f.f.org.id, f.installed.id, f.snapshot.document.entityId],
    )
  ).rows[0];
  const comparisonInput = {
    id: randomUUID(),
    key: randomUUID(),
    snapshotId: latest.snapshot_id,
  };
  const comparison = await f.ledger.reconcile(f.owner, comparisonInput);
  assert.equal(comparison.nativeQuantity, '12');
  assert.equal(comparison.driftQuantity, '3');
  assert.deepEqual(
    await restarted.reconcile(f.owner, comparisonInput),
    comparison,
  );
  const candidates = await f.ledger.aging(f.owner, {
    before: new Date().toISOString(),
    limit: 20,
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].kind, 'drift');
  assert.equal(candidates[0].entryId, comparison.entryId);
  const physical = await f.store.transaction(f.owner, (tx) =>
    tx.pool(base.skuId, base.locationId, base.unit, false),
  );
  assert.equal(
    physical.find((a) => a.address.state === 'available').balance,
    '12',
  );
  await f.syncStock();
  const incomplete = (
    await f.f.db.owner.query(
      'SELECT snapshot_id FROM inventory_projections WHERE tenant_id=$1 AND connection_id=$2 AND entity_id=$3',
      [f.f.org.id, f.installed.id, f.snapshot.document.entityId],
    )
  ).rows[0];
  await assert.rejects(
    f.ledger.reconcile(f.owner, {
      id: randomUUID(),
      key: randomUUID(),
      snapshotId: incomplete.snapshot_id,
    }),
    (error) => error.code === 'source_incomplete',
  );
  assert.equal(
    (
      await f.f.db.owner.query(
        'SELECT count(*)::int AS count FROM inventory_shadow_reconciliations WHERE tenant_id=$1',
        [f.f.org.id],
      )
    ).rows[0].count,
    1,
  );

  const rows = (
    await f.f.db.owner.query(
      'SELECT sku_id,unit,sum(quantity)::text AS balance,count(*)::int AS postings FROM inventory_ledger_postings WHERE tenant_id=$1 GROUP BY entry_id,sku_id,unit',
      [f.f.org.id],
    )
  ).rows;
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.equal(Number(row.balance), 0);
    assert.equal(row.postings, 2);
  }
  assert.equal(f.mutations.length, 0);
  // Restricted runtime roles cannot change a balance outside its version-linked posting.
  await assert.rejects(
    f.db.transaction(f.owner.tenantId, (tx) =>
      tx.query(
        'UPDATE inventory_ledger_accounts SET balance=999,version=version+1 WHERE tenant_id=$1 AND id=$2',
        [f.owner.tenantId, result.accounts[0].id],
      ),
    ),
    (error) => error.code === '23514',
  );
  await assert.rejects(
    f.db.transaction(f.owner.tenantId, (tx) =>
      tx.query(
        'DELETE FROM inventory_ledger_entries WHERE tenant_id=$1 AND id=$2',
        [f.owner.tenantId, opening.entryId],
      ),
    ),
    (error) => error.code === '42501' || error.code === '23514',
  );
  // Even an owner-level accidental edit cannot rewrite the retained posting.
  await assert.rejects(
    f.db.transaction(f.owner.tenantId, (tx) =>
      tx.query(
        'INSERT INTO inventory_ledger_postings(tenant_id,entry_id,account_id,sku_id,unit,account_version,quantity,balance_before,balance_after) VALUES($1,$2,$3,$4,$5,2,1,12,13)',
        [
          f.owner.tenantId,
          opening.entryId,
          opening.accounts.find((a) => a.address.state === 'available').id,
          base.skuId,
          base.unit,
        ],
      ),
    ),
    (error) => error.code === '23514',
  );
  await assert.rejects(
    f.f.db.owner.query(
      'UPDATE inventory_ledger_postings SET quantity=5 WHERE tenant_id=$1 AND entry_id=$2',
      [f.owner.tenantId, opening.entryId],
    ),
    (error) => error.code === '23514',
  );
  const outside = await f.f.request(
    f.f.owner,
    '/v1/organizations',
    'POST',
    {
      name: 'Other ledger tenant',
      slug: `other-ledger-${randomUUID().slice(0, 8)}`,
    },
    201,
  );
  const other = await f.f.identity.service.resolveWorkflowContext(
    f.f.owner.id,
    outside.id,
    randomUUID(),
  );
  assert.equal(
    await f.store.transaction(other, (tx) => tx.review(review.id)),
    null,
  );
});

test('busy SKU retries cannot oversell and checkpoint history retains explicit version knowledge', async (t) => {
  const f = await fixture(t);
  const review = await f.ledger.prepareOpening(f.owner, {
    id: randomUUID(),
    key: randomUUID(),
    snapshotId: f.snapshot.id,
    reason: 'Concurrency baseline',
    balances: { available: '12' },
  });
  await f.ledger.review(f.admin, review.id, true);
  await f.ledger.postReviewed(f.owner, review.id);
  const base = {
    skuId: f.snapshot.document.data.skuId,
    locationId: f.snapshot.document.data.locationId,
    unit: 'each',
  };
  const available = { ...base, state: 'available' },
    reserved = { ...base, state: 'reserved' };
  let next = 0,
    stale = 0;
  const durations = [];
  const start = performance.now();
  await Promise.all(
    Array.from({ length: 12 }, async () => {
      while (next < 100) {
        next++;
        const id = randomUUID(),
          key = randomUUID(),
          began = performance.now();
        let committed = false;
        for (let attempt = 0; attempt < 100 && !committed; attempt++) {
          const accounts = await f.store.transaction(f.owner, (tx) =>
            tx.accounts([available, reserved], false),
          );
          try {
            await f.ledger.post(f.owner, {
              id,
              key,
              purpose: 'reservation',
              reason: 'Concurrent exact allocation',
              effectiveAt: null,
              evidence: [],
              postings: [
                { account: available, quantity: '-0.01' },
                { account: reserved, quantity: '0.01' },
              ],
              expected: accounts.map((a) => ({
                account: a.address,
                balance: a.balance,
                version: a.version,
              })),
            });
            committed = true;
          } catch (error) {
            if (error.code !== 'stale') throw error;
            stale++;
          }
        }
        assert.equal(committed, true, 'bounded stale retries converge');
        durations.push(performance.now() - began);
      }
    }),
  );
  const elapsed = performance.now() - start;
  const accounts = await f.store.transaction(f.owner, (tx) =>
    tx.accounts([available, reserved], false),
  );
  assert.equal(
    accounts.find((a) => a.address.state === 'available').balance,
    '11',
  );
  assert.equal(
    accounts.find((a) => a.address.state === 'reserved').balance,
    '1',
  );
  const historical = await f.ledger.historical(f.owner, {
    account: available,
    effectiveAt: new Date().toISOString(),
    recordedAt: new Date().toISOString(),
    maximumVersion: '100',
  });
  assert.equal(historical.knownQuantity, '12');
  assert.equal(historical.unknownQuantity, '-0.99');
  assert.equal(historical.recordedVersion, '100');
  const checkpoints = (
    await f.f.db.owner.query(
      'SELECT count(*)::int AS count FROM inventory_ledger_checkpoints WHERE tenant_id=$1',
      [f.f.org.id],
    )
  ).rows[0];
  assert.equal(checkpoints.count, 2);
  const current = accounts.find((a) => a.address.state === 'available');
  await assert.rejects(
    f.ledger.post(f.owner, {
      id: randomUUID(),
      key: randomUUID(),
      purpose: 'reservation',
      reason: 'Cannot oversell',
      effectiveAt: null,
      evidence: [],
      postings: [
        { account: available, quantity: '-11.000001' },
        { account: reserved, quantity: '11.000001' },
      ],
      expected: accounts.map((a) => ({
        account: a.address,
        balance: a.balance,
        version: a.version,
      })),
    }),
    (error) => error.code === 'insufficient_stock',
  );
  assert.equal(
    (
      await f.store.transaction(f.owner, (tx) =>
        tx.accounts([available], false),
      )
    )[0].version,
    current.version,
  );
  durations.sort((a, b) => a - b);
  process.stdout.write(
    JSON.stringify({
      measurement: 'restricted-role ledger, 12 clients, one SKU, 100 commands',
      commands: 100,
      elapsedMs: Math.round(elapsed),
      commandsPerSecond: Math.round(100000 / elapsed),
      staleRetries: stale,
      p50Ms: Math.round(durations[49]),
      p95Ms: Math.round(durations[94]),
      providerWrites: f.mutations.length,
    }) + '\n',
  );
  assert.equal(f.mutations.length, 0);
});

test('reviewed corrections retain source bindings and reject stock changed after approval', async (t) => {
  const f = await fixture(t);
  const opening = await f.ledger.prepareOpening(f.owner, {
    id: randomUUID(),
    key: randomUUID(),
    snapshotId: f.snapshot.id,
    reason: 'Correction baseline',
    balances: { available: '12' },
  });
  await f.ledger.review(f.admin, opening.id, true);
  await f.ledger.postReviewed(f.owner, opening.id);
  const base = {
    skuId: f.snapshot.document.data.skuId,
    locationId: f.snapshot.document.data.locationId,
    unit: 'each',
  };
  const available = { ...base, state: 'available' },
    loss = { ...base, state: 'loss' },
    reserved = { ...base, state: 'reserved' };
  const selected = await f.store.transaction(f.owner, (tx) =>
    tx.accounts([available, loss], false),
  );
  const correction = {
    id: randomUUID(),
    key: randomUUID(),
    purpose: 'correction',
    reason: 'Reviewed damaged unit disposal',
    effectiveAt: null,
    evidence: [{ kind: 'observation', id: f.snapshot.document.observationId }],
    postings: [
      { account: available, quantity: '-1' },
      { account: loss, quantity: '1' },
    ],
    expected: selected.map((a) => ({
      account: a.address,
      balance: a.balance,
      version: a.version,
    })),
  };
  const review = await f.ledger.prepareChange(f.owner, correction, [
    f.snapshot.id,
  ]);
  await f.ledger.review(f.admin, review.id, true);
  const movementAccounts = await f.store.transaction(f.owner, (tx) =>
    tx.accounts([available, reserved], false),
  );
  await f.ledger.post(f.owner, {
    id: randomUUID(),
    key: randomUUID(),
    purpose: 'reservation',
    reason: 'Allocation after approval',
    effectiveAt: null,
    evidence: [],
    postings: [
      { account: available, quantity: '-1' },
      { account: reserved, quantity: '1' },
    ],
    expected: movementAccounts.map((a) => ({
      account: a.address,
      balance: a.balance,
      version: a.version,
    })),
  });
  await assert.rejects(
    f.ledger.postReviewed(f.owner, review.id),
    (error) => error.code === 'stale',
  );
  const current = await f.store.transaction(f.owner, (tx) =>
    tx.accounts([available, loss], false),
  );
  assert.equal(current.find((a) => a.address.state === 'loss').balance, '0');
  const replacement = await f.ledger.prepareChange(
    f.owner,
    {
      ...correction,
      id: randomUUID(),
      key: randomUUID(),
      expected: current.map((a) => ({
        account: a.address,
        balance: a.balance,
        version: a.version,
      })),
    },
    [f.snapshot.id],
  );
  await f.ledger.review(f.admin, replacement.id, true);
  const receipt = await f.ledger.postReviewed(f.owner, replacement.id);
  assert.equal(
    receipt.accounts.find((a) => a.address.state === 'available').balance,
    '10',
  );
  assert.equal(
    receipt.accounts.find((a) => a.address.state === 'loss').balance,
    '1',
  );
  assert.equal(f.mutations.length, 0);
});

test('a reviewed zero opening retains a receipt and baseline without zero postings', async (t) => {
  const f = await fixture(t);
  await f.changeAvailable(0);
  await f.syncRecords('inventory.read', {
    limit: 100,
    sku: { externalId: stockItem, scopeKey: '' },
    location: { externalId: stockLocation, scopeKey: '' },
    includeComposition: true,
  });
  const latest = (
    await f.f.db.owner.query(
      'SELECT snapshot_id FROM inventory_projections WHERE tenant_id=$1 AND connection_id=$2 AND entity_id=$3',
      [f.f.org.id, f.installed.id, f.snapshot.document.entityId],
    )
  ).rows[0];
  const review = await f.ledger.prepareOpening(f.owner, {
    id: randomUUID(),
    key: randomUUID(),
    snapshotId: latest.snapshot_id,
    reason: 'Reviewed empty warehouse',
    balances: {},
  });
  await f.ledger.review(f.admin, review.id, true);
  const receipt = await f.ledger.postReviewed(f.owner, review.id);
  assert.equal(receipt.entryId, null);
  assert.deepEqual(
    await createInventoryLedgerRuntime(f.db, f.f.identity.service).postReviewed(
      f.owner,
      review.id,
    ),
    receipt,
  );
  assert.equal(
    (
      await f.f.db.owner.query(
        'SELECT count(*)::int AS count FROM inventory_ledger_postings WHERE tenant_id=$1',
        [f.f.org.id],
      )
    ).rows[0].count,
    0,
  );
  assert.equal(
    (
      await f.f.db.owner.query(
        'SELECT count(*)::int AS count FROM inventory_ledger_openings WHERE tenant_id=$1',
        [f.f.org.id],
      )
    ).rows[0].count,
    1,
  );
  await assert.rejects(
    f.ledger.prepareOpening(f.owner, {
      id: randomUUID(),
      key: randomUUID(),
      snapshotId: latest.snapshot_id,
      reason: 'Duplicate baseline',
      balances: {},
    }),
    (error) => error.code === 'invalid_entry',
  );
  assert.equal(f.mutations.length, 0);
});

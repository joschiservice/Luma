import assert from 'node:assert/strict';

import { test } from 'vitest';

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
  const [receipt] = await f.receipts();
  assert.equal(receipt.document.adapterVersion, 'starshipit-update/1');
  assert.match(receipt.document.dispatchIdentity, /starshipit-update\/1$/);
  assert.deepEqual(receipt.document.records, [
    { resource: 'order', externalId: '1' },
    { resource: 'order_line', externalId: f.itemId },
  ]);
  const reads = await f.db.owner.query(
    "SELECT document FROM starshipit_order_update_evidence WHERE tenant_id=$1 AND document->>'kind'='observation'",
    [f.manifest.organizationId],
  );
  assert.ok(reads.rows.length > 0);
  for (const { document } of reads.rows) {
    assert.equal(document.adapterVersion, 'starshipit-update/1');
    assert.equal(document.completeness, 'complete');
  }
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

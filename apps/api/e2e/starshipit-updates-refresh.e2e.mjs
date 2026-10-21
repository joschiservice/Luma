import assert from 'node:assert/strict';

import { test } from 'vitest';

import { starshipitUpdatesFixture } from './starshipit-updates-fixture.mjs';

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

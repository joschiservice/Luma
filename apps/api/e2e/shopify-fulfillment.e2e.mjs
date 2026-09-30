import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { test } from 'vitest';

import { recoveryFixture } from './shopify-fulfillment-fixture.mjs';

const gid = (kind, value = 1) => `gid://shopify/${kind}/${value}`;

test('held Shopify order uses approval, one dispatch, and fresh business verification', async (t) => {
  const { f, admin, installed, fulfillment, mutations, loseResponse } =
    await recoveryFixture(t);
  const target = {
    connectionId: installed.id,
    orderId: gid('Order'),
    fulfillmentOrderId: gid('FulfillmentOrder'),
  };
  const base = `${f.base}/apps/shopify/fulfillment-recovery`;
  const call = (user, command, body, status = 200) =>
    f.request(user, `${base}-${command}`, 'POST', body, status);
  await call(f.member, 'inspect', target, 403);
  await call(f.outsider, 'inspect', target, 404);
  await call(null, 'inspect', target, 401);
  await call(
    f.owner,
    'inspect',
    { ...target, orderId: gid('Order', 999) },
    404,
  );
  const requestId = randomUUID();
  const preview = await call(f.owner, 'preview', {
    ...target,
    requestId,
    choice: {
      capability: 'fulfillment.hold.release',
      holdId: gid('FulfillmentHold'),
    },
  });
  assert.equal(preview.state, 'approval_required');
  assert.equal(preview.canExecute, false);
  assert.equal(mutations.length, 0);
  await call(f.owner, 'execute', { id: preview.id }, 409);
  await call(f.owner, 'approve', { id: preview.id, outcome: 'approved' }, 409);
  await call(admin, 'approve', { id: preview.id, outcome: 'approved' });
  await call(admin, 'execute', { id: preview.id }, 403);
  const results = await Promise.all([
    call(f.owner, 'execute', { id: preview.id }),
    call(f.owner, 'execute', { id: preview.id }),
  ]);
  assert.equal(mutations.length, 1);
  assert.equal(
    results.some((result) => result.acceptance === 'accepted'),
    true,
  );
  const accepted = await call(f.owner, 'check', { id: preview.id });
  assert.equal(accepted.state, 'recovery_required');
  assert.equal(accepted.acceptance, 'accepted');
  assert.deepEqual(
    fulfillment.fulfillmentHolds.map((hold) => hold.id),
    [gid('FulfillmentHold', 2)],
  );
  fulfillment.fulfillmentHolds = [];
  fulfillment.status = 'IN_PROGRESS';
  fulfillment.lineItems.nodes[0].remainingQuantity = 1;
  const verified = await call(f.owner, 'check', { id: preview.id });
  assert.equal(verified.state, 'verified');
  assert.equal(mutations.length, 1);
  const evidence = await f.db.owner.query(
    'SELECT kind FROM shopify_fulfillment_evidence WHERE tenant_id=$1',
    [f.org.id],
  );
  assert.ok(evidence.rows.some((row) => row.kind === 'acceptance'));
  assert.ok(
    evidence.rows.filter((row) => row.kind === 'observation').length > 2,
  );

  fulfillment.status = 'ON_HOLD';
  fulfillment.fulfillmentHolds = [
    {
      id: gid('FulfillmentHold', 3),
      reason: 'OTHER',
      heldByRequestingApp: true,
    },
  ];
  const stale = await call(f.owner, 'preview', {
    ...target,
    requestId: randomUUID(),
    choice: {
      capability: 'fulfillment.hold.release',
      holdId: gid('FulfillmentHold', 3),
    },
  });
  await call(admin, 'approve', { id: stale.id, outcome: 'approved' });
  fulfillment.updatedAt = '2026-09-29T00:02:00Z';
  await call(f.owner, 'execute', { id: stale.id }, 409);
  assert.equal(mutations.length, 1);

  const lost = await call(f.owner, 'preview', {
    ...target,
    requestId: randomUUID(),
    choice: {
      capability: 'fulfillment.hold.release',
      holdId: gid('FulfillmentHold', 3),
    },
  });
  await call(admin, 'approve', { id: lost.id, outcome: 'approved' });
  loseResponse();
  const unknown = await call(f.owner, 'execute', { id: lost.id });
  assert.equal(unknown.state, 'uncertain');
  await call(f.owner, 'execute', { id: lost.id });
  await call(f.owner, 'check', { id: lost.id });
  assert.equal(mutations.length, 2);
  await call(
    f.owner,
    'preview',
    {
      ...target,
      requestId: randomUUID(),
      choice: {
        capability: 'fulfillment.hold.release',
        holdId: gid('FulfillmentHold', 3),
      },
    },
    409,
  );
  const isolated = new Pool({ connectionString: f.db.runtimeUrl });
  try {
    const connection = await isolated.connect();
    try {
      await connection.query('BEGIN');
      await connection.query("SELECT set_config('app.tenant_id',$1,true)", [
        randomUUID(),
      ]);
      for (const table of [
        'shopify_fulfillment_recoveries',
        'shopify_fulfillment_evidence',
        'shopify_fulfillment_claims',
      ]) {
        const rows = await connection.query(
          `SELECT count(*)::int AS count FROM ${table}`,
        );
        assert.equal(rows.rows[0].count, 0);
      }
      await connection.query('ROLLBACK');
    } finally {
      connection.release();
    }
  } finally {
    await isolated.end();
  }
  const audit = await f.db.owner.query(
    "SELECT document->>'eventType' AS event FROM audit_entries WHERE tenant_id=$1 AND document->>'proposalId'=$2",
    [f.org.id, preview.id],
  );
  assert.ok(audit.rows.some((row) => row.event === 'execution.completed'));
  assert.ok(audit.rows.some((row) => row.event === 'execution.reconciled'));
});

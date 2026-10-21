import assert from 'node:assert/strict';

import { test } from 'vitest';

import { shipmentPublishingFixture } from './shopify-shipment-publishing-fixture.mjs';

test('changed Shopify work and cancellation withhold approved publication without remote side effects', async (t) => {
  const f = await shipmentPublishingFixture(t),
    source = await f.dispatch(),
    preview = await f.preview(source);
  await f.call(
    'approve',
    { id: preview.id, outcome: 'approved' },
    { cookie: f.approver },
  );
  await f.command('shopify', { kind: 'hold', order: '1', reason: 'OTHER' });
  await f.call('execute', { id: preview.id }, { status: 409 });
  const before = await f.call('inspect', { ...f.target, source });
  assert.equal(before.snapshot.shipments.length, 0);
  await f.command('shopify', { kind: 'release', order: '1' });
  const next = await f.preview(source);
  await f.call(
    'approve',
    { id: next.id, outcome: 'approved' },
    { cookie: f.approver },
  );
  await f.command('shopify', {
    kind: 'cancel',
    order: '1',
    reason: 'CUSTOMER',
  });
  await f.call('execute', { id: next.id }, { status: 409 });
  assert.equal(
    (
      await f.db.owner.query(
        `SELECT count(*)::int AS count FROM shopify_shipment_evidence WHERE tenant_id=$1 AND kind='acceptance'`,
        [f.manifest.organizationId],
      )
    ).rows[0].count,
    0,
  );
}, 120_000);

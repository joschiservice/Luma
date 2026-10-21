import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { test } from 'vitest';

import { shipmentPublishingFixture } from './shopify-shipment-publishing-fixture.mjs';

test('physical downstream parcels use exact approval, partial Shopify fulfillment and independent tracking verification', async (t) => {
  const f = await shipmentPublishingFixture(t),
    source = await f.dispatch('PARCEL-1', 1, 'Printed');
  await f.call(
    'preview',
    { ...f.target, requestId: randomUUID(), choice: await f.choice(source) },
    { status: 409 },
  );
  await f.command('starshipit', {
    kind: 'tracking',
    order: '1',
    package: 1,
    status: 'In Transit',
    at: new Date().toISOString(),
  });
  await f.pilot.observe({ check: false });
  await f.call(
    'inspect',
    { ...f.target, source },
    { cookie: f.member, status: 403 },
  );
  const options = await f.call('sources', f.target);
  assert.equal(options.enabled, true);
  assert.ok(options.sources.some((s) => s.shipmentId === source.shipmentId));
  const preview = await f.preview(source);
  assert.equal(preview.state, 'approval_required');
  assert.equal(preview.choice.notifyCustomer, false);
  assert.equal(preview.before.dispatch.stage, 'carrier');
  await f.call('execute', { id: preview.id }, { status: 409 });
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
  const sent = await f.call('execute', { id: preview.id });
  assert.equal(sent.state, 'verified');
  assert.equal(sent.acceptance, 'accepted');
  assert.equal((await f.call('execute', { id: preview.id })).state, 'verified');
  const current = await f.call('inspect', { ...f.target, source });
  assert.equal(current.snapshot.shipments.length, 1);
  const shipment = current.snapshot.shipments[0];
  assert.deepEqual(
    shipment.lines,
    preview.choice.allocations.map((a) => ({
      orderLineId: a.orderLineId,
      quantity: a.quantity,
    })),
  );
  await f.call(
    'preview',
    { ...f.target, requestId: randomUUID(), choice: await f.choice(source) },
    { status: 409 },
  );
  const time = new Date().toISOString();
  await f.command('starshipit', {
    kind: 'tracking',
    order: '1',
    package: 1,
    status: 'Delivered',
    at: time,
    tracking_url: 'https://tracking.example.test/corrected',
  });
  await f.pilot.observe({ check: false });
  const inspected = await f.call('inspect', { ...f.target, source });
  const update = await f.call('preview', {
    ...f.target,
    requestId: randomUUID(),
    choice: {
      capability: 'fulfillment.tracking.update',
      source,
      fulfillmentId: shipment.id,
      allocationSource: 'operator',
      confirmedAllocation: {
        locationId: shipment.locationId,
        lines: shipment.lines,
      },
      notifyCustomer: true,
    },
  });
  assert.equal(update.state, 'approval_required');
  await f.call(
    'approve',
    { id: update.id, outcome: 'approved' },
    { cookie: f.approver },
  );
  assert.equal((await f.call('execute', { id: update.id })).state, 'verified');
  const receipts = await f.db.owner.query(
    `SELECT document FROM shopify_shipment_evidence WHERE tenant_id=$1 AND kind='acceptance'`,
    [f.manifest.organizationId],
  );
  assert.equal(receipts.rows.length, 2);
  for (const { document } of receipts.rows) {
    assert.equal(document.adapterVersion, 'shopify-fulfillment/1');
    assert.match(document.dispatchIdentity, /shopify-fulfillment\/1/);
    assert.equal(document.records[0].resource, 'fulfillment');
  }
  const reads = await f.db.owner.query(
    `SELECT document FROM shopify_shipment_evidence WHERE tenant_id=$1 AND kind='observation' AND document->>'kind' IS NULL`,
    [f.manifest.organizationId],
  );
  assert.ok(reads.rows.length > 0);
  for (const { document } of reads.rows) {
    assert.equal(document.adapterVersion, 'shopify-fulfillment/1');
    assert.equal(document.completeness, 'complete');
  }
  const second = await f.dispatch('PARCEL-2', 1),
    secondPreview = await f.preview(second);
  await f.call(
    'approve',
    { id: secondPreview.id, outcome: 'approved' },
    { cookie: f.approver },
  );
  assert.equal(
    (await f.call('execute', { id: secondPreview.id })).state,
    'verified',
  );
  assert.equal(
    (await f.call('inspect', { ...f.target, source: second })).snapshot
      .shipments.length,
    2,
  );
  const detail = await f.api(`/orders/${f.canonicalOrder}`);
  assert.ok(
    detail.activity.entries.some((entry) => entry.type === 'execution'),
  );
  assert.ok(
    detail.activity.entries.some(
      (entry) => entry.type === 'verification' && entry.outcome === 'verified',
    ),
  );
  assert.ok(inspected.snapshot.dispatch);
  // Two parcels and their tracking are verified through rate-limited provider reads.
}, 180_000);

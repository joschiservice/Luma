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
}, 120_000);

test('an applied fulfillment with a lost response reconciles by read and cannot create a second remote shipment', async (t) => {
  const f = await shipmentPublishingFixture(t),
    source = await f.dispatch(),
    preview = await f.preview(source);
  await f.call(
    'approve',
    { id: preview.id, outcome: 'approved' },
    { cookie: f.approver },
  );
  await f.hostCall('runs/operations/control', {
    action: 'fault',
    rule: {
      instance: 'shopify',
      operation: 'fulfillment.shipment.create',
      kind: 'response-loss',
      remaining: 1,
    },
  });
  const sent = await f.call('execute', { id: preview.id });
  assert.equal(sent.state, 'uncertain');
  await f.restart({
    featureOverrides: {
      'starshipit-fulfillment': true,
      'starshipit-actions': true,
      'shopify-shipment-publishing': false,
    },
  });
  await f.call('execute', { id: preview.id });
  const checked = await f.call('check', { id: preview.id });
  assert.equal(checked.state, 'verified');
  const current = await f.call('inspect', { ...f.target, source });
  assert.equal(current.snapshot.shipments.length, 1);

  const fence = await f.db.owner.query(
    'SELECT sent_at FROM shopify_shipment_publications WHERE tenant_id=$1 AND id=$2',
    [f.manifest.organizationId, preview.id],
  );
  assert.ok(fence.rows[0].sent_at);
  assert.equal(checked.acceptance, 'unknown');
  const lineage = await f.db.owner.query(
    "SELECT document FROM shopify_shipment_evidence WHERE tenant_id=$1 AND kind='observation' AND document->>'kind'='verified_publication' AND document->>'operationId'=$2",
    [f.manifest.organizationId, preview.id],
  );
  assert.ok(
    lineage.rows.some(
      (row) => row.document.fulfillmentId === current.snapshot.shipments[0].id,
    ),
  );
  await f.restart({
    featureOverrides: {
      'starshipit-fulfillment': true,
      'starshipit-actions': true,
      'shopify-shipment-publishing': true,
    },
  });
  await f.command('starshipit', {
    kind: 'tracking',
    order: '1',
    package: 1,
    status: 'Delivered',
    at: new Date().toISOString(),
    tracking_url: 'https://tracking.example.test/reconciled',
  });
  await f.pilot.observe({ check: false });
  const shipment = current.snapshot.shipments[0];
  const tracking = await f.call('preview', {
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
      notifyCustomer: false,
    },
  });
  await f.call(
    'approve',
    { id: tracking.id, outcome: 'approved' },
    { cookie: f.approver },
  );
  assert.equal(
    (await f.call('execute', { id: tracking.id })).state,
    'verified',
  );
  const after = await f.call('inspect', { ...f.target, source });
  assert.equal(after.snapshot.shipments.length, 1);
  assert.equal(
    after.snapshot.shipments[0].tracking[0].url,
    'https://tracking.example.test/reconciled',
  );
}, 120_000);

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

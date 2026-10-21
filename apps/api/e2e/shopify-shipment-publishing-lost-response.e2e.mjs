import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { test } from 'vitest';

import { shipmentPublishingFixture } from './shopify-shipment-publishing-fixture.mjs';

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

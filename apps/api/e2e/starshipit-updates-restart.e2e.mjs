import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { test } from 'vitest';

import { starshipitUpdatesFixture } from './starshipit-updates-fixture.mjs';

test('committed updates with a lost response reconcile after restart without another provider write even after the action release is removed', async (t) => {
  const f = await starshipitUpdatesFixture(t),
    preview = await f.preview();
  await f.call(
    'approve',
    { id: preview.id, outcome: 'approved' },
    { cookie: f.approver },
  );
  await f.hostCall('runs/operations/control', {
    action: 'fault',
    rule: {
      instance: 'starshipit',
      operation: 'orders.quantity.update',
      kind: 'response-loss',
      remaining: 1,
    },
  });
  const attempted = await f.call('execute', { id: preview.id });
  assert.equal(attempted.state, 'uncertain');
  assert.equal(
    (await f.providerOrder()).items.find(
      (item) => String(item.item_id) === f.itemId,
    ).quantity,
    f.quantity,
  );
  f.pilot = await f.restart({
    featureOverrides: {
      'starshipit-fulfillment': true,
      'starshipit-actions': false,
      'shopify-shipment-publishing': true,
    },
  });
  assert.equal((await f.call('check', { id: preview.id })).state, 'verified');
  assert.equal((await f.call('execute', { id: preview.id })).state, 'verified');
  const fence = (
    await f.db.owner.query(
      'SELECT sent_at,settled FROM starshipit_order_updates WHERE tenant_id=$1 AND id=$2',
      [f.manifest.organizationId, preview.id],
    )
  ).rows[0];
  assert.ok(fence.sent_at);
  assert.equal(fence.settled, true);
  assert.equal(
    (await f.receipts()).length,
    0,
    'lost acknowledgement is never fabricated as an acceptance',
  );
});

test('observe-only and action-release removal send no shipping correction and another tenant cannot use the saved reference', async (t) => {
  const f = await starshipitUpdatesFixture(t);
  const settings = await f.api('/settings');
  await f.api('/settings/write-mode', {
    method: 'PATCH',
    cookie: f.approver,
    body: {
      commandId: randomUUID(),
      revision: settings.workspace.revision,
      writeMode: 'observe_only',
    },
  });
  const preview = await f.preview();
  assert.equal(preview.observeOnly, true);
  const result = await f.call('execute', { id: preview.id });
  assert.equal(result.state, 'not_executed');
  assert.equal((await f.receipts()).length, 0);
  f.pilot = await f.restart({
    featureOverrides: {
      'starshipit-fulfillment': true,
      'starshipit-actions': false,
      'shopify-shipment-publishing': true,
    },
  });
  await f.preview({ status: 409 });
  assert.equal((await f.receipts()).length, 0);
  const response = await f.pilot.app.inject({
    method: 'POST',
    url: `/v1/organizations/${randomUUID()}/apps/starshipit/order-update-check`,
    headers: { cookie: f.owner, origin: 'http://127.0.0.1:3000' },
    payload: { id: preview.id },
  });
  assert.equal(response.statusCode, 404);
});

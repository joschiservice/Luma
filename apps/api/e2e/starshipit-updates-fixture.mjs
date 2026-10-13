import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { shipmentPublishingFixture } from './shopify-shipment-publishing-fixture.mjs';

/** Real shipping updates with explicitly reviewed order and line mappings, source authority and isolated PostgreSQL. */
export async function starshipitUpdatesFixture(t) {
  const f = await shipmentPublishingFixture(t);
  const target = {
    connectionId: f.manifest.connections.starshipit,
    orderId: '1',
  };
  const canonicalOrder = (
    await f.db.owner.query(
      "SELECT canonical_id FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=$2 AND resource='order' AND external_id=$3",
      [
        f.manifest.organizationId,
        f.manifest.connections.shopify,
        'gid://shopify/Order/1',
      ],
    )
  ).rows[0].canonical_id;
  for (const group of ['order_lines', 'order_lifecycle']) {
    const authority = await f.api('/source-authority');
    await f.api('/source-authority', {
      method: 'POST',
      body: {
        commandId: randomUUID(),
        revision: authority.revision,
        group,
        connectionId: f.manifest.connections.shopify,
      },
    });
  }
  const records = await f.hostCall(
    'runs/operations/records/starshipit?kind=order',
  );
  const order = records.items.find(
    (item) => String(item.data.order_id) === '1',
  ).data;
  const itemId = String(order.items[0].item_id);
  const quantity = order.items[0].quantity - 1;
  assert.ok(quantity > 0, 'fixture supports a positive quantity reduction');
  await f.command('shopify', {
    kind: 'order-edit',
    order: '1',
    lines: [{ lineItem: itemId, quantity }],
  });
  await f.pilot.observe({ check: false });
  const call = (command, body, options = {}) =>
    f.api(`/apps/starshipit/order-update-${command}`, {
      method: 'POST',
      body,
      ...options,
    });
  const preview = (options = {}) =>
    call(
      'preview',
      {
        ...target,
        requestId: randomUUID(),
        lines: [{ lineItemId: itemId, quantity }],
      },
      options,
    );
  const receipts = async () =>
    (
      await f.db.owner.query(
        "SELECT document FROM starshipit_order_update_evidence WHERE tenant_id=$1 AND document->>'kind'='acceptance'",
        [f.manifest.organizationId],
      )
    ).rows;
  const providerOrder = async () =>
    (
      await f.hostCall('runs/operations/records/starshipit?kind=order')
    ).items.find((item) => String(item.data.order_id) === '1').data;

  return {
    ...f,
    target,
    canonicalOrder,
    itemId,
    quantity,
    order,
    call,
    preview,
    receipts,
    providerOrder,
  };
}

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createObservability } from '@luma/platform/composition';

import { until } from './helpers.mjs';
import { setupSimulator } from './simulator-fixture.mjs';

/**
 * Real Shopify and Starshipit services, isolated PostgreSQL and physical parcel dispatch for
 * governed publication journeys.
 * `imported` starts from the simulator's completed initial import, as `setupSimulator` does.
 */
export async function shipmentPublishingFixture(
  t,
  { origin = 'http://127.0.0.1:3000', imported = false } = {},
) {
  const f = await setupSimulator(t, {
    imported,
    origin,
    observability: createObservability({
      environment: 'test',
      release: 'test',
      sampleRate: 0,
      featureFlagOverrides: {
        'starshipit-fulfillment': true,
        'starshipit-actions': true,
        'shopify-shipment-publishing': true,
      },
    }),
  });
  const login = async (email) => {
    const response = await f.pilot.app.inject({
      method: 'POST',
      url: '/auth/sign-in/email',
      headers: { origin },
      payload: { email, password: f.password },
    });
    assert.equal(response.statusCode, 200, response.body);

    return response.cookies
      .map(({ name, value }) => `${name}=${value}`)
      .join('; ');
  };
  const owner = await login('pilot-operator@example.test'),
    approver = await login('pilot-requester@example.test'),
    member = await login('pilot-warehouse@example.test');
  const base = `/v1/organizations/${f.manifest.organizationId}`;
  const api = async (
    path,
    { method = 'GET', body, cookie = owner, status = 200 } = {},
  ) => {
    const response = await f.pilot.app.inject({
      method,
      url: `${base}${path}`,
      headers: { origin, cookie },
      ...(body ? { payload: body } : {}),
    });
    assert.equal(response.statusCode, status, response.body);

    return response.statusCode === 204 ? null : response.json();
  };
  const command = (instance, command) =>
    f.call('runs/operations/control', { action: 'command', instance, command });
  await f.pilot.observe({ check: false });
  const record = (
    await f.call('runs/operations/records/starshipit?kind=order')
  ).items.find((item) => String(item.data.order_id) === '1');
  assert.ok(record, 'Starshipit has the fixture order');
  const starshipit = record.data;
  const reference = async (connectionId, externalId) => {
    const result = await f.db.owner.query(
      `SELECT canonical_id FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=$2 AND resource='order' AND scope_key='' AND external_id=$3`,
      [f.manifest.organizationId, connectionId, externalId],
    );
    assert.equal(result.rows.length, 1);

    return result.rows[0].canonical_id;
  };
  const target = {
    connectionId: f.manifest.connections.shopify,
    orderId: 'gid://shopify/Order/1',
  };
  const shop = await reference(target.connectionId, target.orderId),
    downstream = await reference(f.manifest.connections.starshipit, '1');
  if (shop !== downstream) {
    const link = await api('/identities/links', {
      method: 'POST',
      status: 202,
      body: {
        operation: 'link',
        kind: 'order',
        entityId: shop,
        otherId: downstream,
        reason: 'The downstream order carries the exact Shopify order identity',
      },
    });
    await until(
      async () => {
        await f.pilot.observe({ refresh: false, check: false });

        return (
          (await api(`/identities/links/${link.id}`)).state === 'completed'
        );
      },
      'Shopify and downstream source order identities are linked',
      30_000,
    );
  }
  await f.pilot.observe({ check: false });
  // The downstream item number identifies the same source line, but only a person's exact link grants canonical identity.
  const lineId = String(starshipit.items[0].item_id);
  const lineRef = async (connectionId, externalId) =>
    (
      await f.db.owner.query(
        `SELECT canonical_id FROM connector_source_mappings WHERE tenant_id=$1 AND connection_id=$2 AND resource='order_line' AND external_id=$3`,
        [f.manifest.organizationId, connectionId, externalId],
      )
    ).rows[0]?.canonical_id;
  const shopLine = await lineRef(
      target.connectionId,
      `gid://shopify/LineItem/${lineId}`,
    ),
    downstreamLine = await lineRef(f.manifest.connections.starshipit, lineId);
  assert.ok(shopLine && downstreamLine, 'both exact order line mappings exist');
  if (shopLine !== downstreamLine) {
    const link = await api('/identities/links', {
      method: 'POST',
      status: 202,
      body: {
        operation: 'link',
        kind: 'order_line',
        entityId: shopLine,
        otherId: downstreamLine,
        reason: 'The operator confirmed the exact downstream source line',
      },
    });
    await until(
      async () => {
        await f.pilot.observe({ refresh: false, check: false });

        return (
          (await api(`/identities/links/${link.id}`)).state === 'completed'
        );
      },
      'exact order line identities are linked',
      30_000,
    );
  }
  await f.pilot.observe({ check: false });
  const dispatch = async (
    number = 'PARCEL-1',
    quantity = 1,
    status = 'In Transit',
  ) => {
    const time = new Date().toISOString();
    await command('starshipit', {
      kind: 'ship',
      order: '1',
      parcel: {
        package_id: Number(number.replace(/\D/g, '')) || 1,
        tracking_number: number,
        tracking_url: `https://tracking.example.test/${number}`,
        carrier: 'Synthetic Carrier',
        items: [{ item_id: starshipit.items[0].item_id, quantity }],
        status,
        shipment_date: time,
        last_updated_date: time,
        tracking_events: [
          {
            status,
            description: 'Carrier accepted parcel',
            event_date: time,
          },
        ],
      },
    });
    await f.pilot.observe({ check: false });

    return {
      downstreamConnectionId: f.manifest.connections.starshipit,
      shipmentId: `tracking:1:${number}`,
    };
  };
  const call = (name, body, { cookie = owner, status = 200 } = {}) =>
    api(`/apps/shopify/shipment-publishing-${name}`, {
      method: 'POST',
      body,
      cookie,
      status,
    });
  const choice = async (source, quantity = 1, notifyCustomer = false) => {
    const current = await call('inspect', { ...target, source });
    const work = current.snapshot.work.find(
      (w) => w.status === 'OPEN' || w.status === 'IN_PROGRESS',
    );
    assert.ok(work);
    const line = work.lines.find((l) => l.remaining >= quantity);
    assert.ok(line);

    return {
      capability: 'fulfillment.shipment.create',
      source,
      allocations: [
        {
          fulfillmentOrderId: work.id,
          fulfillmentOrderLineId: line.id,
          orderLineId: line.orderLineId,
          locationId: work.locationId,
          quantity,
        },
      ],
      allocationSource: 'operator',
      notifyCustomer,
    };
  };
  const preview = async (source, quantity = 1, notify = false) =>
    call('preview', {
      ...target,
      requestId: randomUUID(),
      choice: await choice(source, quantity, notify),
    });

  return {
    ...f,
    hostCall: f.call,
    canonicalOrder: shop,
    get pilot() {
      return f.pilot;
    },
    api,
    owner,
    approver,
    member,
    target,
    dispatch,
    choice,
    preview,
    call,
    command,
    async restart(options) {
      f.pilot = await f.restartPilot(options);

      return f.pilot;
    },
  };
}

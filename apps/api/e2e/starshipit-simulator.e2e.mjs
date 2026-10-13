import { randomUUID } from 'node:crypto';

import { defaultConfiguration } from '@luma/exceptions';
import { expect, test } from 'vitest';

import { until } from './helpers.mjs';
import { setupSimulator } from './simulator-fixture.mjs';

test('Starshipit outage is detected through real sync and resolved only by a fresh complete scan', async (t) => {
  const f = await setupSimulator(t, {
    detection: {
      configuration: {
        ...defaultConfiguration,
        thresholds: {
          ...defaultConfiguration.thresholds,
          syncFailureSeconds: 1,
        },
      },
    },
  });
  const actor = await f.pilot.operator();
  const connection = f.manifest.connections.starshipit;
  expect(connection).toBeDefined();
  const cases = async () =>
    (await f.pilot.detection.exceptions.list(actor)).filter(
      (incident) =>
        incident.exceptionClass === 'sync_failure' &&
        incident.subject.subjectId === connection,
    );
  const active = async () =>
    (await cases()).filter((incident) => incident.state !== 'resolved');
  const inject = (id) =>
    f.call('runs/operations/incidents', {
      id,
      kind: 'shipping-provider-outage',
    });
  const recover = (id) => f.call(`runs/operations/incidents/${id}/recover`, {});
  await f.pilot.observe({ check: false });
  await f.pilot.detect();
  expect(await cases()).toEqual([]);
  const id = randomUUID();
  const first = await inject(id);
  expect(await inject(id)).toEqual(first);
  // The production rule waits for five failed sync attempts; each is a real adapter read.
  for (let attempt = 0; attempt < 5; attempt++)
    await f.pilot.observe({ check: false });
  await f.pilot.detect();
  const opened = await active();
  expect(opened.length).toBeGreaterThan(0);
  const evidence = await f.pilot.detection.exceptions.evidence(
    actor,
    opened[0].id,
  );
  expect(
    evidence.some(
      (item) =>
        item.source?.provider === 'starshipit' &&
        item.connectionId === connection,
    ),
  ).toBe(true);
  await f.pilot.detect();
  expect((await active()).map((incident) => incident.id)).toEqual(
    opened.map((incident) => incident.id),
  );
  const scorecard = await f.call('runs/operations/scorecard');
  expect(
    scorecard.byKind.find((kind) => kind.kind === 'shipping-provider-outage'),
  ).toMatchObject({ detected: 1, missed: 0 });
  await recover(id);
  await f.pilot.detect();
  expect(await active()).toHaveLength(opened.length);
  await f.call('runs/operations/control', {
    action: 'fault',
    rule: {
      instance: 'starshipit',
      operation: '*',
      kind: 'malformed',
      remaining: 100,
    },
  });
  await f.pilot.observe({ check: false });
  await f.pilot.detect();
  expect(await active()).toHaveLength(opened.length);
  const run = await f.call('runs/operations');
  for (const rule of run.faults)
    await f.call('runs/operations/control', { action: 'disable', id: rule.id });
  await f.pilot.observe({ check: false });
  await f.pilot.detect();
  expect(await active()).toEqual([]);
  for (const incident of await cases())
    expect(incident.resolution).toMatchObject({
      kind: 'verification',
      outcome: 'passed',
      authoritative: true,
      complete: true,
    });
  const next = randomUUID();
  await inject(next);
  for (let attempt = 0; attempt < 5; attempt++)
    await f.pilot.observe({ check: false });
  await f.pilot.detect();
  const recurring = await active();
  expect(recurring.length).toBeGreaterThan(0);
  expect(
    recurring.every((incident) =>
      opened.some((previous) => previous.id === incident.previousExceptionId),
    ),
  ).toBe(true);
  await recover(id);
  expect(
    (await f.call('runs/operations')).instances.find(
      (instance) => instance.kind === 'starshipit',
    ).health,
  ).toBe('unavailable');
  await recover(next);
  await f.pilot.observe({ check: false });
  await f.pilot.detect();
  expect(await active()).toEqual([]);
  expect(f.pilot.detectionErrors).toEqual([]);
});

test('Starshipit webhooks wake real reads and duplicates or old notifications cannot regress current tracking', async (t) => {
  const f = await setupSimulator(t);
  const actor = await f.pilot.operator();
  const connectionId = f.manifest.connections.starshipit;
  const capabilities = await f.pilot.capabilities.discover(actor, connectionId);
  expect(capabilities).toContainEqual(
    expect.objectContaining({
      capability: 'orders.quantity.update',
      version: '0',
      minimumRisk: 'medium',
      idempotency: 'none',
    }),
  );
  const command = (command) =>
    f.call('runs/operations/control', {
      action: 'command',
      instance: 'starshipit',
      command,
    });
  const records = await f.call('runs/operations/records/starshipit?kind=order');
  const order = records.items[0].data;
  const timestamp = new Date().toISOString();
  const parcel = {
    package_id: 1,
    tracking_number: 'WEBHOOK-PARCEL',
    tracking_url: 'https://tracking.example.test/parcel',
    carrier: 'Synthetic Carrier',
    items: [{ item_id: order.items[0].item_id, quantity: 1 }],
    status: 'In Transit',
    shipment_date: timestamp,
    last_updated_date: timestamp,
    tracking_events: [
      {
        status: 'In Transit',
        description: 'Carrier accepted parcel',
        event_date: timestamp,
      },
    ],
  };
  await f.pilot.observe({ check: false });
  await command({ kind: 'ship', order: String(order.order_id), parcel });
  await command({
    kind: 'tracking',
    order: String(order.order_id),
    package: 1,
    status: 'Delivered',
  });
  const hints = async () =>
    (
      await f.db.owner.query(
        'SELECT event_key FROM connector_refresh_hints WHERE connection_id=$1',
        [connectionId],
      )
    ).rows;
  await until(
    async () => (await hints()).length >= 1,
    'Starshipit provider notifications reached its real webhook route',
    20000,
  );
  await f.pilot.observe({ check: false });
  const read = async () => {
    const result = await f.pilot.capabilities.read(actor, {
      connectionId,
      capability: 'fulfillment.read',
      version: '0',
      input: {
        limit: 10,
        order: { externalId: String(order.order_id), scopeKey: '' },
      },
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);

    return result.value.items.find(
      (item) =>
        item.source.externalId === `tracking:${order.order_id}:WEBHOOK-PARCEL`,
    );
  };
  expect((await read()).data.status).toBe('delivered');
  const signIn = await f.pilot.app.inject({
    method: 'POST',
    url: '/auth/sign-in/email',
    headers: { origin: 'http://127.0.0.1:3000' },
    payload: { email: 'pilot-operator@example.test', password: f.password },
  });
  expect(signIn.statusCode).toBe(200);
  const cookie = signIn.cookies
    .map(({ name, value }) => `${name}=${value}`)
    .join('; ');
  const base = `/v1/organizations/${f.manifest.organizationId}/fulfillment`;
  const list = await f.pilot.app.inject({
    method: 'GET',
    url: `${base}?connectionId=${connectionId}&view=all`,
    headers: { cookie },
  });
  expect(list.statusCode).toBe(200);
  const shipment = list
    .json()
    .items.find((item) =>
      item.tracking.some((track) => track.number === 'WEBHOOK-PARCEL'),
    );
  expect(shipment.shipping).toMatchObject({
    stage: 'delivered',
    trackingUpdatedAt: expect.any(String),
    sourceUrl: parcel.tracking_url,
  });
  const detail = await f.pilot.app.inject({
    method: 'GET',
    url: `${base}/${shipment.id}`,
    headers: { cookie },
  });
  expect(detail.statusCode).toBe(200);
  expect(detail.json().item.shipping).toEqual(shipment.shipping);
  expect(
    detail
      .json()
      .timeline.entries.some((entry) => entry.shipping?.stage === 'delivered'),
  ).toBe(true);
  // Parcel allocations belong to ground truth, not undocumented provider evidence.
  expect(detail.json().lines).toEqual([]);
  const count = (await hints()).length;
  await command({
    kind: 'webhook',
    order: String(order.order_id),
    updatedAt: '2026-09-01T00:00:00Z',
    copies: 2,
  });
  await until(
    async () => (await hints()).length === count + 1,
    'duplicate old notifications create one refresh hint',
    20000,
  );
  await f.pilot.observe({ check: false });
  expect((await read()).data.status).toBe('delivered');
  const unauthorized = await fetch(
    `${f.apiOrigin}/v1/starshipit/changes/${f.manifest.organizationId}/${connectionId}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ order_id: order.order_id }),
    },
  );
  expect(unauthorized.status).toBe(401);
});

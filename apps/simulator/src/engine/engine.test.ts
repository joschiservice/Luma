import { randomUUID } from 'node:crypto';

import {
  merchantProfile,
  type MerchantProfileName,
} from '@luma/simulator-commerce';
import { chaosPreset, type ChaosPresetName } from '@luma/simulator-core';
import { readItemStock, readOrder as readErpOrder } from '@luma/simulator-jtl';
import { readOrder, readStock } from '@luma/simulator-shopify';
import { describe, expect, it } from 'vitest';

import { buildWorld } from '../runtime/provision.js';
import type { RunRecord } from '../runtime/runs.js';
import { advanceWorld } from './advance.js';
import { injectIncident, recoverIncident } from './incidents.js';
import { forgetModel } from './model.js';
import { placeOrder } from './orders.js';
import { erpContext, type Incident, shopContext } from './world.js';

const start = Date.parse('2026-10-05T06:00:00Z');
const hour = 3_600_000;

function testRun(
  profile: MerchantProfileName,
  chaos: ChaosPresetName = 'calm',
  seed = 44,
): RunRecord {
  const id = `engine-${randomUUID().slice(0, 8)}`;
  forgetModel(id);

  return {
    id,
    seed,
    profileName: profile,
    profile: merchantProfile(profile),
    chaos: chaosPreset(chaos),
    status: 'provisioning',
    progress: null,
    error: null,
    now: start,
    running: false,
    speed: 1,
    wallAt: start,
    health: {},
    state: { pickCarry: {}, nextStockSync: start, startedAt: start },
    createdAt: start,
  };
}

async function summary(
  stores: Awaited<ReturnType<typeof buildWorld>>['stores'],
) {
  const count = (instance: string, kind: string) =>
    stores.get(instance)?.count({ kind }) ?? 0;

  return {
    orders: await count('world', 'order'),
    erpOrders: await count('jtl', 'sales-order'),
    deliveryNotes: await count('jtl', 'delivery-note'),
    fulfillments: await count('shopify', 'Fulfillment'),
    returns: await count('shopify', 'Return'),
  };
}

describe('merchant world', () => {
  it('creates the fixed test orders in both systems with the same IDs', async () => {
    const { world } = await buildWorld(testRun('test'));
    for (const id of ['1', '10']) {
      expect(await readOrder(shopContext(world, 'shopify'), id)).toMatchObject({
        name: `#SIM-${id}`,
        lines: [expect.objectContaining({ quantity: 2 })],
      });
      expect(await readErpOrder(erpContext(world), id)).toMatchObject({
        externalNumber: `SIM-${id}`,
        shippingMethodId: '7',
      });
    }
    expect(await readItemStock(erpContext(world), '1')).toMatchObject({
      total: 100,
      reserved: 4,
    });
  });

  it('simulates days of orders, shipments and returns, the same way for the same seed', async () => {
    const first = await buildWorld(testRun('small'));
    expect(
      [...first.sinks.metrics.values()].filter(
        (metric) => metric.name === 'engine.errors',
      ),
    ).toEqual([]);
    const counts = await summary(first.stores);
    expect(counts.orders).toBeGreaterThan(400);
    expect(counts.erpOrders).toBeGreaterThan(counts.orders * 0.9);
    expect(counts.deliveryNotes).toBeGreaterThan(counts.orders * 0.5);
    expect(counts.fulfillments).toBeGreaterThan(counts.orders * 0.5);
    expect(counts.returns).toBeGreaterThan(0);
    expect(await summary((await buildWorld(testRun('small'))).stores)).toEqual(
      counts,
    );
    expect(
      await summary((await buildWorld(testRun('small', 'calm', 45))).stores),
    ).not.toEqual(counts);
  }, 120_000);

  it('keeps shop availability equal to the ERP while the stock sync works', async () => {
    const { world } = await buildWorld(testRun('small'));
    world.live = true;
    await advanceWorld(world, world.now + hour);
    let compared = 0;
    for (const variant of world.model.catalog.variants.slice(0, 40)) {
      const erp = await readItemStock(erpContext(world), variant.id);
      const shop = await readStock(
        shopContext(world, 'shopify'),
        variant.id,
        '1',
      );
      if (!erp || !shop) continue;
      // Orders placed since the last push are committed in the shop but not yet reserved in the ERP.
      expect(
        Math.abs(shop.available - Math.max(0, erp.available)),
      ).toBeLessThanOrEqual(5);
      compared++;
    }
    expect(compared).toBeGreaterThan(30);
  }, 120_000);

  it('injects and recovers stock drift, outages and order incidents as ground truth', async () => {
    const { world } = await buildWorld(testRun('test'));
    world.live = true;
    const drift = await injectIncident(world, {
      id: randomUUID(),
      kind: 'inventory-drift',
      target: 'LUMA-SCENARIO-001',
    });
    expect(drift).toMatchObject({
      status: 'active',
      origin: 'injected',
      instance: 'shopify',
    });
    const erp = await readItemStock(erpContext(world), '2');
    expect(
      (await readStock(shopContext(world, 'shopify'), '2', '1'))?.available,
    ).not.toBe(erp?.available);
    expect(
      await injectIncident(world, { id: drift.id, kind: 'inventory-drift' }),
    ).toEqual(drift);
    await recoverIncident(world, drift.id);
    expect(
      (await readStock(shopContext(world, 'shopify'), '2', '1'))?.available,
    ).toBe(erp?.available);

    const outage = await injectIncident(world, {
      id: randomUUID(),
      kind: 'provider-outage',
      instance: 'jtl',
    });
    expect(world.run.health.jtl).toMatchObject({
      status: 'unavailable',
      incident: outage.id,
    });
    await advanceWorld(world, world.now + 31 * 60_000);
    expect(world.run.health.jtl).toBeUndefined();
    const closed = await world
      .store('world')
      .get<Incident>('incident', outage.id);
    expect(closed?.data.status).toBe('recovered');

    const stall = await injectIncident(world, {
      id: randomUUID(),
      kind: 'warehouse-stall',
    });
    expect(stall.status).toBe('planned');
    await advanceWorld(world, world.now + 10 * 60_000);
    const started = await world
      .store('world')
      .get<Incident>('incident', stall.id);
    expect(started?.data).toMatchObject({ status: 'active' });
    expect(started?.data.resources.map((resource) => resource.kind)).toContain(
      'salesOrder',
    );
  }, 60_000);

  it('produces emerged incidents at the chaos profile’s rates', async () => {
    const run = testRun('small', 'realistic');
    for (const kind of Object.keys(run.chaos.incidents))
      run.chaos.incidents[kind] = 50;
    const { world } = await buildWorld(run);
    world.live = true;
    await advanceWorld(world, world.now + 6 * hour);
    const incidents = await world
      .store('world')
      .page<Incident>({ kind: 'incident', limit: 500 });
    expect(
      new Set(incidents.items.map((item) => item.data.kind)).size,
    ).toBeGreaterThan(3);
    expect(
      incidents.items.every((item) => item.data.origin === 'emerged'),
    ).toBe(true);
  }, 120_000);

  it('places manual orders with explicit lines through the integration', async () => {
    const { world } = await buildWorld(testRun('test'));
    world.live = true;
    const order = await placeOrder(world, 'shopify', {
      identity: 'manual-1',
      lines: [{ variant: '1', quantity: 3 }],
      shipping: 'express',
    });
    await advanceWorld(world, world.now + 60_000);
    const imported = await readErpOrder(
      erpContext(world),
      (await world
        .store('world')
        .get<{ erpOrder: string }>('order', `shopify:${order.order}`))!.data
        .erpOrder,
    );
    expect(imported).toMatchObject({
      shippingMethodId: '8',
      lines: [expect.objectContaining({ quantity: 3 })],
    });
  });
});

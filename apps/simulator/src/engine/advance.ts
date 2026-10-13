import { orderRate, wholesaleRate } from '@luma/simulator-commerce';
import {
  incidentKinds,
  keyedRandom,
  poisson,
  unit,
} from '@luma/simulator-core';

import {
  carrierUpdate,
  pickOrders,
  returnStep,
  supplierAnswer,
  syncShipment,
} from './fulfillment.js';
import { purchaseOrderMail } from './mail.js';
import {
  cancelOrder,
  importOrder,
  placeOrder,
  placeWholesaleOrder,
  settlePayment,
} from './orders.js';
import { checkFreezes, syncStock } from './stock.js';
import {
  closeIncident,
  type EngineEvent,
  erp,
  openIncident,
  shop,
  type World,
  worldInstance,
} from './world.js';

const second = 1_000;
const minute = 60_000;

type Step = { at: number; label: string; run: () => Promise<void> };

/**
 * Runs one step. A provider refusal skips the step and the world moves on, as a merchant's
 * integration would; every refusal is journaled and counted, and engine tests require none.
 */
async function runStep(world: World, step: Step) {
  try {
    await step.run();
  } catch (error) {
    world.journal('engine-error', {
      step: step.label,
      reason: error instanceof Error ? error.message : 'Refused',
    });
    world.metric('engine.errors', 1);
  }
}

/** Applies one scheduled engine event. */
async function apply(world: World, event: EngineEvent) {
  switch (event.kind) {
    case 'import-order':
      return importOrder(world, event.payload.shop, event.payload.order);
    case 'payment':
      return settlePayment(
        world,
        event.payload.shop,
        event.payload.order,
        event.payload.paid,
      );
    case 'customer-cancel':
      return cancelOrder(world, event.payload.shop, event.payload.order);
    case 'release-hold':
      // The merchant may already have released or cancelled it.
      await shop(world, event.payload.shop, {
        kind: 'release',
        order: event.payload.order,
      }).catch(() => undefined);

      return;
    case 'shipment-sync':
      return syncShipment(world, event.payload);
    case 'carrier':
      return carrierUpdate(world, event.payload);
    case 'return':
      return returnStep(world, event.payload);
    case 'supplier':
      return supplierAnswer(world, event.payload.command);
    case 'purchase-order-mail':
      return purchaseOrderMail(world, event.payload.purchaseOrder);
    case 'wholesale-payment':
      await erp(world, { kind: 'paid', id: event.payload.erpOrder });

      return;
  }
}

/**
 * Customer and wholesale orders arriving in [from, to), drawn per shop and second so timing
 * never changes them.
 */
function arrivals(world: World, from: number, to: number): Step[] {
  const steps: Step[] = [];
  const profile = world.model.profile;
  if (!profile.demand.autonomous) return steps;
  for (
    let start = Math.ceil(from / second) * second;
    start < to;
    start += second
  )
    for (const { shop: shopProfile, name } of world.model.shops) {
      const mean =
        orderRate(profile, shopProfile, world.run.startedAt, start) * second;
      const count = poisson(
        keyedRandom(world.run.seed, 'arrivals', name, start),
        mean,
      );
      for (let index = 0; index < count; index++)
        steps.push({
          at:
            start +
            Math.floor(
              unit(world.run.seed, 'arrival-at', name, start, index) * second,
            ),
          label: 'order',
          run: async () => {
            await placeOrder(world, name, { identity: `${start}:${index}` });
          },
        });
    }
  if (profile.wholesale)
    for (
      let start = Math.ceil(from / second) * second;
      start < to;
      start += second
    ) {
      const count = poisson(
        keyedRandom(world.run.seed, 'wholesale-arrivals', start),
        wholesaleRate(profile, start) * second,
      );
      for (let index = 0; index < count; index++)
        steps.push({
          at:
            start +
            Math.floor(
              unit(world.run.seed, 'wholesale-at', start, index) * second,
            ),
          label: 'wholesale-order',
          run: async () => {
            await placeWholesaleOrder(world, `${start}:${index}`);
          },
        });
    }

  return steps;
}

/** Starts and ends provider-level incidents such as outages and revoked access. */
async function providerIncidents(world: World) {
  for (const [name, window] of Object.entries(world.run.health)) {
    if (window.until === undefined || window.until > world.now) continue;
    delete world.run.health[name];
    if (window.incident)
      await closeIncident(world, window.incident, 'Provider recovered');
  }
  if (!world.live) return;
  for (const kind of [
    'provider-outage',
    'shipping-provider-outage',
    'auth-revoked',
  ] as const) {
    const rate = world.run.chaos.incidents[kind] ?? 0;
    if (
      !(
        unit(world.run.seed, 'provider-incident', kind, world.now) <
        rate / 1440
      )
    )
      continue;
    const random = keyedRandom(
      world.run.seed,
      'provider-incident-target',
      kind,
      world.now,
    );
    // Outages and revoked access hit the commerce systems; the mailbox keeps the original draw.
    const target = random.pick(
      world.model.instances.filter((item) =>
        kind === 'shipping-provider-outage'
          ? item.kind === 'starshipit'
          : item.kind !== 'gmail',
      ),
    );
    if (world.run.health[target.name]) continue;
    const duration =
      kind === 'auth-revoked' ? 60 * minute : random.int(20, 40) * minute;
    const incident = await openIncident(world, {
      kind,
      origin: 'emerged',
      instance: target.name,
      summary: `${target.label} ${kind === 'auth-revoked' ? 'rejects Luma’s credentials' : 'is unavailable'} for ${Math.round(duration / minute)} minutes.`,
      resources: [
        {
          instance: target.name,
          kind: 'connection',
          id: target.name,
          label: target.label,
        },
      ],
      detail: { durationMs: duration, label: incidentKinds[kind].label },
    });
    world.run.health[target.name] = {
      status: kind === 'auth-revoked' ? 'unauthorized' : 'unavailable',
      until: world.now + duration,
      incident: incident.id,
    };
  }
}

/** Work that happens once per simulated minute. */
async function everyMinute(world: World) {
  await pickOrders(world, 1);
  const every = world.model.profile.integration.stockSyncEveryMs;
  if (every && world.now >= world.run.state.nextStockSync) {
    await syncStock(world);
    world.run.state.nextStockSync = world.now + every;
  }
  await checkFreezes(world);
  await providerIncidents(world);
}

async function dueEvents(world: World, before: number) {
  const store = world.store(worldInstance);
  const page = await store.page<EngineEvent>({
    kind: 'event',
    order: 'updated',
    updatedBefore: before,
    limit: 500,
  });

  return page.items.map((record): Step => ({
    at: record.updatedAt,
    label: record.data.kind,
    run: async () => {
      await store.delete('event', record.id);
      await apply(world, record.data);
    },
  }));
}

/**
 * Advances the merchant world to simulation time `to`, one minute window at a time: customer
 * arrivals, scheduled events in time order, then each minute's warehouse, stock and provider
 * work. Callers persist the world after each call.
 */
export async function advanceWorld(world: World, to: number) {
  while (world.now < to) {
    const from = world.now;
    const end = Math.min(to, Math.floor(from / minute) * minute + minute);
    const steps = [
      ...arrivals(world, from, end),
      ...(await dueEvents(world, end)),
    ];
    steps.sort((a, b) => a.at - b.at);
    for (const step of steps) {
      world.now = Math.max(from, step.at);
      await runStep(world, step);
    }
    // Events scheduled during this window and already due run before the window closes.
    for (let rounds = 0; rounds < 20; rounds++) {
      const more = await dueEvents(world, end);
      if (!more.length) break;
      for (const step of more) {
        world.now = Math.max(world.now, step.at);
        await runStep(world, step);
      }
    }
    world.now = end;
    if (end % minute === 0) await everyMinute(world);
  }
}

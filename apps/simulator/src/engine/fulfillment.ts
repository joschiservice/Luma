import { days, localTime } from '@luma/simulator-commerce';
import {
  createWeightedPicker,
  keyedRandom,
  logNormal,
} from '@luma/simulator-core';
import { readItemStock, readOrder as readErpOrder } from '@luma/simulator-jtl';

import { customerDelayMail, supplierConfirmationMail } from './mail.js';
import { orderIncident, type WorldOrder, worldOrder } from './orders.js';
import { shipParcel, trackParcel } from './shipping.js';
import {
  type EngineEvents,
  erp,
  erpContext,
  erpResource,
  schedule,
  shop,
  type World,
  worldInstance,
} from './world.js';

const hour = 3_600_000;
const day = 24 * hour;

/** An ERP order waiting for its warehouse; wholesale orders have no shop order. */
export interface Pick {
  shop: string | null;
  order: string | null;
  stalled: boolean;
}

/**
 * Picks and ships the oldest eligible orders of each warehouse within its staffed hours and
 * hourly capacity. Orders without stock wait an hour; lines in stock ship separately.
 */
export async function pickOrders(world: World, minutes: number) {
  const store = world.store(worldInstance);
  let backlog = 0;
  for (const warehouse of world.model.profile.warehouses) {
    const { hour: local } = localTime(world.now, warehouse.timeZone);
    const staffed = local >= warehouse.shift[0] && local < warehouse.shift[1];
    const carry = world.run.state.pickCarry[warehouse.id] ?? 0;
    let capacity = staffed
      ? carry + (warehouse.picksPerHour / 60) * minutes
      : 0;
    const picks = await store.page<Pick>({
      kind: 'pick',
      key: warehouse.id,
      order: 'updated',
      updatedBefore: world.now + 1,
      limit: Math.max(1, Math.floor(capacity)),
    });
    backlog += await store.count({ kind: 'pick', key: warehouse.id });
    for (const pick of picks.items) {
      if (capacity < 1) break;
      capacity -= 1;
      await pickOne(world, pick.id, pick.data, warehouse.id);
    }
    world.run.state.pickCarry[warehouse.id] = Math.min(capacity, 5);
  }
  world.metric('backlog', backlog, '', 'max');
}

async function pickOne(
  world: World,
  erpOrder: string,
  pick: Pick,
  warehouse: string,
) {
  const store = world.store(worldInstance);
  const order = await readErpOrder(erpContext(world), erpOrder);
  const open = order?.lines.filter((line) => line.open > 0) ?? [];
  if (!order || order.cancelled || !open.length) {
    await store.delete('pick', erpOrder);

    return;
  }
  const shippable: { lineId: string; quantity: number }[] = [];
  for (const line of open) {
    const stock = await readItemStock(erpContext(world), line.itemId);
    if ((stock?.warehouses[warehouse] ?? 0) >= line.open)
      shippable.push({ lineId: line.id, quantity: line.open });
  }
  if (!shippable.length) {
    world.metric('orders.backordered', 1, world.model.erp.name);
    await store.put('pick', erpOrder, pick, { updatedAt: world.now + hour });

    return;
  }
  const random = keyedRandom(
    world.run.seed,
    'carrier',
    erpOrder,
    order.lines.length,
  );
  const carriers = world.model.profile.carriers.filter(
    (item) => !item.warehouses || item.warehouses.includes(warehouse),
  );
  const carrier = createWeightedPicker(
    carriers,
    carriers.map((item) => item.share),
  )(random);
  const shipment = await store.sequence('shipment');
  const trackingNumber = `${carrier.trackingPrefix}${String(shipment).padStart(10, '0')}`;
  await erp(world, {
    kind: 'ship',
    id: erpOrder,
    warehouse,
    lines: shippable,
    trackingNumber,
    trackingUrl: `${carrier.trackingUrl}${trackingNumber}`,
  });
  const complete = shippable.length === open.length;
  if (complete) {
    await store.delete('pick', erpOrder);
    world.metric('orders.shipped', 1, world.model.erp.name);
  } else
    await store.put('pick', erpOrder, pick, { updatedAt: world.now + hour });
  world.metric('shipments', 1, `warehouse-${warehouse}`);
  if (!pick.shop || !pick.order) return;
  const worldRecord = await worldOrder(world, pick.shop, pick.order);
  if (!worldRecord) return;
  const lines = shippable.map((item) => {
    const line = order.lines.find((value) => value.id === item.lineId)!;

    return { variant: line.itemId, quantity: item.quantity };
  });
  const shipmentSync = {
    shop: pick.shop,
    order: pick.order,
    lines,
    carrier: carrier.name,
    trackingNumber,
    trackingUrl: `${carrier.trackingUrl}${trackingNumber}`,
    transitMs: days(random, carrier.transitDays),
  };
  const parcel = await shipParcel(world, worldRecord, shipmentSync);
  await store.put('shipping-tracking', trackingNumber, parcel, {
    updatedAt: world.now,
  });
  if (worldRecord.incidents.includes('shipment-sync-failure')) {
    await orderIncident(world, worldRecord, {
      kind: 'shipment-sync-failure',
      instance: pick.shop,
      summary: `The ERP shipped ${worldRecord.name}, but the shop never receives the shipment.`,
      resources: [
        {
          instance: pick.shop,
          kind: 'Order',
          id: `gid://shopify/Order/${pick.order}`,
          label: worldRecord.name,
        },
        erpResource(world, 'salesOrder', erpOrder),
      ],
      detail: { shipmentSync },
    });

    return;
  }
  const lag = world.model.profile.integration.shipmentLag;
  await schedule(
    world,
    world.now + logNormal(random, lag.medianMs, lag.p99Ms),
    'shipment-sync',
    shipmentSync,
  );
}

/** Books an ERP shipment in the shop, then plans the carrier's delivery. */
export async function syncShipment(
  world: World,
  payload: EngineEvents['shipment-sync'],
) {
  const order = await worldOrder(world, payload.shop, payload.order);
  if (!order) return;
  const lines = payload.lines.flatMap((line) => {
    const match = order.lines.find((value) => value.variant === line.variant);

    return match ? [{ lineItem: match.lineItem, quantity: line.quantity }] : [];
  });
  let result: Awaited<ReturnType<typeof shop>>;
  try {
    result = await shop(world, payload.shop, {
      kind: 'fulfill',
      order: payload.order,
      lines,
      carrier: payload.carrier,
      trackingNumber: payload.trackingNumber,
      trackingUrl: payload.trackingUrl,
      estimatedDeliveryAt: world.now + payload.transitMs,
    });
  } catch (error) {
    // The shop refused the shipment, for example while a merchant hold is active.
    const attempt = (payload.attempt ?? 0) + 1;
    world.journal(
      'shipment-sync-failed',
      {
        order: order.name,
        attempt,
        reason: error instanceof Error ? error.message : 'Refused',
      },
      payload.shop,
      `gid://shopify/Order/${payload.order}`,
    );
    if (attempt < 5)
      await schedule(
        world,
        world.now + 30 * 60_000 * attempt,
        'shipment-sync',
        {
          ...payload,
          attempt,
        },
      );

    return;
  }
  const parcel = await world
    .store(worldInstance)
    .get<{ order: string; package: number }>(
      'shipping-tracking',
      payload.trackingNumber,
    );
  if (parcel)
    await world
      .store(worldInstance)
      .put(
        'shipping-fulfillment',
        `${payload.shop}:${result.id}`,
        parcel.data,
        { updatedAt: world.now },
      );
  // The carrier scans the parcel when it leaves the warehouse.
  await shop(world, payload.shop, {
    kind: 'shipment-status',
    fulfillment: result.id,
    status: 'IN_TRANSIT',
  });
  const delayed = order.incidents.includes('carrier-delay');
  const lost = order.incidents.includes('lost-parcel');
  if (delayed || lost)
    await orderIncident(world, order, {
      kind: delayed ? 'carrier-delay' : 'lost-parcel',
      instance: payload.shop,
      summary: delayed
        ? `${payload.carrier} parcel ${payload.trackingNumber} for ${order.name} stays in transit far beyond its estimate.`
        : `${payload.carrier} reports parcel ${payload.trackingNumber} for ${order.name} as failed.`,
      resources: [
        {
          instance: payload.shop,
          kind: 'Fulfillment',
          id: result.gid,
          label: payload.trackingNumber,
        },
        {
          instance: payload.shop,
          kind: 'Order',
          id: `gid://shopify/Order/${payload.order}`,
          label: order.name,
        },
      ],
      detail: {},
    });
  await schedule(
    world,
    world.now + (delayed ? payload.transitMs * 5 + 3 * day : payload.transitMs),
    'carrier',
    {
      shop: payload.shop,
      order: payload.order,
      fulfillment: result.id,
      status: lost ? 'FAILURE' : 'DELIVERED',
    },
  );
  if (delayed)
    await schedule(world, world.now + payload.transitMs, 'carrier', {
      shop: payload.shop,
      order: payload.order,
      fulfillment: result.id,
      status: 'DELAYED',
    });
}

/** Applies a carrier update; delivered parcels may come back as returns. */
export async function carrierUpdate(
  world: World,
  payload: EngineEvents['carrier'],
) {
  await shop(world, payload.shop, {
    kind: 'shipment-status',
    fulfillment: payload.fulfillment,
    status: payload.status,
  });
  await trackParcel(world, payload.shop, payload.fulfillment, payload.status);
  if (payload.status === 'DELAYED') {
    // Some customers write to the shop when tracking stalls.
    const order = await worldOrder(world, payload.shop, payload.order);
    if (
      order &&
      keyedRandom(
        world.run.seed,
        'delay-mail',
        payload.shop,
        payload.order,
      ).chance(0.5)
    )
      await customerDelayMail(world, order, 'carrier');
  }
  if (payload.status !== 'DELIVERED') return;
  world.metric('orders.delivered', 1, payload.shop);
  const order = await worldOrder(world, payload.shop, payload.order);
  if (order) await planReturn(world, order);
}

async function planReturn(world: World, order: WorldOrder) {
  const store = world.store(worldInstance);
  if (await store.get('return', `${order.shop}:${order.order}`)) return;
  const random = keyedRandom(world.run.seed, 'return', order.shop, order.order);
  const categories = new Map(
    world.model.profile.catalog.categories.map((category) => [
      category.code,
      category,
    ]),
  );
  const lines = order.lines.filter((line) => {
    const product = world.model.product(
      world.model.variant(line.variant).productId,
    );

    return random.chance(categories.get(product.category)?.returnRate ?? 0.1);
  });
  if (!lines.length) return;
  await store.put(
    'return',
    `${order.shop}:${order.order}`,
    { step: 'planned' },
    { updatedAt: world.now },
  );
  await schedule(
    world,
    world.now + days(random, world.model.profile.returns.requestDelayDays),
    'return',
    {
      shop: order.shop,
      order: order.order,
      step: 'request',
      lines: lines.map((line) => ({
        lineItem: line.lineItem,
        quantity: line.quantity,
      })),
    },
  );
}

/** Moves a return through request, decision, receipt, refund and closing. */
export async function returnStep(
  world: World,
  payload: EngineEvents['return'],
) {
  const random = keyedRandom(
    world.run.seed,
    'return-step',
    payload.shop,
    payload.order,
    payload.step,
  );
  const profile = world.model.profile.returns;
  const next = (delay: number, step: typeof payload.step) =>
    schedule(world, world.now + delay, 'return', {
      shop: payload.shop,
      order: payload.order,
      step,
    });
  const order = await worldOrder(world, payload.shop, payload.order);
  if (!order) return;
  if (payload.step === 'request') {
    await shop(world, payload.shop, {
      kind: 'return',
      order: payload.order,
      lines: payload.lines ?? [],
      reason: random.pick([
        'Size too small',
        'Size too large',
        'Not as described',
        'Changed my mind',
        'Arrived damaged',
      ]),
    });
    world.metric('returns.requested', 1, payload.shop);
    await next(logNormal(random, 4 * hour, 2 * day), 'decide');
  } else if (payload.step === 'decide') {
    if (!random.chance(profile.approveRate)) {
      await shop(world, payload.shop, {
        kind: 'return-decline',
        order: payload.order,
      });

      return;
    }
    await shop(world, payload.shop, {
      kind: 'return-approve',
      order: payload.order,
    });
    await next(days(random, profile.receiveDelayDays), 'receive');
  } else if (payload.step === 'receive') {
    await shop(world, payload.shop, {
      kind: 'return-receive',
      order: payload.order,
    });
    await restock(world, order);
    await next(logNormal(random, 6 * hour, 2 * day), 'refund');
  } else if (payload.step === 'refund') {
    const fails = order.incidents.includes('refund-failure');
    const outcome = fails
      ? 'failure'
      : random.chance(profile.refundPendingRate)
        ? 'pending'
        : 'success';
    const result = await shop(world, payload.shop, {
      kind: 'refund',
      order: payload.order,
      outcome,
    });
    if (fails)
      await orderIncident(world, order, {
        kind: 'refund-failure',
        instance: payload.shop,
        summary: `The refund for ${order.name} failed; the customer has not been paid back.`,
        resources: [
          {
            instance: payload.shop,
            kind: 'Refund',
            id: result.gid,
            label: `${order.name} refund`,
          },
          {
            instance: payload.shop,
            kind: 'Order',
            id: `gid://shopify/Order/${payload.order}`,
            label: order.name,
          },
        ],
        detail: {},
      });
    else if (outcome === 'pending')
      await next(logNormal(random, day, 4 * day), 'settle');
    else await next(logNormal(random, hour, day), 'close');
  } else if (payload.step === 'settle') {
    await shop(world, payload.shop, {
      kind: 'refund-settle',
      order: payload.order,
    });
    await next(logNormal(random, hour, day), 'close');
  } else
    await shop(world, payload.shop, {
      kind: 'return-close',
      order: payload.order,
    });
}

/** Books received return units back into the warehouse that shipped them. */
async function restock(world: World, order: WorldOrder) {
  if (!order.erpOrder) return;
  const erpOrder = await readErpOrder(erpContext(world), order.erpOrder);
  const warehouse = erpOrder?.warehouse;
  if (!warehouse) return;
  const units = new Map<string, number>();
  for (const line of order.lines)
    units.set(line.variant, (units.get(line.variant) ?? 0) + line.quantity);
  for (const [itemId, quantity] of units) {
    const stock = await readItemStock(erpContext(world), itemId);
    await erp(world, {
      kind: 'stock',
      itemId,
      warehouse,
      quantity: (stock?.warehouses[warehouse] ?? 0) + quantity,
    });
  }
}

/** Reorders an item from its default supplier when its stock covers too few days of demand. */
export async function reorderIfLow(
  world: World,
  itemId: string,
  available: number,
) {
  const suppliers = world.model.profile.suppliers;
  if (!suppliers.merchantReorders) return;
  const store = world.store(worldInstance);
  const marker = await store.get('reorder', itemId);
  if (marker && world.now - marker.updatedAt < 14 * day) return;
  const variant = world.model.variant(itemId);
  const daily = world.model.dailyUnits(variant);
  if (available > daily * suppliers.reorderBelowDays) return;
  const quantity = Math.max(5, Math.ceil(daily * suppliers.reorderCoverDays));
  const result = await erp(world, {
    kind: 'purchase-order',
    supplierId: variant.supplierId,
    deliveryDate: new Date(world.now + suppliers.leadTimeDays * day)
      .toISOString()
      .slice(0, 10),
    lines: [{ itemId, quantity }],
  });
  await store.put(
    'reorder',
    itemId,
    { purchaseOrder: result.id },
    { updatedAt: world.now },
  );
  world.journal(
    'merchant-reorder',
    { itemId, quantity, purchaseOrder: result.id },
    world.model.erp.name,
    result.id,
  );
}

/** Applies a supplier's planned answer; answers that no longer apply are journaled and skipped. */
export async function supplierAnswer(
  world: World,
  command: Record<string, unknown>,
) {
  try {
    await erp(world, command as Parameters<typeof erp>[1]);
  } catch (error) {
    world.journal(
      'supplier-skipped',
      {
        command,
        reason: error instanceof Error ? error.message : 'Rejected',
      },
      world.model.erp.name,
      String(command.orderId ?? ''),
    );

    return;
  }
  // The supplier also answers by email from the account that received the order.
  if (command.kind === 'purchase-order-confirm')
    await supplierConfirmationMail(
      world,
      command as Parameters<typeof supplierConfirmationMail>[1],
    );
}

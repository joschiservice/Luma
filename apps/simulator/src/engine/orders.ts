import { customer } from '@luma/simulator-commerce';
import {
  type IncidentKindName,
  keyedRandom,
  logNormal,
  unit,
} from '@luma/simulator-core';
import { readOrder as readErpOrder } from '@luma/simulator-jtl';
import { readOrder } from '@luma/simulator-shopify';

import { shippingMethods } from './model.js';
import { driftStock } from './stock.js';
import {
  erp,
  erpContext,
  type Incident,
  instance,
  openIncident,
  schedule,
  shop,
  shopContext,
  type World,
  worldInstance,
} from './world.js';

const minute = 60_000;
const hour = 60 * minute;

/** The world's view of one shop order and where the integration took it. */
export interface WorldOrder {
  shop: string;
  /** Numeric Shopify order ID. */
  order: string;
  name: string;
  /** JTL sales order ID once imported. */
  erpOrder: string | null;
  express: boolean;
  lines: { lineItem: string; variant: string; quantity: number }[];
  /** Incident kinds planned for this order's lifecycle. */
  incidents: IncidentKindName[];
  /** Injected incidents waiting for the affected step, by kind. */
  planned?: Partial<Record<IncidentKindName, string>> | undefined;
}

const orderKey = (shopName: string, order: string) => `${shopName}:${order}`;

/** Reads the world's record of a shop order. */
export async function worldOrder(
  world: World,
  shopName: string,
  order: string,
) {
  return (
    await world
      .store(worldInstance)
      .get<WorldOrder>('order', orderKey(shopName, order))
  )?.data;
}

/** Finds the shop order behind a JTL sales order. */
export async function worldOrderForErp(world: World, erpOrder: string) {
  const page = await world
    .store(worldInstance)
    .page<WorldOrder>({ kind: 'order', key: `erp:${erpOrder}`, limit: 1 });

  return page.items[0]?.data;
}

/** Saves the world's record of a shop order. */
export async function saveWorldOrder(world: World, order: WorldOrder) {
  await world
    .store(worldInstance)
    .put('order', orderKey(order.shop, order.order), order, {
      key: order.erpOrder ? `erp:${order.erpOrder}` : null,
      updatedAt: world.now,
    });
}

/**
 * Starts an order's incident at the step it affects. An injected incident planned for this
 * order becomes active with the current time; otherwise a new emerged incident is recorded.
 */
export async function orderIncident(
  world: World,
  order: WorldOrder,
  input: Omit<Parameters<typeof openIncident>[1], 'origin' | 'id' | 'status'>,
) {
  const plannedId = order.planned?.[input.kind];
  const store = world.store(worldInstance);
  const planned = plannedId
    ? await store.get<Incident>('incident', plannedId)
    : undefined;
  if (planned?.data.status !== 'planned')
    return openIncident(world, { ...input, origin: 'emerged' });
  const incident: Incident = {
    ...planned.data,
    ...input,
    status: 'active',
    startedAt: world.now,
  };
  await store.put('incident', incident.id, incident, {
    key: 'active',
    updatedAt: world.now,
  });
  world.journal(
    'incident',
    {
      id: incident.id,
      kind: incident.kind,
      origin: incident.origin,
      summary: incident.summary,
    },
    incident.instance ?? undefined,
  );

  return incident;
}

/** Picks the incident kinds that will affect an order, at the chaos profile's rates. */
export function plannedIncidents(
  world: World,
  shopName: string,
  identity: string,
) {
  if (!world.live) return [];

  return (
    Object.entries(world.run.chaos.incidents) as [IncidentKindName, number][]
  )
    .filter(
      ([kind, rate]) =>
        rate > 0 &&
        world.model.profile.demand.autonomous &&
        !['provider-outage', 'auth-revoked'].includes(kind) &&
        unit(world.run.seed, 'incident', kind, shopName, identity) <
          rate / 1000,
    )
    .map(([kind]) => kind);
}

async function customerFor(
  world: World,
  shopName: string,
  random: ReturnType<typeof keyedRandom>,
) {
  const store = world.store(worldInstance);
  const counter = await store.get<{ count: number }>('customers', shopName);
  const count = counter?.data.count ?? 0;
  const returning =
    count > 0 && random.chance(world.model.profile.customers.returningShare);
  const number = returning ? random.int(1, count) : count + 1;
  const existing = await store.get<{ id: string }>(
    'customer',
    `${shopName}:${number}`,
  );
  if (existing) return existing.data.id;
  const shopInstance = instance(world, shopName);
  const country =
    shopInstance.kind === 'shopify' ? shopInstance.shop.country : 'DE';
  const result = await shop(world, shopName, {
    kind: 'customer',
    customer: customer(world.run.seed, shopName, country, number),
  });
  await store.put('customer', `${shopName}:${number}`, { id: result.id });
  await store.put('customers', shopName, { count: Math.max(count, number) });

  return result.id;
}

/**
 * Places a shop order like a customer checkout, then plans payment, integration import and
 * possible cancellation. Explicit lines bypass the shop's assortment.
 */
export async function placeOrder(
  world: World,
  shopName: string,
  options: {
    identity: string;
    lines?: { variant: string; quantity: number }[] | undefined;
    shipping?: 'standard' | 'express' | undefined;
    id?: string | undefined;
    /** Injected incidents this order carries, by kind. */
    planned?: Partial<Record<IncidentKindName, string>> | undefined;
    /**
     * `payment-stuck`: the payment stays pending and never settles. `manual`: paid, but the
     * merchant handles it by hand, so it's never imported, cancelled or shipped by the world.
     */
    handling?: 'payment-stuck' | 'manual' | undefined;
  },
) {
  const random = keyedRandom(
    world.run.seed,
    'order',
    shopName,
    options.identity,
  );
  const shopInstance = instance(world, shopName);
  if (shopInstance.kind !== 'shopify')
    throw new Error('Orders are placed in shops');
  const profile = world.model.profile;
  const lines =
    options.lines?.map((line) => ({
      variant: world.model.variant(line.variant),
      quantity: line.quantity,
    })) ?? world.model.basket(shopName, random);
  const express =
    (options.shipping ??
      (random.chance(profile.basket.expressShare) ? 'express' : 'standard')) ===
    'express';
  const incidents = [
    ...new Set([
      ...plannedIncidents(world, shopName, options.identity),
      ...(Object.keys(options.planned ?? {}) as IncidentKindName[]),
    ]),
  ].filter((kind) => kind !== 'shipping-method-mismatch' || express);
  const stuck = options.handling === 'payment-stuck';
  const manual = !!options.handling;
  const pending =
    stuck ||
    (!manual &&
      random.chance(
        profile.payments.pendingRate + profile.payments.failedRate,
      ));
  const fraudCheck = random.chance(profile.payments.fraudCheckRate);
  const holds =
    incidents.includes('fraud-hold') || fraudCheck
      ? ['HIGH_RISK_OF_FRAUD' as const]
      : [];
  const customerId =
    profile.name === 'test' ? null : await customerFor(world, shopName, random);
  const result = await shop(world, shopName, {
    kind: 'order',
    ...(options.id ? { id: options.id } : {}),
    customer: customerId,
    lines: lines.map(({ variant, quantity }) => ({
      variant: variant.id,
      quantity,
      price: (variant.price * shopInstance.shop.priceFactor).toFixed(2),
    })),
    location: shopInstance.shop.warehouse,
    shipping: express ? 'express' : 'standard',
    financialStatus: pending ? 'PENDING' : 'PAID',
    holds,
  });
  const order: WorldOrder = {
    shop: shopName,
    order: result.id,
    name: result.name ?? result.id,
    erpOrder: null,
    express,
    lines: (result.lines ?? []).map((line) => ({
      lineItem: line.id,
      variant: line.variant,
      quantity: line.quantity,
    })),
    incidents,
    planned: options.planned,
  };
  await saveWorldOrder(world, order);
  world.metric('orders.created', 1, shopName);
  world.journal(
    'order',
    { name: order.name, lines: order.lines.length, express },
    shopName,
    result.gid,
  );
  for (const kind of incidents) {
    if (kind === 'fraud-hold')
      await orderIncident(world, order, {
        kind,
        instance: shopName,
        summary: `${order.name} is held for fraud review and nobody releases it.`,
        resources: [
          {
            instance: shopName,
            kind: 'Order',
            id: result.gid,
            label: order.name,
          },
        ],
        detail: {},
      });
    if (kind === 'inventory-drift' || kind === 'oversell') {
      await driftStock(
        world,
        kind,
        shopName,
        lines[0]!.variant.id,
        'emerged',
      ).catch(() => undefined);
    }
  }
  if (fraudCheck && !incidents.includes('fraud-hold'))
    await schedule(
      world,
      world.now + logNormal(random, 2 * hour, 24 * hour),
      'release-hold',
      {
        shop: shopName,
        order: order.order,
      },
    );
  // Injected orders only progress through their incident.
  if (pending && !manual)
    await schedule(
      world,
      world.now + logNormal(random, 20 * minute, 8 * hour),
      'payment',
      {
        shop: shopName,
        order: order.order,
        paid:
          random.next() <
          profile.payments.pendingRate /
            (profile.payments.pendingRate + profile.payments.failedRate),
      },
    );
  else if (!pending && !manual) await planImport(world, order);
  if (!manual && random.chance(profile.cancellations.rate))
    await schedule(
      world,
      world.now + logNormal(random, 30 * minute, 6 * hour),
      'customer-cancel',
      {
        shop: shopName,
        order: order.order,
      },
    );

  return order;
}

async function planImport(world: World, order: WorldOrder) {
  if (order.incidents.includes('order-import-failure')) {
    await orderIncident(world, order, {
      kind: 'order-import-failure',
      instance: order.shop,
      summary: `The integration dropped ${order.name}; it never reaches the ERP.`,
      resources: [
        {
          instance: order.shop,
          kind: 'Order',
          id: `gid://shopify/Order/${order.order}`,
          label: order.name,
        },
      ],
      detail: {},
    });

    return;
  }
  const lag = world.model.profile.integration.orderLag;
  await schedule(
    world,
    world.now +
      logNormal(
        keyedRandom(world.run.seed, 'import', order.shop, order.order),
        lag.medianMs,
        lag.p99Ms,
      ),
    'import-order',
    { shop: order.shop, order: order.order },
  );
}

/**
 * Imports a paid shop order into the ERP and queues it for its warehouse. Fixtures pass an
 * explicit ERP order ID.
 */
export async function importOrder(
  world: World,
  shopName: string,
  orderId: string,
  erpId?: string,
) {
  const order = await worldOrder(world, shopName, orderId);
  if (!order || order.erpOrder) return;
  const current = await readOrder(shopContext(world, shopName), orderId);
  if (!current || current.cancelled) return;
  const shopInstance = instance(world, shopName);
  if (shopInstance.kind !== 'shopify') return;
  // The integration skips held orders and looks again on its next pass.
  if (current.holds.length) {
    await schedule(world, world.now + 15 * minute, 'import-order', {
      shop: shopName,
      order: orderId,
    });

    return;
  }
  const mismatch = order.incidents.includes('shipping-method-mismatch');
  const result = await erp(world, {
    kind: 'order',
    ...(erpId ? { id: erpId } : {}),
    externalNumber: order.name.replace(/^#/, ''),
    lines: order.lines.map((line) => {
      const variant = world.model.variant(line.variant);

      return {
        itemId: variant.id,
        quantity: line.quantity,
        price: Number(
          (variant.price * shopInstance.shop.priceFactor).toFixed(2),
        ),
      };
    }),
    shippingMethodId:
      order.express && !mismatch
        ? shippingMethods.express
        : shippingMethods.standard,
    currency: shopInstance.shop.currency,
    paid: true,
    warehouse: shopInstance.shop.warehouse,
  });
  order.erpOrder = result.id;
  await saveWorldOrder(world, order);
  const stalled = order.incidents.includes('warehouse-stall');
  await world.store(worldInstance).put(
    'pick',
    result.id,
    { shop: shopName, order: orderId, stalled },
    {
      key: shopInstance.shop.warehouse,
      // A stalled order is never eligible for picking.
      updatedAt: stalled ? Number.MAX_SAFE_INTEGER : world.now,
    },
  );
  world.journal(
    'order-imported',
    { name: order.name, erpOrder: result.id },
    'jtl',
    result.id,
  );
  if (mismatch)
    await orderIncident(world, order, {
      kind: 'shipping-method-mismatch',
      instance: 'jtl',
      summary: `${order.name} was paid as express but imported with standard shipping.`,
      resources: [
        {
          instance: 'jtl',
          kind: 'salesOrder',
          id: result.id,
          label: `JTL order ${result.id}`,
        },
        {
          instance: shopName,
          kind: 'Order',
          id: `gid://shopify/Order/${orderId}`,
          label: order.name,
        },
      ],
      detail: {},
    });
  if (stalled)
    await orderIncident(world, order, {
      kind: 'warehouse-stall',
      instance: 'jtl',
      summary: `The warehouse never picks ${order.name}.`,
      resources: [
        {
          instance: 'jtl',
          kind: 'salesOrder',
          id: result.id,
          label: `JTL order ${result.id}`,
        },
        {
          instance: shopName,
          kind: 'Order',
          id: `gid://shopify/Order/${orderId}`,
          label: order.name,
        },
      ],
      detail: {},
    });
}

/** Applies a delayed payment result; failed payments cancel the order. */
export async function settlePayment(
  world: World,
  shopName: string,
  orderId: string,
  paid: boolean,
) {
  const order = await worldOrder(world, shopName, orderId);
  const current =
    order && (await readOrder(shopContext(world, shopName), orderId));
  // The customer may have cancelled while the payment was pending.
  if (!order || !current || current.cancelled) return;
  if (paid) {
    await shop(world, shopName, { kind: 'paid', order: orderId });
    await planImport(world, order);

    return;
  }
  await shop(world, shopName, {
    kind: 'cancel',
    order: orderId,
    reason: 'DECLINED',
  });
  world.metric('orders.cancelled', 1, shopName);
}

/** Cancels an order at the customer's request unless the warehouse already shipped part of it. */
export async function cancelOrder(
  world: World,
  shopName: string,
  orderId: string,
) {
  const order = await worldOrder(world, shopName, orderId);
  if (!order) return;
  const current = await readOrder(shopContext(world, shopName), orderId);
  if (!current || current.cancelled || current.fulfillments.length) return;
  // Once the warehouse shipped any unit, the parcel is on its way and the request comes too late.
  const erpOrder = order.erpOrder
    ? await readErpOrder(erpContext(world), order.erpOrder)
    : undefined;
  if (erpOrder?.lines.some((line) => line.open < line.quantity)) {
    world.journal(
      'cancel-too-late',
      { name: order.name },
      shopName,
      current.gid,
    );

    return;
  }
  await shop(world, shopName, {
    kind: 'cancel',
    order: orderId,
    reason: 'CUSTOMER',
  });
  if (order.erpOrder) {
    await erp(world, { kind: 'cancel', id: order.erpOrder });
    await world.store(worldInstance).delete('pick', order.erpOrder);
  }
  world.metric('orders.cancelled', 1, shopName);
}

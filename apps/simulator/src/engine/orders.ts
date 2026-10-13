import { businessCustomer, customer, days } from '@luma/simulator-commerce';
import {
  type IncidentKindName,
  keyedRandom,
  logNormal,
  unit,
} from '@luma/simulator-core';
import { readOrder as readErpOrder } from '@luma/simulator-jtl';
import { readOrder } from '@luma/simulator-shopify';

import type { Pick } from './fulfillment.js';
import { shippingMethods } from './model.js';
import { driftStock } from './stock.js';
import {
  erp,
  erpContext,
  erpResource,
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
  /** Number of the shop customer who placed the order; absent for guest checkouts. */
  customer?: number | null | undefined;
}

const orderKey = (shopName: string, order: string) => `${shopName}:${order}`;

/**
 * The gross unit price an ERP books for a line whose shop added tax at checkout. Shopify rounds
 * tax per line, so the unit price keeps four decimals and the line totals match the shop's.
 */
const grossUnitPrice = (net: number, quantity: number, rate: number) => {
  const cents = Math.round(net * 100 * quantity);

  return (
    Math.round(((cents + Math.round(cents * rate)) / quantity) * 100) / 10_000
  );
};

/** A tax fraction as the percentage ERPs record, without floating-point noise. */
const percent = (rate: number) => Math.round(rate * 100_000) / 1_000;

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
function plannedIncidents(world: World, shopName: string, identity: string) {
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
  if (existing) return { id: existing.data.id, number };
  const shopInstance = instance(world, shopName);
  const country =
    shopInstance.kind === 'shopify' ? shopInstance.shop.country : 'DE';
  const result = await shop(world, shopName, {
    kind: 'customer',
    customer: customer(world.run.seed, shopName, country, number),
  });
  await store.put('customer', `${shopName}:${number}`, { id: result.id });
  await store.put('customers', shopName, { count: Math.max(count, number) });

  return { id: result.id, number };
}

/** The shop customer as the order integration transfers it to the ERP. */
function erpCustomer(world: World, shopName: string, number: number) {
  const shopInstance = instance(world, shopName);
  const country =
    shopInstance.kind === 'shopify' ? shopInstance.shop.country : 'DE';
  const person = customer(world.run.seed, shopName, country, number);

  return {
    email: person.email,
    firstName: person.firstName,
    lastName: person.lastName,
    phone: person.phone,
    street: person.address.address1,
    city: person.address.city,
    postalCode: person.address.zip,
    countryIso: person.address.countryCode,
  };
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
  const buyer = await customerFor(world, shopName, random);
  // Discounts and tags draw from their own stream, so the rest of the world stays unchanged.
  const extras = keyedRandom(
    world.run.seed,
    'order-extras',
    shopName,
    options.identity,
  );
  const discounts = extras.chance(0.15)
    ? [{ kind: 'code' as const, label: 'WELCOME10', percentage: 10 }]
    : extras.chance(0.1)
      ? [{ kind: 'automatic' as const, label: 'Seasonal sale', percentage: 5 }]
      : [];
  const tags = [
    ...(express ? ['express'] : []),
    ...(extras.chance(0.1) ? ['gift'] : []),
  ];
  const result = await shop(world, shopName, {
    kind: 'order',
    ...(options.id ? { id: options.id } : {}),
    customer: buyer?.id ?? null,
    ...(discounts.length ? { discounts } : {}),
    ...(tags.length ? { tags } : {}),
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
    customer: buyer?.number ?? null,
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
  const tax = shopInstance.shop.tax;
  const result = await erp(world, {
    kind: 'order',
    ...(erpId ? { id: erpId } : {}),
    externalNumber: order.name.replace(/^#/, ''),
    ...(order.customer
      ? { customer: erpCustomer(world, shopName, order.customer) }
      : {}),
    lines: order.lines.map((line) => {
      const variant = world.model.variant(line.variant);
      const price = Number(
        (variant.price * shopInstance.shop.priceFactor).toFixed(2),
      );

      return {
        itemId: variant.id,
        quantity: line.quantity,
        price: tax.included
          ? price
          : grossUnitPrice(price, line.quantity, tax.rate),
      };
    }),
    taxRate: percent(tax.rate),
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
    world.model.erp.name,
    result.id,
  );
  if (mismatch)
    await orderIncident(world, order, {
      kind: 'shipping-method-mismatch',
      instance: world.model.erp.name,
      summary: `${order.name} was paid as express but imported with standard shipping.`,
      resources: [
        erpResource(world, 'salesOrder', result.id),
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
      instance: world.model.erp.name,
      summary: `The warehouse never picks ${order.name}.`,
      resources: [
        erpResource(world, 'salesOrder', result.id),
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

/**
 * Books a retail account's wholesale order directly in the ERP and queues it for its
 * warehouse. No shop order exists for it; the account pays its invoice after its payment terms.
 */
export async function placeWholesaleOrder(world: World, identity: string) {
  const wholesale = world.model.profile.wholesale;
  if (!wholesale) return;
  const random = keyedRandom(world.run.seed, 'wholesale', identity);
  const account = businessCustomer(
    world.run.seed,
    wholesale.country,
    random.int(1, wholesale.accounts),
  );
  const lines = world.model.wholesaleBasket(random);
  if (!lines.length) return;
  const result = await erp(world, {
    kind: 'order',
    customer: {
      email: account.email,
      firstName: account.firstName,
      lastName: account.lastName,
      company: account.company,
      phone: account.phone,
      street: account.address.address1,
      city: account.address.city,
      postalCode: account.address.zip,
      countryIso: account.address.countryCode,
    },
    // Wholesale prices are net; the ERP books them with tax added.
    lines: lines.map(({ variant, quantity }) => ({
      itemId: variant.id,
      quantity,
      price: Number(
        (
          Number((variant.price * wholesale.priceFactor).toFixed(2)) *
          (1 + wholesale.taxRate)
        ).toFixed(2),
      ),
    })),
    taxRate: percent(wholesale.taxRate),
    shippingMethodId: shippingMethods.standard,
    currency: world.model.profile.currency.base,
    paid: false,
    warehouse: wholesale.warehouse,
  });
  const pick: Pick = { shop: null, order: null, stalled: false };
  await world.store(worldInstance).put('pick', result.id, pick, {
    key: wholesale.warehouse,
    updatedAt: world.now,
  });
  await schedule(
    world,
    world.now + days(random, wholesale.paymentDays),
    'wholesale-payment',
    { erpOrder: result.id },
  );
  world.metric('orders.wholesale', 1, world.model.erp.name);
  world.journal(
    'wholesale-order',
    { account: account.company, lines: lines.length },
    world.model.erp.name,
    result.id,
  );
}

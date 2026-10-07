import type { InjectIncident } from '@luma/simulator-contract';
import { type IncidentKindName, incidentKinds } from '@luma/simulator-core';
import type { SupplierProfile } from '@luma/simulator-jtl';

import { syncShipment } from './fulfillment.js';
import { shippingMethods } from './model.js';
import {
  importOrder,
  placeOrder,
  saveWorldOrder,
  settlePayment,
  worldOrder,
} from './orders.js';
import { driftStock, recoverDrift } from './stock.js';
import {
  closeIncident,
  type EngineEvents,
  erp,
  erpContext,
  type Incident,
  instance,
  openIncident,
  shop,
  type World,
  worldInstance,
} from './world.js';

/** Kinds that start when an injected order reaches a later step, such as shipping. */
const orderKinds = new Set<IncidentKindName>([
  'order-import-failure',
  'warehouse-stall',
  'shipment-sync-failure',
  'fraud-hold',
  'carrier-delay',
  'lost-parcel',
  'refund-failure',
  'shipping-method-mismatch',
]);

function firstShop(world: World, name?: string) {
  const found = name
    ? world.model.shops.find((item) => item.name === name)
    : world.model.shops[0];
  if (!found) throw new Error(`Unknown shop ${name}`);

  return found;
}

/** Resolves an injection target to a variant listed in the shop; defaults to its bestseller. */
function targetVariant(world: World, shopName: string, target?: string) {
  if (target) {
    const variant =
      world.model.variantBySku(target) ?? world.model.variant(target);
    if (!variant.shops.includes(shopName))
      throw new Error(`${shopName} does not list ${variant.sku}`);

    return variant;
  }
  const listed = world.model.catalog.variants.filter((variant) =>
    variant.shops.includes(shopName),
  );

  return listed.reduce((best, variant) =>
    variant.popularity > best.popularity ? variant : best,
  );
}

/**
 * Injects an operational incident now. Stock and provider incidents start immediately; order
 * incidents place a new order that carries the incident and start when it reaches that step.
 * Repeating a request ID returns the existing incident without another change.
 */
export async function injectIncident(world: World, input: InjectIncident) {
  const store = world.store(worldInstance);
  const existing = await store.get<Incident>('incident', input.id);
  if (existing) return existing.data;
  const kind = input.kind;
  if (kind === 'inventory-drift' || kind === 'oversell') {
    const shopName = firstShop(world, input.instance).name;
    const variant = targetVariant(world, shopName, input.target);
    const incident = await driftStock(
      world,
      kind,
      shopName,
      variant.id,
      'injected',
      {
        id: input.id,
      },
    );
    if (!incident)
      throw new Error(`${variant.sku} already drifts in ${shopName}`);

    return incident;
  }
  if (kind === 'provider-outage' || kind === 'auth-revoked') {
    const target = instance(
      world,
      input.instance ?? world.model.shops[0]!.name,
    );
    if (world.run.health[target.name]?.until !== undefined)
      throw new Error(`${target.label} already has a provider incident`);
    const duration = (kind === 'auth-revoked' ? 60 : 30) * 60_000;
    const incident = await openIncident(world, {
      id: input.id,
      kind,
      origin: 'injected',
      instance: target.name,
      summary: `${target.label} ${kind === 'auth-revoked' ? 'rejects Luma’s credentials' : 'is unavailable'} for ${duration / 60_000} minutes.`,
      resources: [
        {
          instance: target.name,
          kind: 'connection',
          id: target.name,
          label: target.label,
        },
      ],
      detail: { durationMs: duration },
    });
    world.run.health[target.name] = {
      status: kind === 'auth-revoked' ? 'unauthorized' : 'unavailable',
      until: world.now + duration,
      incident: incident.id,
    };

    return incident;
  }
  if (kind === 'refund-missing') return refundMissing(world, input);
  if (kind === 'payment-stuck') {
    const shopName = firstShop(world, input.instance).name;
    const order = await placeOrder(world, shopName, {
      identity: `injected:${input.id}`,
      handling: 'payment-stuck',
    });

    return openIncident(world, {
      id: input.id,
      kind,
      origin: 'injected',
      instance: shopName,
      summary: `The payment for ${order.name} stays pending.`,
      resources: [orderResource(shopName, order.order, order.name)],
      detail: { order: order.order },
    });
  }
  if (kind === 'supplier-silent') {
    const store = erpContext(world).store;
    const suppliers = await store.page<{ id: string; profile: string }>({
      kind: 'supplier',
      limit: 500,
    });
    const profiles = Object.fromEntries(
      suppliers.items.map((item) => [item.id, item.data.profile]),
    );
    for (const id of Object.keys(profiles))
      await erp(world, {
        kind: 'supplier-profile',
        supplierId: id,
        profile: 'silent',
      });

    return openIncident(world, {
      id: input.id,
      kind,
      origin: 'injected',
      instance: 'jtl',
      summary: `${Object.keys(profiles).length} suppliers stop confirming new purchase orders.`,
      resources: [],
      detail: { profiles },
    });
  }
  if (!orderKinds.has(kind)) throw new Error(`Cannot inject ${kind}`);
  const shopName = firstShop(world, input.instance).name;
  const variant = input.target
    ? targetVariant(world, shopName, input.target)
    : undefined;
  const incident = await openIncident(world, {
    id: input.id,
    kind,
    origin: 'injected',
    status: 'planned',
    instance: shopName,
    summary: `${incidentKinds[kind].label} planned for the next ${shopName} order.`,
    resources: [],
    detail: {},
  });
  const order = await placeOrder(world, shopName, {
    identity: `injected:${input.id}`,
    planned: { [kind]: incident.id },
    ...(variant ? { lines: [{ variant: variant.id, quantity: 1 }] } : {}),
    ...(kind === 'shipping-method-mismatch'
      ? { shipping: 'express' as const }
      : {}),
  });
  const current = (await store.get<Incident>('incident', incident.id))!.data;
  if (current.status === 'planned') {
    const planned = {
      ...current,
      summary: `${incidentKinds[kind].label} planned for ${order.name}.`,
      resources: [
        {
          instance: shopName,
          kind: 'Order',
          id: `gid://shopify/Order/${order.order}`,
          label: order.name,
        },
      ],
      detail: { order: order.order },
    };
    await store.put('incident', incident.id, planned, { key: 'planned' });

    return planned;
  }

  return current;
}

const orderResource = (shopName: string, order: string, name: string) => ({
  instance: shopName,
  kind: 'Order',
  id: `gid://shopify/Order/${order}`,
  label: name,
});

/**
 * Places an order the merchant ships by hand, returns one unit and receives it at once. No refund
 * is planned, so the return waits for a refund until the incident is recovered.
 */
async function refundMissing(world: World, input: InjectIncident) {
  const shopName = firstShop(world, input.instance).name;
  const order = await placeOrder(world, shopName, {
    identity: `injected:${input.id}`,
    handling: 'manual',
  });
  await shop(world, shopName, {
    kind: 'fulfill',
    order: order.order,
    carrier: 'DHL',
    trackingNumber: `MANUAL-${order.order}`,
    trackingUrl: 'https://tracking.example.test/manual',
  });
  // Keeps the merchant world from planning its own return for this order.
  await world
    .store(worldInstance)
    .put(
      'return',
      `${shopName}:${order.order}`,
      { step: 'injected' },
      { updatedAt: world.now },
    );
  await shop(world, shopName, {
    kind: 'return',
    order: order.order,
    lines: [{ lineItem: order.lines[0]!.lineItem, quantity: 1 }],
    reason: 'Changed my mind',
  });
  await shop(world, shopName, { kind: 'return-approve', order: order.order });
  await shop(world, shopName, { kind: 'return-receive', order: order.order });

  return openIncident(world, {
    id: input.id,
    kind: 'refund-missing',
    origin: 'injected',
    instance: shopName,
    summary: `The return for ${order.name} arrived, but nobody refunds the customer.`,
    resources: [orderResource(shopName, order.order, order.name)],
    detail: { order: order.order },
  });
}

/**
 * Repairs an incident the way the merchant would and records it as recovered. Stock sync
 * resumes, outages end, held or dropped orders continue, and wrong shipping methods are fixed.
 */
export async function recoverIncident(world: World, id: string) {
  const record = await world.store(worldInstance).get<Incident>('incident', id);
  if (!record) throw new Error('Incident not found');
  const incident = record.data;
  if (incident.status === 'recovered') return incident;
  const order =
    incident.resources
      .find((resource) => resource.kind === 'Order')
      ?.id.split('/')
      .pop() ?? (incident.detail.order as string | undefined);
  const shopName = incident.instance ?? '';
  if (incident.kind === 'inventory-drift' || incident.kind === 'oversell')
    await recoverDrift(world, incident);
  else if (
    incident.kind === 'provider-outage' ||
    incident.kind === 'auth-revoked'
  )
    delete world.run.health[incident.instance ?? ''];
  else if (incident.kind === 'supplier-silent')
    for (const [supplierId, profile] of Object.entries(
      (incident.detail.profiles ?? {}) as Record<string, SupplierProfile>,
    ))
      await erp(world, {
        kind: 'supplier-profile',
        supplierId,
        profile,
      });
  else if (incident.kind === 'refund-missing' && order)
    await shop(world, shopName, { kind: 'refund', order, outcome: 'success' });
  else if (incident.kind === 'payment-stuck' && order)
    await settlePayment(world, shopName, order, true);
  else if (order && incident.status === 'active') {
    const worldRecord = await worldOrder(world, shopName, order);
    if (incident.kind === 'order-import-failure' && worldRecord) {
      worldRecord.incidents = worldRecord.incidents.filter(
        (kind) => kind !== incident.kind,
      );
      await saveWorldOrder(world, worldRecord);
      await importOrder(world, shopName, order);
    } else if (incident.kind === 'warehouse-stall' && worldRecord?.erpOrder) {
      const pick = await world
        .store(worldInstance)
        .get('pick', worldRecord.erpOrder);
      if (pick)
        await world
          .store(worldInstance)
          .put(
            'pick',
            pick.id,
            { ...(pick.data as object), stalled: false },
            { updatedAt: world.now },
          );
    } else if (incident.kind === 'fraud-hold')
      await shop(world, shopName, { kind: 'release', order }).catch(
        () => undefined,
      );
    else if (
      incident.kind === 'shipment-sync-failure' &&
      incident.detail.shipmentSync
    )
      await syncShipment(
        world,
        incident.detail.shipmentSync as EngineEvents['shipment-sync'],
      );
    else if (
      incident.kind === 'shipping-method-mismatch' &&
      worldRecord?.erpOrder
    )
      await erp(world, {
        kind: 'shipping-method',
        id: worldRecord.erpOrder,
        shippingMethodId: shippingMethods.express,
      });
  }

  return closeIncident(world, id, 'Recovered from the control panel');
}

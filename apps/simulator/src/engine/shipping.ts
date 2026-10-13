import type { WorldOrder } from './orders.js';
import { shipping, type World, worldInstance } from './world.js';

/** Imports an exact shop order into its separate shipping account; records explicit world provenance. */
export async function importShippingOrder(world: World, order: WorldOrder) {
  const store = world.store(worldInstance);
  const key = `${order.shop}:${order.order}`;
  const existing = await store.get<{ id: string }>('shipping-order', key);
  if (existing) return existing.data.id;
  const id = String(await store.sequence('shipping-order'));
  const at = new Date(world.now).toISOString();
  await shipping(world, {
    kind: 'order',
    order: {
      order_id: Number(id),
      order_number: order.name,
      order_date: at,
      last_updated_date: at,
      status: 'Unshipped',
      destination: {},
      packages: [],
      items: order.lines.map((line) => {
        const variant = world.model.variant(line.variant);

        return {
          item_id: Number(line.lineItem),
          sku: variant.sku,
          description: world.model.product(variant.productId).title,
          quantity: line.quantity,
          quantity_to_ship: line.quantity,
          weight: 0.2,
          value: variant.price,
        };
      }),
    },
  });
  await store.put('shipping-order', key, { id }, { updatedAt: world.now });

  return id;
}

/** Records a split or partial warehouse shipment before the commerce platform receives it. */
export async function shipParcel(
  world: World,
  order: WorldOrder,
  input: {
    lines: { variant: string; quantity: number }[];
    carrier: string;
    trackingNumber: string;
    trackingUrl: string;
  },
) {
  const id = await importShippingOrder(world, order);
  const packageId = await world
    .store(worldInstance)
    .sequence('shipping-package');
  const at = new Date(world.now).toISOString();
  await shipping(world, {
    kind: 'ship',
    order: id,
    parcel: {
      package_id: packageId,
      tracking_number: input.trackingNumber,
      tracking_url: input.trackingUrl,
      carrier: input.carrier,
      status: 'In Transit',
      shipment_date: at,
      last_updated_date: at,
      items: input.lines.map((line) => {
        const exact = order.lines.find(
          (value) => value.variant === line.variant,
        );
        if (!exact) throw new Error('Missing exact shop line provenance');

        return { item_id: Number(exact.lineItem), quantity: line.quantity };
      }),
      tracking_events: [
        {
          status: 'In Transit',
          description: 'Carrier accepted parcel',
          event_date: at,
        },
      ],
    },
  });

  return { order: id, package: packageId };
}

/** Applies carrier evidence only to the parcel linked when the shop shipment was booked. */
export async function trackParcel(
  world: World,
  shop: string,
  fulfillment: string,
  status: string,
) {
  const binding = await world
    .store(worldInstance)
    .get<{ order: string; package: number }>(
      'shipping-fulfillment',
      `${shop}:${fulfillment}`,
    );
  if (binding)
    await shipping(world, {
      kind: 'tracking',
      ...binding.data,
      status: status === 'FAILURE' ? 'Failed' : status,
    });
}

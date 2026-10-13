import { createHash } from 'node:crypto';

import type { FulfillmentSnapshot, OrderSnapshot } from '@luma/connections';
import * as s from '@luma/connector-starshipit/schemas';
import type { z } from 'zod';

/** Builds opaque source references; line IDs retain their order namespace. */
export const ref = (externalId: string, scopeKey = '') => ({
  externalId,
  scopeKey,
});

/** Fingerprints the mutable order facts reviewed by a shipping correction. */
export const revision = (order: z.infer<typeof s.order>) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        id: order.order_id,
        status: order.status ?? order.order_status,
        items: [...order.items].sort((a, b) =>
          a.item_id.localeCompare(b.item_id),
        ),
      }),
    )
    .digest('hex');
const quantity = (amount: string) => ({ amount: String(amount), unit: 'each' });

/** Shipping records describe source quantities; SKU text and order numbers never establish identity. */
export function orderSnapshot(order: z.infer<typeof s.order>): OrderSnapshot {
  return {
    displayNumber: order.order_number,
    externalOrderNumber: order.order_number,
    placedAt: order.order_date,
    status: 'unknown',
    paymentStatus: 'unknown',
    lines: order.items
      .filter((line) => Number(line.quantity) > 0)
      .map((line) => ({
        id: ref(line.item_id, order.order_id),
        sku: null,
        skuCode: line.sku,
        title: line.description,
        quantity: quantity(line.quantity),
        currentQuantity: quantity(line.quantity),
        cancelledQuantity: null,
      })),
  };
}

const delivery = (
  value: string | null,
): NonNullable<FulfillmentSnapshot['delivery']> | null => {
  switch (value?.toLowerCase()) {
    case 'delivered':
      return 'delivered';
    case 'in transit':
    case 'in_transit':
    case 'collected':
    case 'picked up':
      return 'in_transit';
    case 'out for delivery':
      return 'out_for_delivery';
    case 'printed':
    case 'awaiting dispatch':
      return 'label_created';
    case 'delivery attempted':
    case 'attempted delivery':
      return 'attempted_delivery';
    case 'delayed':
      return 'delayed';
    case 'ready for pickup':
      return 'ready_for_pickup';
    case 'failed':
    case 'exception':
      return 'failed';
    default:
      return null;
  }
};
const url = (value: string | null) =>
  value && /^https?:\/\//i.test(value) ? value : null;

/** Labels do not establish carrier handoff. Ambiguous split shipments carry no inferred line quantities. */
export function fulfillmentSnapshots(
  order: z.infer<typeof s.order>,
  tracks: z.infer<typeof s.tracking>[],
) {
  const work: FulfillmentSnapshot = {
    order: ref(order.order_id),
    kind: 'fulfillment_order',
    status:
      (order.status ?? order.order_status)?.toLowerCase() === 'unshipped'
        ? 'pending'
        : (order.status ?? order.order_status)?.toLowerCase() === 'printed'
          ? 'processing'
          : 'unknown',
    lines: order.items.map((line) => ({
      orderLine: ref(line.item_id, order.order_id),
      quantity: quantity(line.quantity),
      ...(line.quantity_to_ship === undefined
        ? {}
        : { remainingQuantity: quantity(line.quantity_to_ship) }),
    })),
    lastProgressAt: null,
    failureCode: null,
    shipping: { stage: 'unknown', sourceUrl: null, trackingUpdatedAt: null },
  };
  const byNumber = new Map<string, z.infer<typeof s.tracking>>();
  for (const track of tracks) {
    if (!track.tracking_number) continue;
    const prior = byNumber.get(track.tracking_number);
    if (
      !prior ||
      (track.last_updated_date &&
        (!prior.last_updated_date ||
          track.last_updated_date > prior.last_updated_date))
    )
      byNumber.set(track.tracking_number, track);
    else if (
      track.last_updated_date === prior.last_updated_date &&
      track.tracking_status !== prior.tracking_status
    )
      byNumber.set(track.tracking_number, { ...prior, tracking_status: null });
  }
  const unique = [...byNumber.values()];
  const shipments = unique.map((track) => {
    const state = delivery(track.tracking_status);
    const dispatched =
      state &&
      [
        'in_transit',
        'out_for_delivery',
        'attempted_delivery',
        'delivered',
      ].includes(state);
    // The documented remaining quantity covers the whole order. It allocates a shipment only
    // when there is exactly one package and tracking identity and all items have left that order.
    const fullOrder =
      dispatched &&
      unique.length === 1 &&
      order.packages?.length === 1 &&
      (order.status ?? order.order_status)?.toLowerCase() === 'shipped' &&
      order.items.every((line) => line.quantity_to_ship === '0');
    const data: FulfillmentSnapshot = {
      order: ref(order.order_id),
      kind: 'shipment',
      status:
        state === 'delivered'
          ? 'delivered'
          : dispatched
            ? 'shipped'
            : state === 'failed'
              ? 'failed'
              : 'processing',
      lines: fullOrder
        ? order.items
            .filter((line) => Number(line.quantity) > 0)
            .map((line) => ({
              orderLine: ref(line.item_id, order.order_id),
              quantity: quantity(line.quantity),
            }))
        : [],
      lastProgressAt: track.last_updated_date,
      failureCode: state === 'failed' ? 'carrier_failure' : null,
      tracking: [
        {
          carrier: track.carrier_name,
          number: track.tracking_number,
          url: url(track.tracking_url),
        },
      ],
      delivery: state,
      milestones: { shippedAt: dispatched ? track.shipment_date : null },
      shipping: {
        stage:
          state === 'delivered'
            ? 'delivered'
            : dispatched
              ? 'carrier'
              : 'unknown',
        sourceUrl: url(track.tracking_url),
        trackingUpdatedAt: track.last_updated_date,
      },
    };

    return {
      id: `tracking:${order.order_id}:${track.tracking_number}`,
      data,
      sourceUpdatedAt: track.last_updated_date,
    };
  });

  return [
    { id: `work:${order.order_id}`, data: work, sourceUpdatedAt: null },
    ...shipments,
  ];
}

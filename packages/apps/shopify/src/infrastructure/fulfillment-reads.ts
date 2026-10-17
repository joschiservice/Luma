import type { FulfillmentSnapshot } from '@luma/connections';
import { z } from 'zod';

import {
  quantity,
  type ReadSession,
  ref,
  statusFrom,
  text,
} from './read-session.js';
import * as s from './schemas.js';

const workStatuses: Record<string, FulfillmentSnapshot['status']> = {
  OPEN: 'pending',
  SCHEDULED: 'pending',
  ON_HOLD: 'pending',
  IN_PROGRESS: 'processing',
  CLOSED: 'completed',
  CANCELLED: 'cancelled',
  INCOMPLETE: 'failed',
};

const shipmentStatuses: Record<string, FulfillmentSnapshot['status']> = {
  PENDING: 'pending',
  OPEN: 'processing',
  SUCCESS: 'shipped',
  CANCELLED: 'cancelled',
  ERROR: 'failed',
  FAILURE: 'failed',
};

const holdReasons: Record<
  string,
  NonNullable<FulfillmentSnapshot['holds']>[number]['reason']
> = {
  AWAITING_PAYMENT: 'awaiting_payment',
  HIGH_RISK_OF_FRAUD: 'high_risk_of_fraud',
  INCORRECT_ADDRESS: 'incorrect_address',
  INVENTORY_OUT_OF_STOCK: 'inventory_out_of_stock',
  UNKNOWN_DELIVERY_DATE: 'unknown_delivery_date',
  AWAITING_RETURN_ITEMS: 'awaiting_return_items',
};

const methodTypes: Record<
  string,
  NonNullable<FulfillmentSnapshot['method']>['type']
> = {
  SHIPPING: 'shipping',
  PICK_UP: 'pick_up',
  PICKUP_POINT: 'pickup_point',
  LOCAL: 'local',
  RETAIL: 'retail',
  NONE: 'none',
};

// Label and confirmation states say nothing about the carrier; they stay unreported.
const deliveryStates: Record<
  string,
  NonNullable<FulfillmentSnapshot['delivery']>
> = {
  LABEL_PRINTED: 'label_created',
  LABEL_PURCHASED: 'label_created',
  CARRIER_PICKED_UP: 'in_transit',
  IN_TRANSIT: 'in_transit',
  OUT_FOR_DELIVERY: 'out_for_delivery',
  ATTEMPTED_DELIVERY: 'attempted_delivery',
  DELAYED: 'delayed',
  READY_FOR_PICKUP: 'ready_for_pickup',
  DELIVERED: 'delivered',
  PICKED_UP: 'delivered',
  FAILURE: 'failed',
  NOT_DELIVERED: 'failed',
};

// Only absolute web links are kept; anything else is treated as not provided.
const trackingUrl = (value: string | null | undefined) => {
  const url = text(value, 2048);
  if (!url) return null;
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol) ? url : null;
  } catch {
    return null;
  }
};

/** Emits an order's fulfillment orders, then its shipments, with all line pages. */
export async function readFulfillments(
  session: ReadSession,
  parent: { id: string },
) {
  const { node, children, emit } = session;
  const work = await children(
    parent.id,
    'Order',
    'fulfillmentOrders',
    'id updatedAt status fulfillAt fulfillBy fulfillmentHolds { reason } assignedLocation { name location { id } } deliveryMethod { methodType presentedName }',
    s.fulfillmentOrder,
  );
  for (const operation of work) {
    const lines = await children(
      operation.id,
      'FulfillmentOrder',
      'lineItems',
      'id totalQuantity remainingQuantity lineItem { id }',
      s.fulfillmentOrderLine,
    );
    const holds = (operation.fulfillmentHolds ?? []).map((hold) => ({
      reason: holdReasons[hold.reason] ?? 'other',
    }));
    const assigned = operation.assignedLocation;
    const method = operation.deliveryMethod;
    emit('fulfillment', ref(operation.id), operation.updatedAt, {
      order: ref(parent.id),
      status: statusFrom(workStatuses, operation.status),
      lines: lines.map((line) => ({
        orderLine: ref(line.lineItem.id, parent.id),
        quantity: quantity(line.totalQuantity),
        remainingQuantity: quantity(line.remainingQuantity),
      })),
      lastProgressAt: operation.updatedAt,
      progressBasis: 'source_updated',
      failureCode: operation.status === 'INCOMPLETE' ? 'incomplete' : null,
      kind: 'fulfillment_order',
      // An ON_HOLD status without a readable hold still blocks the work.
      holds:
        !holds.length && operation.status === 'ON_HOLD'
          ? [{ reason: 'other' }]
          : holds,
      location: assigned?.location
        ? {
            id: ref(assigned.location.id),
            name: text(assigned.name),
          }
        : null,
      fulfillAt: operation.fulfillAt ?? null,
      fulfillBy: operation.fulfillBy ?? null,
      method: method
        ? {
            type: methodTypes[method.methodType] ?? 'unknown',
            name: text(method.presentedName),
          }
        : null,
    } satisfies FulfillmentSnapshot);
  }
  // Order.fulfillments is an unpaginated list. Omit `first` to avoid silently truncating shipments.
  const order = await node(
    parent.id,
    'Order',
    'fulfillments { id updatedAt status deliveredAt inTransitAt displayStatus estimatedDeliveryAt location { id name } trackingInfo(first: 10) { company number url } }',
    z.object({ fulfillments: z.array(s.fulfillment) }),
  );
  for (const shipment of order.fulfillments) {
    const lines = await children(
      shipment.id,
      'Fulfillment',
      'fulfillmentLineItems',
      'id quantity lineItem { id }',
      s.fulfillmentLine,
    );
    const status = statusFrom(shipmentStatuses, shipment.status);
    emit('fulfillment', ref(shipment.id), shipment.updatedAt, {
      order: ref(parent.id),
      status:
        status === 'shipped' && shipment.deliveredAt ? 'delivered' : status,
      milestones: { deliveredAt: shipment.deliveredAt ?? null },
      lines: lines.map((line) => ({
        orderLine: ref(line.lineItem.id, parent.id),
        quantity: quantity(line.quantity),
      })),
      progressBasis: 'source_updated',
      lastProgressAt:
        shipment.deliveredAt ?? shipment.inTransitAt ?? shipment.updatedAt,
      failureCode: status === 'failed' ? 'fulfillment_failed' : null,
      kind: 'shipment',
      location: shipment.location
        ? {
            id: ref(shipment.location.id),
            name: text(shipment.location.name),
          }
        : null,
      estimatedDeliveryAt: shipment.estimatedDeliveryAt ?? null,
      tracking: (shipment.trackingInfo ?? [])
        .map((entry) => ({
          carrier: text(entry.company),
          number: text(entry.number),
          url: trackingUrl(entry.url),
        }))
        .filter((entry) => entry.number || entry.url),
      delivery: shipment.deliveredAt
        ? 'delivered'
        : (deliveryStates[shipment.displayStatus ?? ''] ?? null),
    } satisfies FulfillmentSnapshot);
  }
}

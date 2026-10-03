import { orderWork, workLines } from './fulfillment.js';
import { available, readLevel } from './inventory.js';
import {
  all,
  type FulfillmentData,
  gid,
  type LineItemData,
  type OrderData,
  type OrderTransactionData,
  type RefundData,
  type ReturnData,
  type ShopifyContext,
  type WebhookSubscriptionData,
} from './records.js';
import { currentReturn } from './returns.js';
import type { ShopifyHoldReason } from './types.js';

/** An order as the merchant engine sees it; IDs are numeric record IDs. */
export interface ShopifyOrderView {
  id: string;
  gid: string;
  name: string;
  /** Simulation time in epoch milliseconds. */
  createdAt: number;
  cancelled: boolean;
  closed: boolean;
  financialStatus: OrderData['displayFinancialStatus'];
  customer: string | null;
  /** Location of the order's open fulfillment work. */
  location: string;
  shipping: 'standard' | 'express';
  holds: ShopifyHoldReason[];
  lines: {
    id: string;
    variant: string | null;
    sku: string | null;
    quantity: number;
    unfulfilled: number;
  }[];
  fulfillments: { id: string; displayStatus: string; createdAt: number }[];
  /** Status of the latest return, or null without returns. */
  returnStatus: ReturnData['status'] | null;
  /** Refunds with their payment status. */
  refunds: { id: string; status: OrderTransactionData['status'] }[];
}

/** Reads an order with its lines, work, shipments, return and refunds; undefined when absent. */
export async function readOrder(
  context: ShopifyContext,
  id: string,
): Promise<ShopifyOrderView | undefined> {
  const order = await context.store.get<OrderData>('Order', id);
  if (!order) return undefined;
  const [lines, work, shipments, latest, refunds, transactions] =
    await Promise.all([
      all<LineItemData>(context, { kind: 'LineItem', parent: id }),
      orderWork(context, id),
      all<FulfillmentData>(context, { kind: 'Fulfillment', parent: id }),
      currentReturn(context, id),
      all<RefundData>(context, { kind: 'Refund', parent: id }),
      all<OrderTransactionData>(context, {
        kind: 'OrderTransaction',
        parent: id,
      }),
    ]);
  const unfulfilled = new Map<string, number>();
  for (const item of work)
    for (const line of await workLines(context, item.id))
      unfulfilled.set(
        line.data.lineItem,
        (unfulfilled.get(line.data.lineItem) ?? 0) +
          line.data.remainingQuantity,
      );

  return {
    id,
    gid: gid('Order', id),
    name: order.data.name,
    createdAt: order.createdAt,
    cancelled: order.data.cancelledAt !== null,
    closed: order.data.closed,
    financialStatus: order.data.displayFinancialStatus,
    customer: order.data.customer,
    location: order.data.location,
    shipping: order.data.shipping,
    holds: work.flatMap((item) => item.data.holds.map((hold) => hold.reason)),
    lines: lines.map((line) => ({
      id: line.id,
      variant: line.data.variant,
      sku: line.data.sku,
      quantity: line.data.quantity,
      unfulfilled: unfulfilled.get(line.id) ?? 0,
    })),
    fulfillments: shipments.map((shipment) => ({
      id: shipment.id,
      displayStatus: shipment.data.displayStatus,
      createdAt: shipment.createdAt,
    })),
    returnStatus: latest?.data.status ?? null,
    refunds: refunds.map((refund) => ({
      id: refund.id,
      status:
        transactions.find(
          (transaction) => transaction.data.refund === refund.id,
        )?.data.status ?? 'SUCCESS',
    })),
  };
}

/** Reads an item's stock at a location; undefined when the location does not stock it. */
export async function readStock(
  context: ShopifyContext,
  variant: string,
  location: string,
) {
  const level = await readLevel(context, variant, location);

  return level
    ? {
        onHand: level.data.onHand,
        committed: level.data.committed,
        available: available(level.data),
      }
    : undefined;
}

/** Converts a webhook topic such as `orders/create` to its subscription name `ORDERS_CREATE`. */
export const subscriptionTopic = (topic: string) =>
  topic.replace('/', '_').toUpperCase();

/**
 * Lists the shop's webhook subscriptions, which the host uses to deliver notifications.
 * Match a notification with `subscriptionTopic(event.topic) === subscription.topic`.
 */
export async function readSubscriptions(context: ShopifyContext) {
  return (
    await all<WebhookSubscriptionData>(context, { kind: 'WebhookSubscription' })
  ).map((subscription) => ({
    id: subscription.id,
    topic: subscription.data.topic,
    uri: subscription.data.uri,
  }));
}

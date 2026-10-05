import {
  openStatuses,
  orderWork,
  touchOrder,
  workLines,
} from './fulfillment.js';
import { adjustLevel } from './inventory.js';
import { orderEvent } from './orders.js';
import {
  all,
  type FulfillmentData,
  type FulfillmentLineItemData,
  gid,
  insert,
  iso,
  type LineItemData,
  load,
  nextId,
  notify,
  type OrderData,
  save,
  type ShopifyContext,
} from './records.js';
import type {
  ShipmentStatus,
  ShopifyCommand,
  ShopifyCommandResult,
} from './types.js';

type Command<K extends ShopifyCommand['kind']> = Extract<
  ShopifyCommand,
  { kind: K }
>;

/**
 * Ships line quantities with one tracking number: creates one fulfillment per fulfillment order,
 * reduces on-hand and committed stock, and closes work and the order once nothing remains.
 */
export async function fulfillOrder(
  context: ShopifyContext,
  command: Command<'fulfill'>,
): Promise<ShopifyCommandResult> {
  const order = await load<OrderData>(context, 'Order', command.order);
  if (order.data.cancelledAt) throw new Error('The order is cancelled');
  const work = (await orderWork(context, order.id)).filter((item) =>
    openStatuses.includes(item.data.status),
  );
  const workLinesById = new Map(
    await Promise.all(
      work.map(
        async (item) => [item.id, await workLines(context, item.id)] as const,
      ),
    ),
  );
  const candidates = work.flatMap((item) =>
    (workLinesById.get(item.id) ?? []).map((line) => ({ work: item, line })),
  );
  const requested =
    command.lines ??
    candidates
      .filter(({ line }) => line.data.remainingQuantity > 0)
      .map(({ line }) => ({
        lineItem: line.data.lineItem,
        quantity: line.data.remainingQuantity,
      }));
  const shipped = new Map<string, Map<string, number>>();
  for (const request of requested) {
    if (!Number.isSafeInteger(request.quantity) || request.quantity < 1)
      throw new Error('Fulfilled quantities must be positive whole numbers');
    let left = request.quantity;
    for (const { work: item, line } of candidates) {
      if (line.data.lineItem !== request.lineItem || !left) continue;
      const taken = Math.min(
        left,
        line.data.remainingQuantity - (shipped.get(item.id)?.get(line.id) ?? 0),
      );
      if (taken <= 0) continue;
      if (item.data.status === 'ON_HOLD')
        throw new Error('Release the fulfillment hold before shipping');
      if (item.data.status === 'SCHEDULED')
        throw new Error('Open the scheduled fulfillment order before shipping');
      const lines = shipped.get(item.id) ?? new Map<string, number>();
      lines.set(line.id, (lines.get(line.id) ?? 0) + taken);
      shipped.set(item.id, lines);
      left -= taken;
    }
    if (left)
      throw new Error(`Line ${request.lineItem} has fewer unfulfilled units`);
  }
  if (!shipped.size) throw new Error('Nothing left to fulfill');

  const orderLines = new Map(
    (
      await all<LineItemData>(context, { kind: 'LineItem', parent: order.id })
    ).map((line) => [line.id, line]),
  );
  const fulfillments: string[] = [];
  const result: NonNullable<ShopifyCommandResult['lines']> = [];
  for (const item of work) {
    const lines = shipped.get(item.id);
    if (!lines) continue;
    const id = await nextId(context);
    fulfillments.push(id);
    const records = [
      insert(
        context,
        'Fulfillment',
        id,
        {
          order: order.id,
          fulfillmentOrder: item.id,
          location: item.data.location,
          status: 'SUCCESS',
          displayStatus: 'CONFIRMED',
          inTransitAt: null,
          deliveredAt: null,
          estimatedDeliveryAt:
            command.estimatedDeliveryAt === undefined
              ? null
              : iso(command.estimatedDeliveryAt),
          tracking: [
            {
              company: command.carrier,
              number: command.trackingNumber,
              url: command.trackingUrl,
            },
          ],
        } satisfies FulfillmentData,
        { parent: order.id },
      ),
    ];
    let remaining = 0;
    for (const line of workLinesById.get(item.id) ?? []) {
      const quantity = lines.get(line.id) ?? 0;
      remaining += line.data.remainingQuantity - quantity;
      if (!quantity) continue;
      records.push(
        insert(
          context,
          'FulfillmentLineItem',
          await nextId(context),
          {
            fulfillment: id,
            lineItem: line.data.lineItem,
            quantity,
          } satisfies FulfillmentLineItemData,
          { parent: id },
        ),
      );
      await save(context, 'FulfillmentOrderLineItem', line.id, {
        ...line.data,
        remainingQuantity: line.data.remainingQuantity - quantity,
      });
      const variant = orderLines.get(line.data.lineItem)?.data.variant ?? null;
      if (variant)
        await adjustLevel(context, variant, item.data.location, {
          onHand: -quantity,
          committed: -quantity,
        });
      result.push({ id: line.data.lineItem, variant: variant ?? '', quantity });
    }
    item.data = {
      ...item.data,
      status: remaining ? 'IN_PROGRESS' : 'CLOSED',
    };
    await save(context, 'FulfillmentOrder', item.id, item.data);
    await context.store.putMany(records);
  }
  let open = 0;
  for (const item of work)
    if (item.data.status !== 'CLOSED')
      for (const line of await workLines(context, item.id))
        open += line.data.remainingQuantity;
  await context.store.putMany([
    await orderEvent(context, order.id, 'fulfillment_success'),
  ]);
  await touchOrder(context, order, {
    ...order.data,
    displayFulfillmentStatus: open ? 'PARTIALLY_FULFILLED' : 'FULFILLED',
    closed: !open,
  });
  for (const id of fulfillments)
    notify(context, 'fulfillments/create', 'Fulfillment', id, {
      order_id: Number(order.id),
      status: 'success',
    });
  notify(
    context,
    open ? 'orders/partially_fulfilled' : 'orders/fulfilled',
    'Order',
    order.id,
    { name: order.data.name },
  );

  const [first] = fulfillments;
  if (!first) throw new Error('Nothing left to fulfill');

  return { id: first, gid: gid('Fulfillment', first), lines: result };
}

/** Applies a carrier tracking update to a shipment. */
export async function shipmentStatus(
  context: ShopifyContext,
  command: Command<'shipment-status'>,
): Promise<ShopifyCommandResult> {
  const shipment = await load<FulfillmentData>(
    context,
    'Fulfillment',
    command.fulfillment,
  );
  if (shipment.data.status !== 'SUCCESS')
    throw new Error('The fulfillment is not in transit');
  if (shipment.data.deliveredAt) throw new Error('The shipment was delivered');
  const at = iso(context.now);
  const status: ShipmentStatus = command.status;
  const data: FulfillmentData = {
    ...shipment.data,
    displayStatus: status,
    inTransitAt:
      status === 'FAILURE'
        ? shipment.data.inTransitAt
        : (shipment.data.inTransitAt ?? at),
    deliveredAt: status === 'DELIVERED' ? at : null,
    status: status === 'FAILURE' ? 'FAILURE' : 'SUCCESS',
  };
  await save(context, 'Fulfillment', shipment.id, data);
  await touchOrder(context, shipment.data.order);
  notify(context, 'fulfillments/update', 'Fulfillment', shipment.id, {
    order_id: Number(shipment.data.order),
    shipment_status: status.toLowerCase(),
  });

  return { id: shipment.id, gid: gid('Fulfillment', shipment.id) };
}

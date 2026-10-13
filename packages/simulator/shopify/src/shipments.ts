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
  exact?: { fulfillmentOrderId: string; lineId: string; quantity: number }[],
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
  if (exact) {
    for (const request of exact) {
      const candidate = candidates.find(
        (v) =>
          v.work.id === request.fulfillmentOrderId &&
          v.line.id === request.lineId,
      );
      if (
        !candidate ||
        !Number.isSafeInteger(request.quantity) ||
        request.quantity < 1 ||
        request.quantity > candidate.line.data.remainingQuantity ||
        !['OPEN', 'IN_PROGRESS'].includes(candidate.work.data.status)
      )
        throw new Error('Exact fulfillment-order allocation changed');
      const allocation =
        shipped.get(candidate.work.id) ?? new Map<string, number>();
      if (allocation.has(candidate.line.id))
        throw new Error('Duplicate fulfillment-order line');
      allocation.set(candidate.line.id, request.quantity);
      shipped.set(candidate.work.id, allocation);
    }
  } else {
    for (const request of requested) {
      if (!Number.isSafeInteger(request.quantity) || request.quantity < 1)
        throw new Error('Fulfilled quantities must be positive whole numbers');
      let left = request.quantity;
      for (const { work: item, line } of candidates) {
        if (line.data.lineItem !== request.lineItem || !left) continue;
        const taken = Math.min(
          left,
          line.data.remainingQuantity -
            (shipped.get(item.id)?.get(line.id) ?? 0),
        );
        if (taken <= 0) continue;
        if (item.data.status === 'ON_HOLD')
          throw new Error('Release the fulfillment hold before shipping');
        if (item.data.status === 'SCHEDULED')
          throw new Error(
            'Open the scheduled fulfillment order before shipping',
          );
        const lines = shipped.get(item.id) ?? new Map<string, number>();
        lines.set(line.id, (lines.get(line.id) ?? 0) + taken);
        shipped.set(item.id, lines);
        left -= taken;
      }
      if (left)
        throw new Error(`Line ${request.lineItem} has fewer unfulfilled units`);
    }
  }
  if (!shipped.size) throw new Error('Nothing left to fulfill');

  const orderLines = new Map(
    (
      await all<LineItemData>(context, { kind: 'LineItem', parent: order.id })
    ).map((line) => [line.id, line]),
  );
  const fulfillments: string[] = [];
  const combinedId = exact ? await nextId(context) : null;
  const combinedLineIds = new Map<string, string>();
  const combinedQuantities = new Map<string, number>();
  const result: NonNullable<ShopifyCommandResult['lines']> = [];
  for (const item of work) {
    const lines = shipped.get(item.id);
    if (!lines) continue;
    const id = combinedId ?? (await nextId(context));
    const firstShipment = !fulfillments.includes(id);
    if (firstShipment) fulfillments.push(id);
    const records = firstShipment
      ? [
          insert(
            context,
            'Fulfillment',
            id,
            {
              order: order.id,
              fulfillmentOrder: item.id,
              ...(exact ? { fulfillmentOrders: [...shipped.keys()] } : {}),
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
        ]
      : [];
    let remaining = 0;
    for (const line of workLinesById.get(item.id) ?? []) {
      const quantity = lines.get(line.id) ?? 0;
      remaining += line.data.remainingQuantity - quantity;
      if (!quantity) continue;
      const combinedQuantity =
        (combinedQuantities.get(line.data.lineItem) ?? 0) + quantity;
      combinedQuantities.set(line.data.lineItem, combinedQuantity);
      let lineId = exact ? combinedLineIds.get(line.data.lineItem) : undefined;
      if (!lineId) {
        lineId = await nextId(context);
        if (exact) combinedLineIds.set(line.data.lineItem, lineId);
      }
      records.push(
        insert(
          context,
          'FulfillmentLineItem',
          lineId,
          {
            fulfillment: id,
            lineItem: line.data.lineItem,
            quantity: exact ? combinedQuantity : quantity,
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

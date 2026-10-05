import type { StoredRecord } from '@luma/simulator-core';

import { touchOrder } from './fulfillment.js';
import { adjustLevel } from './inventory.js';
import { orderEvent, spend } from './orders.js';
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
  type OrderTransactionData,
  type RefundData,
  type RefundLineItemData,
  type ReturnData,
  type ReturnLineItemData,
  type ReverseFulfillmentOrderData,
  type ReverseFulfillmentOrderLineItemData,
  save,
  type ShopifyContext,
} from './records.js';
import type { ShopifyCommand, ShopifyCommandResult } from './types.js';

type Command<K extends ShopifyCommand['kind']> = Extract<
  ShopifyCommand,
  { kind: K }
>;

/** The order's latest return, which return steps apply to. */
export async function currentReturn(context: ShopifyContext, order: string) {
  return (
    await context.store.page<ReturnData>({
      kind: 'Return',
      parent: order,
      reverse: true,
      limit: 1,
    })
  ).items[0];
}

/** Reads the order's current return or fails when there is none. */
async function requireReturn(context: ShopifyContext, order: string) {
  const found = await currentReturn(context, order);
  if (!found) throw new Error('Request a return first');

  return found;
}

/** Stores a return change, bumps the order and sends the return webhook. */
async function saveReturn(
  context: ShopifyContext,
  item: StoredRecord<ReturnData>,
  data: ReturnData,
  topic: string,
): Promise<ShopifyCommandResult> {
  await save(context, 'Return', item.id, data);
  await touchOrder(context, item.data.order);
  notify(context, topic, 'Return', item.id, {
    order_id: Number(item.data.order),
    status: data.status.toLowerCase(),
  });

  return { id: item.id, gid: gid('Return', item.id) };
}

/**
 * Requests a return of shipped units. Each line may draw on several shipments; units already
 * in another non-declined return cannot be returned again. An order has one active return.
 */
export async function requestReturn(
  context: ShopifyContext,
  command: Command<'return'>,
): Promise<ShopifyCommandResult> {
  const order = await load<OrderData>(context, 'Order', command.order);
  const returns = await all<ReturnData>(context, {
    kind: 'Return',
    parent: order.id,
  });
  if (returns.some((item) => ['REQUESTED', 'OPEN'].includes(item.data.status)))
    throw new Error('This order already has an open return');
  if (!command.lines.length)
    throw new Error('A return needs at least one line');
  const shipped: StoredRecord<FulfillmentLineItemData>[] = [];
  for (const shipment of await all<FulfillmentData>(context, {
    kind: 'Fulfillment',
    parent: order.id,
  }))
    if (shipment.data.status === 'SUCCESS')
      shipped.push(
        ...(await all<FulfillmentLineItemData>(context, {
          kind: 'FulfillmentLineItem',
          parent: shipment.id,
        })),
      );
  if (!shipped.length) throw new Error('Ship the order first');
  const returned = new Map<string, number>();
  for (const item of returns)
    if (item.data.status !== 'DECLINED')
      for (const line of await all<ReturnLineItemData>(context, {
        kind: 'ReturnLineItem',
        parent: item.id,
      }))
        returned.set(
          line.data.fulfillmentLineItem,
          (returned.get(line.data.fulfillmentLineItem) ?? 0) +
            line.data.quantity,
        );
  const prices = new Map(
    (
      await all<LineItemData>(context, { kind: 'LineItem', parent: order.id })
    ).map((line) => [line.id, line.data.price]),
  );
  const id = await nextId(context);
  const records = [];
  for (const request of command.lines) {
    if (!Number.isSafeInteger(request.quantity) || request.quantity < 1)
      throw new Error('Returned quantities must be positive whole numbers');
    let left = request.quantity;
    for (const line of shipped) {
      if (line.data.lineItem !== request.lineItem || !left) continue;
      const quantity = Math.min(
        left,
        line.data.quantity - (returned.get(line.id) ?? 0),
      );
      if (quantity <= 0) continue;
      returned.set(line.id, (returned.get(line.id) ?? 0) + quantity);
      left -= quantity;
      records.push(
        insert(
          context,
          'ReturnLineItem',
          await nextId(context),
          {
            return: id,
            fulfillmentLineItem: line.id,
            lineItem: line.data.lineItem,
            quantity,
            refundedQuantity: 0,
            reason: command.reason,
            amount: quantity * (prices.get(line.data.lineItem) ?? 0),
          } satisfies ReturnLineItemData,
          { parent: id },
        ),
      );
    }
    if (left) throw new Error('Return at most the shipped quantity');
  }
  const data: ReturnData = {
    order: order.id,
    name: `${order.data.name}-R${returns.length + 1}`,
    status: 'REQUESTED',
    requestApprovedAt: null,
    closedAt: null,
    declineReason: null,
  };
  await context.store.putMany([
    insert(context, 'Return', id, data, { parent: order.id }),
    ...records,
  ]);
  await touchOrder(context, order);
  notify(context, 'returns/request', 'Return', id, {
    order_id: Number(order.id),
    status: 'requested',
  });

  return { id, gid: gid('Return', id) };
}

/** Approves a requested return and opens a reverse fulfillment order for its lines. */
export async function approveReturn(
  context: ShopifyContext,
  command: { order: string },
) {
  const item = await requireReturn(context, command.order);
  if (item.data.status !== 'REQUESTED')
    throw new Error('Only a requested return can be approved');
  const reverse = await nextId(context);
  const records = [
    insert(
      context,
      'ReverseFulfillmentOrder',
      reverse,
      { return: item.id, status: 'OPEN' } satisfies ReverseFulfillmentOrderData,
      { parent: item.id },
    ),
  ];
  for (const line of await all<ReturnLineItemData>(context, {
    kind: 'ReturnLineItem',
    parent: item.id,
  }))
    records.push(
      insert(
        context,
        'ReverseFulfillmentOrderLineItem',
        await nextId(context),
        {
          reverseFulfillmentOrder: reverse,
          returnLineItem: line.id,
          fulfillmentLineItem: line.data.fulfillmentLineItem,
          totalQuantity: line.data.quantity,
          dispositions: [],
        } satisfies ReverseFulfillmentOrderLineItemData,
        { parent: reverse },
      ),
    );
  await context.store.putMany(records);

  return saveReturn(
    context,
    item,
    { ...item.data, status: 'OPEN', requestApprovedAt: iso(context.now) },
    'returns/approve',
  );
}

/** Declines a requested return. */
export async function declineReturn(
  context: ShopifyContext,
  command: { order: string },
) {
  const item = await requireReturn(context, command.order);
  if (item.data.status !== 'REQUESTED')
    throw new Error('Only a requested return can be declined');

  return saveReturn(
    context,
    item,
    {
      ...item.data,
      status: 'DECLINED',
      declineReason: 'RETURN_PERIOD_ENDED',
      closedAt: iso(context.now),
    },
    'returns/decline',
  );
}

/** Receives every returned unit and restocks it at the location that shipped it. */
export async function receiveReturn(
  context: ShopifyContext,
  command: { order: string },
): Promise<ShopifyCommandResult> {
  const item = await requireReturn(context, command.order);
  const reverse = (
    await all<ReverseFulfillmentOrderData>(context, {
      kind: 'ReverseFulfillmentOrder',
      parent: item.id,
    })
  ).filter((candidate) => candidate.data.status === 'OPEN');
  if (item.data.status !== 'OPEN' || !reverse.length)
    throw new Error(
      item.data.status === 'OPEN'
        ? 'Items were already received'
        : 'Approve the return first',
    );
  const variants = new Map(
    (
      await all<LineItemData>(context, {
        kind: 'LineItem',
        parent: item.data.order,
      })
    ).map((line) => [line.id, line.data.variant]),
  );
  for (const work of reverse) {
    for (const line of await all<ReverseFulfillmentOrderLineItemData>(context, {
      kind: 'ReverseFulfillmentOrderLineItem',
      parent: work.id,
    })) {
      const shipped = await load<FulfillmentLineItemData>(
        context,
        'FulfillmentLineItem',
        line.data.fulfillmentLineItem,
      );
      const shipment = await load<FulfillmentData>(
        context,
        'Fulfillment',
        shipped.data.fulfillment,
      );
      const variant = variants.get(shipped.data.lineItem);
      if (variant)
        await adjustLevel(context, variant, shipment.data.location, {
          onHand: line.data.totalQuantity,
        });
      await save(context, 'ReverseFulfillmentOrderLineItem', line.id, {
        ...line.data,
        dispositions: [
          ...line.data.dispositions,
          {
            id: await nextId(context),
            type: 'RESTOCKED',
            quantity: line.data.totalQuantity,
            createdAt: iso(context.now),
          },
        ],
      } satisfies ReverseFulfillmentOrderLineItemData);
    }
    await save(context, 'ReverseFulfillmentOrder', work.id, {
      ...work.data,
      status: 'CLOSED',
    } satisfies ReverseFulfillmentOrderData);
    notify(
      context,
      'reverse_fulfillment_orders/dispose',
      'ReverseFulfillmentOrder',
      work.id,
      {
        return_id: Number(item.id),
      },
    );
  }
  await touchOrder(context, item.data.order);

  return { id: item.id, gid: gid('Return', item.id) };
}

/** Closes an open return. */
export async function closeReturn(
  context: ShopifyContext,
  command: { order: string },
) {
  const item = await requireReturn(context, command.order);
  if (item.data.status !== 'OPEN')
    throw new Error('Only an open return can be closed');

  return saveReturn(
    context,
    item,
    { ...item.data, status: 'CLOSED', closedAt: iso(context.now) },
    'returns/close',
  );
}

/** Applies a successful refund amount to the order's payment status. */
function refunded(order: OrderData, amount: number): OrderData {
  const total = order.refunded + amount;

  return {
    ...order,
    refunded: total,
    displayFinancialStatus:
      total >= order.total ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
  };
}

/**
 * Refunds the approved return's unrefunded units with one payment attempt. A failed attempt
 * leaves the units refundable; a pending attempt settles later.
 */
export async function refundReturn(
  context: ShopifyContext,
  command: Command<'refund'>,
): Promise<ShopifyCommandResult> {
  const order = await load<OrderData>(context, 'Order', command.order);
  const item = await requireReturn(context, order.id);
  if (!['OPEN', 'CLOSED'].includes(item.data.status))
    throw new Error('Approve the return before refunding it');
  const lines = (
    await all<ReturnLineItemData>(context, {
      kind: 'ReturnLineItem',
      parent: item.id,
    })
  ).filter((line) => line.data.quantity > line.data.refundedQuantity);
  if (!lines.length) throw new Error('Nothing left to refund');
  const prices = new Map(
    (
      await all<LineItemData>(context, { kind: 'LineItem', parent: order.id })
    ).map((line) => [line.id, line.data.price]),
  );
  const sale = (
    await all<OrderTransactionData>(context, {
      kind: 'OrderTransaction',
      parent: order.id,
    })
  ).find((transaction) => transaction.data.kind === 'SALE');
  const status = (
    { success: 'SUCCESS', pending: 'PENDING', failure: 'FAILURE' } as const
  )[command.outcome];
  const id = await nextId(context);
  let amount = 0;
  const records = [];
  for (const line of lines) {
    const quantity = line.data.quantity - line.data.refundedQuantity;
    amount += quantity * (prices.get(line.data.lineItem) ?? 0);
    records.push(
      insert(
        context,
        'RefundLineItem',
        await nextId(context),
        {
          refund: id,
          lineItem: line.data.lineItem,
          quantity,
          restockType: 'RETURN',
          restocked: false,
        } satisfies RefundLineItemData,
        { parent: id },
      ),
    );
    if (status !== 'FAILURE')
      await save(context, 'ReturnLineItem', line.id, {
        ...line.data,
        refundedQuantity: line.data.quantity,
      });
  }
  await context.store.putMany([
    insert(
      context,
      'Refund',
      id,
      {
        order: order.id,
        return: item.id,
        amount,
        total: status === 'SUCCESS' ? amount : 0,
      } satisfies RefundData,
      { parent: order.id },
    ),
    ...records,
    insert(
      context,
      'OrderTransaction',
      await nextId(context),
      {
        order: order.id,
        refund: id,
        parent: sale?.id ?? null,
        kind: 'REFUND',
        status,
        gateway: 'shopify_payments',
        amount,
        processedAt: status === 'PENDING' ? null : iso(context.now),
      } satisfies OrderTransactionData,
      { parent: order.id, key: id },
    ),
    await orderEvent(context, order.id, `refund_${command.outcome}`),
  ]);
  await touchOrder(
    context,
    order,
    status === 'SUCCESS' ? refunded(order.data, amount) : order.data,
  );
  if (status === 'SUCCESS') await spend(context, order.data.customer, -amount);
  notify(context, 'refunds/create', 'Refund', id, {
    order_id: Number(order.id),
  });

  return { id, gid: gid('Refund', id) };
}

/** Completes the order's pending refund payment. */
export async function settleRefund(
  context: ShopifyContext,
  command: { order: string },
): Promise<ShopifyCommandResult> {
  const order = await load<OrderData>(context, 'Order', command.order);
  const pending = (
    await all<OrderTransactionData>(context, {
      kind: 'OrderTransaction',
      parent: order.id,
    })
  ).find(
    (transaction) =>
      transaction.data.kind === 'REFUND' &&
      transaction.data.status === 'PENDING',
  );
  if (!pending?.data.refund) throw new Error('No refund payment is pending');
  const refund = await load<RefundData>(context, 'Refund', pending.data.refund);
  await save(context, 'OrderTransaction', pending.id, {
    ...pending.data,
    status: 'SUCCESS',
    processedAt: iso(context.now),
  });
  await save(context, 'Refund', refund.id, {
    ...refund.data,
    total: refund.data.amount,
  });
  await touchOrder(context, order, refunded(order.data, pending.data.amount));
  await spend(context, order.data.customer, -pending.data.amount);

  return { id: refund.id, gid: gid('Refund', refund.id) };
}

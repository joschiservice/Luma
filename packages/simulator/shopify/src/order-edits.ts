import {
  openStatuses,
  orderWork,
  touchOrder,
  workLines,
} from './fulfillment.js';
import { adjustLevel } from './inventory.js';
import { spend } from './orders.js';
import {
  all,
  gid,
  type LineItemData,
  load,
  notify,
  type OrderData,
  save,
  type ShopifyContext,
} from './records.js';
import type { ShopifyCommand, ShopifyCommandResult } from './types.js';

/**
 * Reduces or removes unfulfilled units without rewriting originally ordered quantities.
 * Validates every line before changing stock, work or totals; shipped units cannot be removed.
 */
export async function editOrder(
  context: ShopifyContext,
  command: Extract<ShopifyCommand, { kind: 'order-edit' }>,
): Promise<ShopifyCommandResult> {
  const order = await load<OrderData>(context, 'Order', command.order);
  if (order.data.cancelledAt || order.data.closed)
    throw new Error('The order cannot be edited');
  if (
    !command.lines.length ||
    new Set(command.lines.map((line) => line.lineItem)).size !==
      command.lines.length
  )
    throw new Error('An edit needs distinct order lines');
  const lines = await all<LineItemData>(context, {
    kind: 'LineItem',
    parent: order.id,
  });
  const work = (await orderWork(context, order.id)).filter((item) =>
    openStatuses.includes(item.data.status),
  );
  const pending = await Promise.all(
    work.map(async (item) => ({
      item,
      lines: await workLines(context, item.id),
    })),
  );
  const edits = command.lines.map((change) => {
    const line = lines.find((line) => line.id === change.lineItem);
    if (!line) throw new Error('The line does not belong to this order');
    const current = line.data.currentQuantity ?? line.data.quantity;
    if (
      !Number.isSafeInteger(change.quantity) ||
      change.quantity < 0 ||
      change.quantity >= current
    )
      throw new Error(
        'An edit must reduce the current quantity to a nonnegative whole number',
      );
    const reduction = current - change.quantity;
    const available = pending.reduce(
      (sum, work) =>
        sum +
        work.lines
          .filter((item) => item.data.lineItem === line.id)
          .reduce((sum, item) => sum + item.data.remainingQuantity, 0),
      0,
    );
    if (reduction > available)
      throw new Error('Shipped units cannot be removed');

    return { line, current: change.quantity, reduction };
  });
  let totalReduction = 0;
  for (const edit of edits) {
    let remaining = edit.reduction;
    for (const work of pending) {
      for (const line of work.lines.filter(
        (line) => line.data.lineItem === edit.line.id,
      )) {
        const reduction = Math.min(remaining, line.data.remainingQuantity);
        if (!reduction) continue;
        line.data = {
          ...line.data,
          totalQuantity: line.data.totalQuantity - reduction,
          remainingQuantity: line.data.remainingQuantity - reduction,
        };
        await save(context, 'FulfillmentOrderLineItem', line.id, line.data);
        if (edit.line.data.variant)
          await adjustLevel(
            context,
            edit.line.data.variant,
            work.item.data.location,
            { committed: -reduction },
          );
        remaining -= reduction;
      }
    }
    await save(context, 'LineItem', edit.line.id, {
      ...edit.line.data,
      currentQuantity: edit.current,
    });
    totalReduction += edit.reduction * edit.line.data.price;
  }
  for (const work of pending) {
    const empty = work.lines.every((line) => line.data.remainingQuantity === 0);
    await save(context, 'FulfillmentOrder', work.item.id, {
      ...work.item.data,
      ...(empty
        ? { status: 'CANCELLED' as const, holds: [], heldStatus: null }
        : {}),
    });
    if (empty)
      notify(
        context,
        'fulfillment_orders/cancelled',
        'FulfillmentOrder',
        work.item.id,
      );
  }
  await spend(context, order.data.customer, -totalReduction);
  await touchOrder(context, order, {
    ...order.data,
    total: order.data.total - totalReduction,
    edited: true,
  });
  notify(context, 'orders/edited', 'Order', order.id, {
    order_edit: { order_id: Number(order.id) },
  });

  return { id: order.id, gid: gid('Order', order.id), name: order.data.name };
}

import {
  openStatuses,
  orderWork,
  placeHold,
  releaseHolds,
  touchOrder,
  workLines,
} from './fulfillment.js';
import { adjustLevel, writeLevel } from './inventory.js';
import {
  all,
  type BasicEventData,
  type CustomerData,
  dayMs,
  type FulfillmentOrderData,
  type FulfillmentOrderLineItemData,
  gid,
  insert,
  type InventoryLevelData,
  iso,
  levelId,
  type LineItemData,
  load,
  location,
  minorUnits,
  nextId,
  notify,
  type OrderData,
  type OrderTransactionData,
  type ProductData,
  type ProductVariantData,
  type RefundData,
  type RefundLineItemData,
  save,
  type ShopifyContext,
} from './records.js';
import {
  type ShopifyCommand,
  type ShopifyCommandResult,
  shopifyHoldReasons,
} from './types.js';

type Command<K extends ShopifyCommand['kind']> = Extract<
  ShopifyCommand,
  { kind: K }
>;

const isNonEmpty = <T>(values: T[]): values is [T, ...T[]] => values.length > 0;

/** Builds a new order event record, as shown in Shopify's order timeline. */
export async function orderEvent(
  context: ShopifyContext,
  order: string,
  action: string,
) {
  return insert(
    context,
    'BasicEvent',
    await nextId(context),
    { order, action } satisfies BasicEventData,
    { parent: order },
  );
}

/** Changes a customer's lifetime spend, which Shopify reports net of cancellations and refunds. */
export async function spend(
  context: ShopifyContext,
  customer: string | null,
  amount: number,
) {
  const record = customer
    ? await context.store.get<CustomerData>('Customer', customer)
    : undefined;
  if (!record || !amount) return;
  await save(context, 'Customer', record.id, {
    ...record.data,
    amountSpent: record.data.amountSpent + amount,
  });
  notify(context, 'customers/update', 'Customer', record.id);
}

/**
 * Places an order like a checkout: commits stock at the order's location, opens one fulfillment
 * order, records the payment and updates the customer's order count and spend.
 */
export async function createOrder(
  context: ShopifyContext,
  command: Command<'order'>,
): Promise<ShopifyCommandResult> {
  const { config, store, now } = context;
  if (!command.lines.length)
    throw new Error('An order needs at least one line');
  if (
    command.lines.some(
      (line) => !Number.isSafeInteger(line.quantity) || line.quantity < 1,
    )
  )
    throw new Error('Line quantities must be positive whole numbers');
  const place = location(context, command.location);
  if (!place) throw new Error(`Location ${command.location} not found`);
  const holds = command.holds ?? [];
  if (holds.some((reason) => !shopifyHoldReasons.includes(reason)))
    throw new Error('Invalid hold reason');
  const customer = command.customer
    ? await load<CustomerData>(context, 'Customer', command.customer)
    : undefined;
  const variantIds = [...new Set(command.lines.map((line) => line.variant))];
  const variants = new Map(
    (await store.getMany<ProductVariantData>('ProductVariant', variantIds)).map(
      (variant) => [variant.id, variant.data],
    ),
  );
  const products = new Map(
    (
      await store.getMany<ProductData>(
        'Product',
        [...variants.values()].map((variant) => variant.product),
      )
    ).map((product) => [product.id, product.data]),
  );
  const levels = new Map(
    (
      await store.getMany<InventoryLevelData>(
        'InventoryLevel',
        variantIds.map((id) => levelId(id, place.id)),
      )
    ).map((level) => [level.data.item, level.data]),
  );

  let id: string;
  let number: number;
  if (command.id) {
    if (!/^[1-9][0-9]{0,15}$/.test(command.id))
      throw new Error('Order IDs are positive numbers');
    if (await store.get('Order', command.id))
      throw new Error(`Order ${command.id} already exists`);
    id = command.id;
    number = Number(command.id);
  } else {
    id = await nextId(context);
    number = await store.sequence('order-number', 1001);
  }
  const name = `#${config.orderPrefix}${number}`;
  const lines: { id: string; data: LineItemData }[] = [];
  for (const line of command.lines) {
    const variant = variants.get(line.variant);
    if (!variant) throw new Error(`Variant ${line.variant} not found`);
    if (!levels.has(line.variant))
      throw new Error(
        `Variant ${line.variant} is not stocked at ${place.name}`,
      );
    const title = products.get(variant.product)?.title ?? variant.sku;
    lines.push({
      id: await nextId(context),
      data: {
        order: id,
        variant: line.variant,
        product: variant.product,
        sku: variant.sku,
        name:
          variant.title === 'Default Title'
            ? title
            : `${title} - ${variant.title}`,
        quantity: line.quantity,
        currentQuantity: line.quantity,
        price: minorUnits(line.price),
      },
    });
  }
  // Stores whose prices exclude tax, as in the US, add it at checkout, rounded per line.
  const { taxRate, taxesIncluded } = context.config;
  const added = taxRate === undefined || taxesIncluded ? 0 : taxRate;
  const total = lines.reduce((sum, line) => {
    const amount = line.data.price * line.data.quantity;

    return sum + amount + Math.round(amount * added);
  }, 0);
  const scheduled = command.fulfillAt !== undefined && command.fulfillAt > now;
  const workId = await nextId(context);
  const work: FulfillmentOrderData = {
    order: id,
    location: place.id,
    status: holds.length ? 'ON_HOLD' : scheduled ? 'SCHEDULED' : 'OPEN',
    requestStatus: 'UNSUBMITTED',
    fulfillAt: iso(command.fulfillAt ?? now),
    fulfillBy: iso(Math.max(now, command.fulfillAt ?? now) + 2 * dayMs),
    holds: [],
    heldStatus: holds.length ? (scheduled ? 'SCHEDULED' : 'OPEN') : null,
    method: {
      name: command.shipping === 'express' ? 'Express' : 'Standard',
      maxDeliveryAt: iso(
        now + (command.shipping === 'express' ? 2 : 5) * dayMs,
      ),
    },
  };
  for (const reason of holds)
    work.holds.push({
      id: await nextId(context),
      reason,
      heldByRequestingApp: false,
    });
  const order: OrderData = {
    number,
    name,
    customer: customer?.id ?? null,
    location: place.id,
    shipping: command.shipping,
    currency: config.currency,
    displayFinancialStatus: command.financialStatus,
    displayFulfillmentStatus: 'UNFULFILLED',
    cancelledAt: null,
    cancelReason: null,
    closed: false,
    total,
    refunded: 0,
  };
  const workLineRecords = [];
  for (const line of lines)
    workLineRecords.push(
      insert(
        context,
        'FulfillmentOrderLineItem',
        await nextId(context),
        {
          fulfillmentOrder: workId,
          lineItem: line.id,
          totalQuantity: line.data.quantity,
          remainingQuantity: line.data.quantity,
        } satisfies FulfillmentOrderLineItemData,
        { parent: workId },
      ),
    );
  await store.putMany([
    insert(context, 'Order', id, order, {
      parent: customer?.id ?? null,
      key: name,
    }),
    ...lines.map((line) =>
      insert(context, 'LineItem', line.id, line.data, { parent: id }),
    ),
    insert(context, 'FulfillmentOrder', workId, work, { parent: id }),
    ...workLineRecords,
    insert(
      context,
      'OrderTransaction',
      await nextId(context),
      {
        order: id,
        refund: null,
        parent: null,
        kind: 'SALE',
        status: command.financialStatus === 'PAID' ? 'SUCCESS' : 'PENDING',
        gateway: 'shopify_payments',
        amount: total,
        processedAt: command.financialStatus === 'PAID' ? iso(now) : null,
      } satisfies OrderTransactionData,
      { parent: id },
    ),
    await orderEvent(context, id, 'placed'),
  ]);
  const committed = new Map<string, number>();
  for (const line of command.lines)
    committed.set(
      line.variant,
      (committed.get(line.variant) ?? 0) + line.quantity,
    );
  for (const [variant, quantity] of committed) {
    const level = levels.get(variant);
    if (level)
      await writeLevel(context, {
        ...level,
        committed: level.committed + quantity,
      });
  }
  if (customer) {
    await save(context, 'Customer', customer.id, {
      ...customer.data,
      numberOfOrders: customer.data.numberOfOrders + 1,
      amountSpent: customer.data.amountSpent + total,
    });
    notify(context, 'customers/update', 'Customer', customer.id);
  }
  notify(context, 'orders/create', 'Order', id, { name });
  if (holds.length) {
    notify(
      context,
      'fulfillment_orders/placed_on_hold',
      'FulfillmentOrder',
      workId,
      {
        status: 'ON_HOLD',
      },
    );
    for (const hold of work.holds)
      notify(context, 'fulfillment_holds/added', 'FulfillmentHold', hold.id, {
        reason: hold.reason,
        fulfillment_order_id: gid('FulfillmentOrder', workId),
      });
  }

  return {
    id,
    name,
    gid: gid('Order', id),
    lines: lines.map((line) => ({
      id: line.id,
      variant: line.data.variant ?? '',
      quantity: line.data.quantity,
    })),
  };
}

/** Records a captured payment for a pending order. */
export async function markPaid(
  context: ShopifyContext,
  command: Command<'paid'>,
): Promise<ShopifyCommandResult> {
  const order = await load<OrderData>(context, 'Order', command.order);
  if (order.data.cancelledAt) throw new Error('The order is cancelled');
  if (!['PENDING', 'AUTHORIZED'].includes(order.data.displayFinancialStatus))
    throw new Error('The order is not awaiting payment');
  const sale = (
    await all<OrderTransactionData>(context, {
      kind: 'OrderTransaction',
      parent: order.id,
    })
  ).find((item) => item.data.kind === 'SALE');
  if (sale)
    await save(context, 'OrderTransaction', sale.id, {
      ...sale.data,
      status: 'SUCCESS',
      processedAt: iso(context.now),
    });
  await context.store.putMany([
    await orderEvent(context, order.id, 'capture_success'),
  ]);
  await touchOrder(context, order, {
    ...order.data,
    displayFinancialStatus: 'PAID',
  });
  notify(context, 'orders/paid', 'Order', order.id, { name: order.data.name });

  return { id: order.id, name: order.data.name, gid: gid('Order', order.id) };
}

/**
 * Cancels an unfulfilled order: releases committed stock, cancels its fulfillment work and
 * refunds a captured payment. Orders with fulfillments cannot be cancelled.
 */
export async function cancelOrder(
  context: ShopifyContext,
  command: Command<'cancel'>,
): Promise<ShopifyCommandResult> {
  const order = await load<OrderData>(context, 'Order', command.order);
  if (order.data.cancelledAt) throw new Error('The order is already cancelled');
  if (await context.store.count({ kind: 'Fulfillment', parent: order.id }))
    throw new Error('An order with fulfillments cannot be cancelled');
  const lines = await all<LineItemData>(context, {
    kind: 'LineItem',
    parent: order.id,
  });
  const items = new Map(lines.map((line) => [line.id, line.data.variant]));
  for (const work of await orderWork(context, order.id)) {
    if (!openStatuses.includes(work.data.status)) continue;
    for (const line of await workLines(context, work.id)) {
      const item = items.get(line.data.lineItem);
      if (item && line.data.remainingQuantity)
        await adjustLevel(context, item, work.data.location, {
          committed: -line.data.remainingQuantity,
        });
      await save(context, 'FulfillmentOrderLineItem', line.id, {
        ...line.data,
        remainingQuantity: 0,
      });
    }
    await save(context, 'FulfillmentOrder', work.id, {
      ...work.data,
      status: 'CANCELLED',
      holds: [],
      heldStatus: null,
    } satisfies FulfillmentOrderData);
  }
  const paid = order.data.displayFinancialStatus === 'PAID';
  const records = [await orderEvent(context, order.id, 'cancelled')];
  let refund: string | undefined;
  if (paid) {
    refund = await nextId(context);
    const sale = (
      await all<OrderTransactionData>(context, {
        kind: 'OrderTransaction',
        parent: order.id,
      })
    ).find((item) => item.data.kind === 'SALE');
    records.push(
      insert(
        context,
        'Refund',
        refund,
        {
          order: order.id,
          return: null,
          amount: order.data.total,
          total: order.data.total,
        } satisfies RefundData,
        { parent: order.id },
      ),
      insert(
        context,
        'OrderTransaction',
        await nextId(context),
        {
          order: order.id,
          refund,
          parent: sale?.id ?? null,
          kind: 'REFUND',
          status: 'SUCCESS',
          gateway: 'shopify_payments',
          amount: order.data.total,
          processedAt: iso(context.now),
        } satisfies OrderTransactionData,
        { parent: order.id, key: refund },
      ),
    );
    for (const line of lines.filter(
      (line) => (line.data.currentQuantity ?? line.data.quantity) > 0,
    ))
      records.push(
        insert(
          context,
          'RefundLineItem',
          await nextId(context),
          {
            refund,
            lineItem: line.id,
            quantity: line.data.currentQuantity ?? line.data.quantity,
            restockType: 'CANCEL',
            restocked: true,
          } satisfies RefundLineItemData,
          { parent: refund },
        ),
      );
  }
  if (paid)
    for (const line of lines)
      records.push({
        ...line,
        updatedAt: context.now,
        data: { ...line.data, currentQuantity: 0 },
      });
  await context.store.putMany(records);
  await touchOrder(context, order, {
    ...order.data,
    cancelledAt: iso(context.now),
    cancelReason: command.reason,
    closed: true,
    displayFinancialStatus: paid ? 'REFUNDED' : 'VOIDED',
    refunded: paid ? order.data.total : order.data.refunded,
  });
  await spend(context, order.data.customer, -order.data.total);
  notify(context, 'orders/cancelled', 'Order', order.id, {
    name: order.data.name,
    cancel_reason: command.reason.toLowerCase(),
  });
  if (refund)
    notify(context, 'refunds/create', 'Refund', refund, {
      order_id: Number(order.id),
    });

  return { id: order.id, name: order.data.name, gid: gid('Order', order.id) };
}

/** Holds or releases every open fulfillment order of an order. */
export async function holdOrder(
  context: ShopifyContext,
  command: Command<'hold'> | Command<'release'>,
): Promise<ShopifyCommandResult> {
  const order = await load<OrderData>(context, 'Order', command.order);
  if (order.data.cancelledAt) throw new Error('The order is cancelled');
  const work = (await orderWork(context, order.id)).filter((item) =>
    command.kind === 'hold'
      ? openStatuses.includes(item.data.status)
      : item.data.status === 'ON_HOLD',
  );
  if (!isNonEmpty(work))
    throw new Error(
      command.kind === 'hold'
        ? 'The order has no open fulfillment order'
        : 'The fulfillment order is not on hold',
    );
  if (command.kind === 'hold' && !shopifyHoldReasons.includes(command.reason))
    throw new Error('Invalid hold reason');
  for (const item of work)
    if (command.kind === 'hold') await placeHold(context, item, command.reason);
    else await releaseHolds(context, item);
  await touchOrder(context, order);
  const [first] = work;

  return { id: first.id, gid: gid('FulfillmentOrder', first.id) };
}

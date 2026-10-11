import type { StoredRecord } from '@luma/simulator-core';
import { GraphQLError } from 'graphql';

import type { Args } from './connections.js';
import type { RequestContext } from './context.js';
import { touchOrder } from './fulfillment.js';
import { adjustLevel, available } from './inventory.js';
import {
  all,
  type ExchangeLineItemData,
  type FulfillmentOrderData,
  type FulfillmentOrderLineItemData,
  gid,
  insert,
  type InventoryLevelData,
  type LineItemData,
  load,
  moneyBag,
  nextId,
  type OrderData,
  type OrderTransactionData,
  parseGid,
  type ProductVariantData,
  type RefundData,
  type RefundLineItemData,
  type ReturnData,
  type ReturnLineItemData,
  save,
  type ShopifyContext,
} from './records.js';

const fields = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null
    ? Object.fromEntries(Object.entries(value))
    : {};
const number = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
const list = (value: unknown) =>
  Array.isArray(value) ? value.map(fields) : [];

/** Validates replacement input before return creation can commit anything. */
export async function validateExchangeInput(
  context: RequestContext,
  input: Record<string, unknown>,
) {
  const lines = list(input.exchangeLineItems);
  if (!lines.length) return [];
  if (lines.length !== 1 || input.unprocessed !== true)
    throw new GraphQLError('Use unprocessed exchange creation');
  const entry = lines[0]!,
    source =
      typeof entry.variantId === 'string'
        ? parseGid(entry.variantId, 'ProductVariant')
        : null,
    quantity = number(entry.quantity);
  const variant = source
    ? await context.shop.store.get<ProductVariantData>(
        'ProductVariant',
        source.id,
      )
    : undefined;
  if (!variant || !quantity || entry.appliedDiscount !== undefined)
    throw new GraphQLError('Invalid exchange variant or quantity');

  return [{ variant: variant.id, quantity, price: variant.data.price }];
}

/** Attaches an unprocessed native replacement intent without stock or financial effects. */
export async function attachExchangeInput(
  context: RequestContext,
  returnId: string,
  lines: Awaited<ReturnType<typeof validateExchangeInput>>,
) {
  const returned = await load<ReturnData>(context.shop, 'Return', returnId);
  for (const line of lines)
    await context.shop.store.putMany([
      insert(
        context.shop,
        'ExchangeLineItem',
        await nextId(context.shop),
        {
          return: returnId,
          order: returned.data.order,
          ...line,
          processedQuantity: 0,
          lineItems: [],
        } satisfies ExchangeLineItemData,
        { parent: returnId },
      ),
    ]);
  context.loader.clear();
}

async function captureAllocation(
  context: RequestContext,
  order: StoredRecord<OrderData>,
  amount: number,
) {
  const source = await all<OrderTransactionData>(context.shop, {
    kind: 'OrderTransaction',
    parent: order.id,
  });
  const sales = source.filter(
    (t) =>
      ['SALE', 'CAPTURE'].includes(t.data.kind) && t.data.status === 'SUCCESS',
  );
  let left = amount,
    maximum = 0;
  const transactions = [];
  for (const sale of sales) {
    const refunded = source
      .filter(
        (t) =>
          t.data.kind === 'REFUND' &&
          t.data.parent === sale.id &&
          ['PENDING', 'SUCCESS'].includes(t.data.status),
      )
      .reduce((n, t) => n + t.data.amount, 0);
    const balance = Math.max(0, sale.data.amount - refunded),
      part = Math.min(left, balance);
    maximum += balance;
    if (part > 0) {
      transactions.push({
        __typename: 'SuggestedOrderTransaction',
        amountSet: moneyBag(part, order.data.currency),
        gateway: sale.data.gateway,
        kind: 'SUGGESTED_REFUND',
        parentTransaction: sale,
      });
      left -= part;
    }
  }

  return { transactions, maximum };
}

/** Quotes only the selected native return/exchange lines, using their recorded request prices. */
export async function suggestedExchangeFinancial(
  context: RequestContext,
  returned: StoredRecord<ReturnData>,
  args: Args,
) {
  const order = await load<OrderData>(
      context.shop,
      'Order',
      returned.data.order,
    ),
    returns = await all<ReturnLineItemData>(context.shop, {
      kind: 'ReturnLineItem',
      parent: returned.id,
    }),
    exchanges = await all<ExchangeLineItemData>(context.shop, {
      kind: 'ExchangeLineItem',
      parent: returned.id,
    });
  const requestedReturns = list(args.returnLineItems),
    requestedExchanges = list(args.exchangeLineItems);
  if (
    (args.refundMethodAllocation &&
      args.refundMethodAllocation !== 'ORIGINAL_PAYMENT_METHODS') ||
    args.refundShipping ||
    args.refundDuties
  )
    throw new GraphQLError('Unsupported exchange financial selection');
  if (
    new Set(requestedReturns.map((l) => l.id)).size !==
      requestedReturns.length ||
    new Set(requestedExchanges.map((l) => l.id)).size !==
      requestedExchanges.length
  )
    throw new GraphQLError('Duplicate financial selection');
  let credit = 0,
    charge = 0;
  for (const entry of requestedReturns) {
    const key =
        typeof entry.id === 'string'
          ? parseGid(entry.id, 'ReturnLineItem')
          : null,
      row = returns.find((l) => l.id === key?.id),
      quantity = number(entry.quantity);
    if (
      !row ||
      !quantity ||
      quantity > row.data.quantity - (row.data.processedQuantity ?? 0)
    )
      throw new GraphQLError('Invalid processable return quantity');
    credit += Math.round((row.data.amount * quantity) / row.data.quantity);
  }
  for (const entry of requestedExchanges) {
    const key =
        typeof entry.id === 'string'
          ? parseGid(entry.id, 'ExchangeLineItem')
          : null,
      row = exchanges.find((l) => l.id === key?.id),
      quantity = number(entry.quantity);
    if (
      !row ||
      !quantity ||
      quantity > row.data.quantity - row.data.processedQuantity
    )
      throw new GraphQLError('Invalid processable exchange quantity');
    charge += row.data.price * quantity;
  }
  const net = charge - credit,
    allocation = await captureAllocation(context, order, Math.max(0, -net));

  return {
    __typename: 'SuggestedReturnFinancialOutcome',
    maximumRefundable: moneyBag(allocation.maximum, order.data.currency),
    financialTransfer:
      net === 0
        ? null
        : net > 0
          ? {
              __typename: 'InvoiceReturnOutcome',
              amount: moneyBag(net, order.data.currency),
            }
          : {
              __typename: 'RefundReturnOutcome',
              amount: moneyBag(-net, order.data.currency),
              suggestedTransactions: allocation.transactions,
            },
  };
}

/** Processes an exact native exchange once, creates one fulfillment and records the actual financial difference. */
export async function processExchange(context: RequestContext, args: Args) {
  const input = fields(args.input),
    key =
      typeof input.returnId === 'string'
        ? parseGid(input.returnId, 'Return')
        : null;
  if (!context.shop.config.scopes.includes('write_returns'))
    throw new GraphQLError('Returns write scope is required');
  const returned = key
    ? await context.shop.store.get<ReturnData>('Return', key.id)
    : undefined;
  if (!returned || returned.data.status !== 'OPEN')
    throw new GraphQLError('Open return required');
  const original = await all<ReturnLineItemData>(context.shop, {
      kind: 'ReturnLineItem',
      parent: returned.id,
    }),
    exchange = await all<ExchangeLineItemData>(context.shop, {
      kind: 'ExchangeLineItem',
      parent: returned.id,
    });
  const r = list(input.returnLineItems),
    e = list(input.exchangeLineItems);
  if (
    exchange.length !== 1 ||
    r.length !== original.length ||
    e.length !== 1 ||
    input.notifyCustomer !== false ||
    r.some((l) => l.dispositions !== undefined) ||
    original.some((l) => (l.data.processedQuantity ?? 0) !== 0) ||
    exchange[0]!.data.processedQuantity !== 0 ||
    original.some(
      (l) =>
        r.filter(
          (s) =>
            s.id === gid('ReturnLineItem', l.id) &&
            s.quantity === l.data.quantity,
        ).length !== 1,
    ) ||
    e[0]!.id !== gid('ExchangeLineItem', exchange[0]!.id) ||
    e[0]!.quantity !== exchange[0]!.data.quantity
  )
    throw new GraphQLError('Exact unprocessed exchange required');
  const order = await load<OrderData>(
      context.shop,
      'Order',
      returned.data.order,
    ),
    replacement = exchange[0]!,
    variant = await load<ProductVariantData>(
      context.shop,
      'ProductVariant',
      replacement.data.variant,
    );
  const levels = await all<InventoryLevelData>(context.shop, {
    kind: 'InventoryLevel',
    parent: variant.id,
  });
  const level = levels.find(
    (l) =>
      l.data.location === order.data.location &&
      available(l.data) >= replacement.data.quantity,
  );
  if (!level)
    return {
      return: null,
      userErrors: [
        {
          field: ['input', 'exchangeLineItems'],
          message: 'Replacement unavailable',
        },
      ],
    };
  const quote = await suggestedExchangeFinancial(context, returned, {
      returnLineItems: r,
      exchangeLineItems: e,
    }),
    credit = original.reduce((n, l) => n + l.data.amount, 0),
    cost = replacement.data.price * replacement.data.quantity,
    net = cost - credit;
  const transfer = fields(input.financialTransfer),
    issue = fields(transfer.issueRefund),
    transactions = list(issue.orderTransactions),
    allocation = await captureAllocation(context, order, Math.max(0, -net));
  if (
    (net < 0 &&
      (issue.allowOverRefunding !== false ||
        transactions.length !== allocation.transactions.length ||
        allocation.transactions.reduce(
          (n, t) =>
            n + Math.round(Number(t.amountSet.presentmentMoney.amount) * 100),
          0,
        ) !== -net ||
        allocation.transactions.some(
          (t) =>
            transactions.filter(
              (s) =>
                s.parentId ===
                  gid('OrderTransaction', t.parentTransaction.id) &&
                fields(s.transactionAmount).amount ===
                  t.amountSet.presentmentMoney.amount &&
                fields(s.transactionAmount).currencyCode ===
                  order.data.currency,
            ).length !== 1,
        ))) ||
    (net >= 0 && Object.keys(transfer).length)
  )
    throw new GraphQLError('Financial transfer differs from suggestion');
  const lineId = await nextId(context.shop),
    fulfillmentId = await nextId(context.shop),
    records = [];
  records.push(
    insert(
      context.shop,
      'LineItem',
      lineId,
      {
        order: order.id,
        variant: variant.id,
        product: variant.data.product,
        sku: variant.data.sku,
        name: variant.data.title,
        quantity: replacement.data.quantity,
        currentQuantity: replacement.data.quantity,
        price: replacement.data.price,
      } satisfies LineItemData,
      { parent: order.id },
    ),
  );
  const holdId = net > 0 ? await nextId(context.shop) : null;
  records.push(
    insert(
      context.shop,
      'FulfillmentOrder',
      fulfillmentId,
      {
        order: order.id,
        location: level.data.location,
        status: net > 0 ? 'ON_HOLD' : 'OPEN',
        requestStatus: 'UNSUBMITTED',
        fulfillAt: null,
        fulfillBy: null,
        holds: holdId
          ? [
              {
                id: holdId,
                reason: 'AWAITING_PAYMENT',
                heldByRequestingApp: false,
              },
            ]
          : [],
        heldStatus: holdId ? 'OPEN' : null,
        method: { name: 'Standard', maxDeliveryAt: null },
      } satisfies FulfillmentOrderData,
      { parent: order.id },
    ),
  );
  records.push(
    insert(
      context.shop,
      'FulfillmentOrderLineItem',
      await nextId(context.shop),
      {
        fulfillmentOrder: fulfillmentId,
        lineItem: lineId,
        totalQuantity: replacement.data.quantity,
        remainingQuantity: replacement.data.quantity,
      } satisfies FulfillmentOrderLineItemData,
      { parent: fulfillmentId },
    ),
  );
  if (net < 0) {
    const refundId = await nextId(context.shop);
    records.push(
      insert(
        context.shop,
        'Refund',
        refundId,
        {
          order: order.id,
          return: returned.id,
          amount: -net,
          total: 0,
          note: typeof input.note === 'string' ? input.note : null,
        } satisfies RefundData,
        { parent: order.id },
      ),
    );
    for (const l of original)
      records.push(
        insert(
          context.shop,
          'RefundLineItem',
          await nextId(context.shop),
          {
            refund: refundId,
            lineItem: l.data.lineItem,
            quantity: l.data.quantity,
            restockType: 'NO_RESTOCK',
            restocked: false,
          } satisfies RefundLineItemData,
          { parent: refundId },
        ),
      );
    for (const t of allocation.transactions)
      records.push(
        insert(
          context.shop,
          'OrderTransaction',
          await nextId(context.shop),
          {
            order: order.id,
            refund: refundId,
            parent: t.parentTransaction.id,
            kind: 'REFUND',
            status: 'PENDING',
            amount: Math.round(
              Number(t.amountSet.presentmentMoney.amount) * 100,
            ),
            gateway: t.gateway,
            processedAt: null,
          } satisfies OrderTransactionData,
          { parent: order.id, key: refundId },
        ),
      );
  }
  await context.shop.store.putMany(records);
  context.committed = true;
  await save(context.shop, 'ExchangeLineItem', replacement.id, {
    ...replacement.data,
    processedQuantity: replacement.data.quantity,
    lineItems: [lineId],
  });
  for (const l of original) {
    await save(context.shop, 'ReturnLineItem', l.id, {
      ...l.data,
      processedQuantity: l.data.quantity,
      refundedQuantity: net < 0 ? l.data.quantity : l.data.refundedQuantity,
    });
    const item = await load<LineItemData>(
      context.shop,
      'LineItem',
      l.data.lineItem,
    );
    await save(context.shop, 'LineItem', item.id, {
      ...item.data,
      currentQuantity:
        (item.data.currentQuantity ?? item.data.quantity) - l.data.quantity,
    });
  }
  await adjustLevel(context.shop, variant.id, level.data.location, {
    committed: replacement.data.quantity,
  });
  await save(context.shop, 'Order', order.id, {
    ...order.data,
    total: order.data.total + net,
    displayFinancialStatus:
      net > 0 ? 'PARTIALLY_PAID' : order.data.displayFinancialStatus,
    displayFulfillmentStatus: 'PARTIALLY_FULFILLED',
  });
  await touchOrder(context.shop, order.id);
  context.loader.clear();
  context.shop.notify({
    topic: 'returns/update',
    resource: gid('Return', returned.id),
    payload: { order_id: Number(order.id) },
  });

  return {
    return: await context.shop.store.get('Return', returned.id),
    userErrors: [],
    quote,
  };
}

/** Cancels only a pristine intent; a processed exchange cannot be recreated after cancellation. */
export async function cancelExchange(context: RequestContext, args: Args) {
  if (!context.shop.config.scopes.includes('write_returns'))
    throw new GraphQLError('Returns write scope is required');
  const key = typeof args.id === 'string' ? parseGid(args.id, 'Return') : null,
    returned = key
      ? await context.shop.store.get<ReturnData>('Return', key.id)
      : undefined;
  if (!returned || returned.data.status !== 'OPEN')
    throw new GraphQLError('Open return required');
  const lines = await all<ReturnLineItemData>(context.shop, {
      kind: 'ReturnLineItem',
      parent: returned.id,
    }),
    exchanges = await all<ExchangeLineItemData>(context.shop, {
      kind: 'ExchangeLineItem',
      parent: returned.id,
    });
  if (
    lines.some((l) => (l.data.processedQuantity ?? 0) > 0) ||
    exchanges.some((l) => l.data.processedQuantity > 0)
  )
    throw new GraphQLError('Processed return cannot be cancelled');
  await save(context.shop, 'Return', returned.id, {
    ...returned.data,
    status: 'CANCELED',
  });
  context.committed = true;
  await touchOrder(context.shop, returned.data.order);
  context.loader.clear();

  return {
    return: await context.shop.store.get('Return', returned.id),
    userErrors: [],
  };
}

/** Merchant payment of the exchange balance; it records success but never releases a fulfillment hold. */
export async function payExchangeBalance(
  context: ShopifyContext,
  orderId: string,
) {
  const order = await load<OrderData>(context, 'Order', orderId),
    transactions = await all<OrderTransactionData>(context, {
      kind: 'OrderTransaction',
      parent: order.id,
    });
  const captured = transactions
      .filter(
        (t) =>
          ['SALE', 'CAPTURE'].includes(t.data.kind) &&
          t.data.status === 'SUCCESS',
      )
      .reduce((n, t) => n + t.data.amount, 0),
    refunded = transactions
      .filter((t) => t.data.kind === 'REFUND' && t.data.status === 'SUCCESS')
      .reduce((n, t) => n + t.data.amount, 0),
    amount = order.data.total - captured + refunded;
  if (amount <= 0) throw new GraphQLError('No exchange balance is due');
  const id = await nextId(context);
  await context.store.putMany([
    insert(
      context,
      'OrderTransaction',
      id,
      {
        order: order.id,
        refund: null,
        parent: null,
        kind: 'SALE',
        status: 'SUCCESS',
        amount,
        gateway: 'simulated-payment',
        processedAt: new Date(context.now).toISOString(),
      } satisfies OrderTransactionData,
      { parent: order.id },
    ),
  ]);
  await save(context, 'Order', order.id, {
    ...order.data,
    displayFinancialStatus: 'PAID',
  });
  await touchOrder(context, order.id);

  return { id, gid: gid('OrderTransaction', id) };
}

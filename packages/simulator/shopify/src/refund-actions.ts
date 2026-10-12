import type { StoredRecord } from '@luma/simulator-core';
import {
  getDirectiveValues,
  GraphQLError,
  type GraphQLResolveInfo,
} from 'graphql';

import type { Args } from './connections.js';
import type { RequestContext } from './context.js';
import { touchOrder } from './fulfillment.js';
import {
  all,
  gid,
  type IdempotencyKeyData,
  insert,
  type LineItemData,
  load,
  minorUnits,
  moneyBag,
  nextId,
  notify,
  type OrderData,
  type OrderTransactionData,
  parseGid,
  type RefundData,
  type RefundLineItemData,
  save,
} from './records.js';
import { idempotent } from './schema.js';

const fields = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null
    ? Object.fromEntries(Object.entries(value))
    : {};

/** Calculates an exact line refund against remaining quantities and captured money. */
export async function suggestedRefund(
  context: RequestContext,
  order: StoredRecord<OrderData>,
  args: Args,
) {
  const requested = Array.isArray(args.refundLineItems)
    ? args.refundLineItems
    : [];
  if (args.refundShipping || args.suggestFullRefund)
    throw new GraphQLError('This simulator supports explicit line refunds');
  const lines = await all<LineItemData>(context.shop, {
    kind: 'LineItem',
    parent: order.id,
  });
  const result: StoredRecord<RefundLineItemData>[] = [];
  let amount = 0;
  for (const value of requested) {
    const input = fields(value),
      source =
        typeof input.lineItemId === 'string'
          ? parseGid(input.lineItemId, 'LineItem')
          : undefined;
    const line = lines.find((l) => l.id === source?.id),
      quantity = input.quantity;
    if (
      !line ||
      typeof quantity !== 'number' ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      quantity > (line.data.currentQuantity ?? line.data.quantity) ||
      input.restockType !== 'NO_RESTOCK' ||
      result.some((r) => r.data.lineItem === line.id)
    )
      throw new GraphQLError('Invalid refundable line quantity');
    amount += quantity * line.data.price;
    result.push({
      ...line,
      kind: 'RefundLineItem',
      id: `quote-${line.id}`,
      data: {
        refund: '',
        lineItem: line.id,
        quantity,
        restockType: 'NO_RESTOCK',
        restocked: false,
      },
    });
  }
  const sales = (
    await all<OrderTransactionData>(context.shop, {
      kind: 'OrderTransaction',
      parent: order.id,
    })
  ).filter(
    (t) =>
      ['SALE', 'CAPTURE'].includes(t.data.kind) && t.data.status === 'SUCCESS',
  );
  const allTransactions = await all<OrderTransactionData>(context.shop, {
    kind: 'OrderTransaction',
    parent: order.id,
  });
  let remaining = amount;
  const transactions = [];
  let maximum = 0;
  for (const sale of sales) {
    const reserved = allTransactions
      .filter(
        (t) =>
          t.data.kind === 'REFUND' &&
          t.data.parent === sale.id &&
          ['PENDING', 'SUCCESS'].includes(t.data.status),
      )
      .reduce((sum, t) => sum + t.data.amount, 0);
    const available = Math.max(0, sale.data.amount - reserved);
    maximum += available;
    const part = Math.min(remaining, available);
    if (part > 0) {
      transactions.push({
        __typename: 'SuggestedOrderTransaction',
        amountSet: moneyBag(part, order.data.currency),
        gateway: sale.data.gateway,
        kind: 'SUGGESTED_REFUND',
        parentTransaction: sale,
      });
      remaining -= part;
    }
  }
  if (!result.length || remaining || amount <= 0)
    throw new GraphQLError('No captured money available for these units');

  return {
    __typename: 'SuggestedRefund',
    amountSet: moneyBag(amount, order.data.currency),
    maximumRefundableSet: moneyBag(maximum, order.data.currency),
    refundLineItems: result,
    suggestedTransactions: transactions,
  };
}

/** Writes one pending refund with NO_RESTOCK and a durable native idempotency receipt. */
export async function refundCreate(
  context: RequestContext,
  args: Args,
  info: GraphQLResolveInfo,
) {
  if (!context.shop.config.scopes.includes('write_orders'))
    throw new GraphQLError('Orders write scope is required');
  const field = info.fieldNodes[0],
    key = field
      ? getDirectiveValues(idempotent, field, info.variableValues)?.key
      : null;
  if (typeof key !== 'string' || !/^[0-9a-f-]{36}$/.test(key))
    throw new GraphQLError('A UUID idempotency key is required');
  const input = fields(args.input),
    serialized = JSON.stringify(input),
    receiptId = `refund:${key}`;
  const prior = await context.shop.store.get<IdempotencyKeyData>(
    'IdempotencyKey',
    receiptId,
  );
  if (prior) {
    if (prior.data.input !== serialized)
      throw new GraphQLError('Idempotency key parameter mismatch');

    return prior.data.result;
  }
  const target =
    typeof input.orderId === 'string' ? parseGid(input.orderId, 'Order') : null;
  if (!target || input.notify !== false || input.allowOverRefunding !== false)
    throw new GraphQLError('Invalid refund input');
  const order = await load<OrderData>(context.shop, 'Order', target.id);
  const quote = await suggestedRefund(context, order, {
    refundLineItems: input.refundLineItems,
  });
  const transactions = Array.isArray(input.transactions)
    ? input.transactions.map(fields)
    : [];
  if (
    input.currency !== order.data.currency ||
    transactions.length !== quote.suggestedTransactions.length ||
    transactions.some(
      (t) =>
        t.kind !== 'REFUND' ||
        t.orderId !== input.orderId ||
        !quote.suggestedTransactions.some(
          (q) =>
            t.parentId === gid('OrderTransaction', q.parentTransaction.id) &&
            t.gateway === q.gateway &&
            typeof t.amount === 'string' &&
            minorUnits(t.amount) ===
              minorUnits(q.amountSet.presentmentMoney.amount),
        ),
    )
  )
    throw new GraphQLError(
      'Refund transactions differ from the current suggestion',
    );
  const id = await nextId(context.shop),
    amount = minorUnits(quote.amountSet.presentmentMoney.amount),
    records = [];
  for (const value of input.refundLineItems as unknown[]) {
    const line = fields(value),
      target = parseGid(String(line.lineItemId), 'LineItem')!,
      quantity = Number(line.quantity);
    records.push(
      insert(
        context.shop,
        'RefundLineItem',
        await nextId(context.shop),
        {
          refund: id,
          lineItem: target.id,
          quantity,
          restockType: 'NO_RESTOCK',
          restocked: false,
        } satisfies RefundLineItemData,
        { parent: id },
      ),
    );
    const original = await load<LineItemData>(
      context.shop,
      'LineItem',
      target.id,
    );
    await save(context.shop, 'LineItem', target.id, {
      ...original.data,
      currentQuantity:
        (original.data.currentQuantity ?? original.data.quantity) - quantity,
    });
  }
  for (const transaction of transactions)
    records.push(
      insert(
        context.shop,
        'OrderTransaction',
        await nextId(context.shop),
        {
          order: order.id,
          refund: id,
          parent: parseGid(String(transaction.parentId), 'OrderTransaction')!
            .id,
          kind: 'REFUND',
          status: 'PENDING',
          gateway: String(transaction.gateway),
          amount: minorUnits(String(transaction.amount)),
          processedAt: null,
        } satisfies OrderTransactionData,
        { parent: order.id, key: id },
      ),
    );
  const data: RefundData = {
    order: order.id,
    return: null,
    amount,
    total: 0,
    note: typeof input.note === 'string' ? input.note : null,
  };
  records.push(insert(context.shop, 'Refund', id, data, { parent: order.id }));
  await context.shop.store.putMany(records);
  context.committed = true;
  await touchOrder(context.shop, order);
  notify(context.shop, 'refunds/create', 'Refund', id, {
    order_id: Number(order.id),
  });
  const result = {
    refund: await context.shop.store.get('Refund', id),
    userErrors: [],
  };
  await save(context.shop, 'IdempotencyKey', receiptId, {
    input: serialized,
    result,
  } satisfies IdempotencyKeyData);
  context.loader.clear();

  return result;
}

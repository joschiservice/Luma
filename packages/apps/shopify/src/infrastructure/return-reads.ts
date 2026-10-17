import type { RefundSnapshot, ReturnSnapshot } from '@luma/connections';
import { z } from 'zod';

import {
  quantity,
  type ReadSession,
  ref,
  statusFrom,
  text,
} from './read-session.js';
import * as s from './schemas.js';

const returnStatuses: Record<string, ReturnSnapshot['status']> = {
  REQUESTED: 'requested',
  OPEN: 'open',
  CLOSED: 'closed',
  DECLINED: 'declined',
  CANCELED: 'cancelled',
};

const declineReasons: Record<
  string,
  NonNullable<ReturnSnapshot['declineReason']>
> = {
  RETURN_PERIOD_ENDED: 'return_period_ended',
  FINAL_SALE: 'final_sale',
};

const restockTypes: Record<string, RefundSnapshot['lines'][number]['restock']> =
  {
    RETURN: 'return',
    CANCEL: 'cancel',
    NO_RESTOCK: 'no_restock',
  };

// Only a successful refund transaction returned money; awaiting a response is still pending.
const transactionStatuses: Record<
  string,
  RefundSnapshot['transactions'][number]['status']
> = {
  SUCCESS: 'success',
  PENDING: 'pending',
  AWAITING_RESPONSE: 'pending',
  FAILURE: 'failed',
  ERROR: 'failed',
};

/** Emits an order's returns, then its refunds, which may refer to them. */
export async function readReturns(session: ReadSession, orderId: string) {
  const { node, children, emit } = session;
  const order = ref(orderId);
  const returns = await children(
    orderId,
    'Order',
    'returns',
    'id name status createdAt requestApprovedAt closedAt decline { reason }',
    s.returnNode,
  );
  for (const item of returns) {
    const lines = await children(
      item.id,
      'Return',
      'returnLineItems',
      'id quantity refundedQuantity returnReasonDefinition { name } ... on ReturnLineItem { fulfillmentLineItem { id lineItem { id } } withCodeDiscountedTotalPriceSet { shopMoney { amount currencyCode } } }',
      s.returnLine,
    );
    // Dispositions record what came back; MISSING units were not received.
    const receipts = new Map<string, { received: number; restocked: number }>();
    let receivedAt: string | null = null;
    for (const reverse of await children(
      item.id,
      'Return',
      'reverseFulfillmentOrders',
      'id status',
      s.reverseFulfillmentOrder,
    ))
      for (const line of await children(
        reverse.id,
        'ReverseFulfillmentOrder',
        'lineItems',
        'id fulfillmentLineItem { id } dispositions { type quantity createdAt }',
        s.reverseLine,
      )) {
        if (!line.fulfillmentLineItem) continue;
        const receipt = receipts.get(line.fulfillmentLineItem.id) ?? {
          received: 0,
          restocked: 0,
        };
        for (const disposition of line.dispositions) {
          if (disposition.type === 'MISSING') continue;
          receipt.received += disposition.quantity;
          if (disposition.type === 'RESTOCKED')
            receipt.restocked += disposition.quantity;
          if (
            !receivedAt ||
            Date.parse(disposition.createdAt) > Date.parse(receivedAt)
          )
            receivedAt = disposition.createdAt;
        }
        receipts.set(line.fulfillmentLineItem.id, receipt);
      }
    const status = statusFrom(returnStatuses, item.status);
    emit('return', ref(item.id), null, {
      type: 'return',
      order,
      name: text(item.name),
      status,
      requestedAt: item.createdAt ?? null,
      approvedAt: item.requestApprovedAt ?? null,
      closedAt: item.closedAt ?? null,
      declineReason: item.decline
        ? (declineReasons[item.decline.reason] ?? 'other')
        : null,
      receivedAt,
      lines: lines
        .filter((line) => line.quantity > 0)
        .map((line) => {
          const fulfilled = line.fulfillmentLineItem;
          const receipt = fulfilled
            ? (receipts.get(fulfilled.id) ?? {
                received: 0,
                restocked: 0,
              })
            : null;
          const value = line.withCodeDiscountedTotalPriceSet?.shopMoney;

          return {
            orderLine: fulfilled ? ref(fulfilled.lineItem.id, orderId) : null,
            quantity: quantity(line.quantity),
            reason: text(line.returnReasonDefinition?.name),
            receivedQuantity: receipt ? String(receipt.received) : null,
            restockedQuantity: receipt ? String(receipt.restocked) : null,
            refundedQuantity:
              line.refundedQuantity == null
                ? null
                : String(line.refundedQuantity),
            value: value
              ? { amount: value.amount, currency: value.currencyCode }
              : null,
          };
        }),
    } satisfies ReturnSnapshot);
  }
  // Order.refunds is an unpaginated list. Omit `first` to avoid silently truncating refunds.
  const { refunds } = await node(
    orderId,
    'Order',
    'refunds { id createdAt updatedAt totalRefundedSet { shopMoney { amount currencyCode } } return { id } }',
    z.object({ refunds: z.array(s.refundNode) }),
  );
  for (const refund of refunds) {
    const lines = await children(
      refund.id,
      'Refund',
      'refundLineItems',
      'quantity restockType restocked lineItem { id }',
      s.refundLine,
    );
    const transactions = await children(
      refund.id,
      'Refund',
      'transactions',
      'id kind status processedAt gateway amountSet { shopMoney { amount currencyCode } }',
      s.refundTransaction,
    );
    const total = refund.totalRefundedSet?.shopMoney;
    emit('refund', ref(refund.id), refund.updatedAt, {
      type: 'refund',
      order,
      return: refund.return ? ref(refund.return.id) : null,
      createdAt: refund.createdAt,
      total: total
        ? { amount: total.amount, currency: total.currencyCode }
        : null,
      lines: lines
        .filter((line) => line.quantity > 0)
        .map((line) => ({
          orderLine: ref(line.lineItem.id, orderId),
          quantity: quantity(line.quantity),
          restock: statusFrom(restockTypes, line.restockType),
          restocked: line.restocked,
        })),
      transactions: transactions
        .filter((transaction) => transaction.kind === 'REFUND')
        .map((transaction) => ({
          status: statusFrom(transactionStatuses, transaction.status),
          amount: {
            amount: transaction.amountSet.shopMoney.amount,
            currency: transaction.amountSet.shopMoney.currencyCode,
          },
          processedAt: transaction.processedAt,
          gateway: text(transaction.gateway),
        })),
    } satisfies RefundSnapshot);
  }
}

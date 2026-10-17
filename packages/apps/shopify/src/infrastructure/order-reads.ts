import type { HistoryLimit, OrderSnapshot } from '@luma/connections';
import { parse } from '@luma/connector-shopify';

import { lineFacts, mailingAddress, orderFacts } from './order-facts.js';
import {
  discountApplication,
  orderLine,
  orderSelection,
  shippingLine,
} from './read-selections.js';
import {
  quantity,
  type ReadSession,
  ref,
  statusFrom,
  text,
} from './read-session.js';
import * as s from './schemas.js';

const paymentStatuses: Record<string, OrderSnapshot['paymentStatus']> = {
  PENDING: 'pending',
  AUTHORIZED: 'authorized',
  PAID: 'paid',
  PARTIALLY_REFUNDED: 'partially_refunded',
  REFUNDED: 'refunded',
};

// Without read_all_orders, Shopify returns orders created in the last 60 days.
export const recentOrderWindowMs = 60 * 24 * 60 * 60 * 1000;

/** The order history Shopify hides from an installation without `read_all_orders`, if any. */
export const orderHistory = (
  scopes: { handle: string }[],
  at: Date,
): HistoryLimit | null =>
  scopes.some((scope) => scope.handle === 'read_all_orders')
    ? null
    : {
        availableFrom: new Date(
          at.getTime() - recentOrderWindowMs,
        ).toISOString(),
        requirement: 'read_all_orders',
      };

/**
 * Emits one order with all line, shipping and discount pages. Export reads leave discounts
 * unread; protected addresses come from the page cache and are never captured.
 */
export async function readOrder(
  session: ReadSession,
  parent: { id: string },
  {
    orderCustomers,
    orderAddresses,
    bulk,
  }: { orderCustomers: boolean; orderAddresses: boolean; bulk: boolean },
) {
  const { node, children, emit, cached } = session;
  const order = await node(
    parent.id,
    'Order',
    orderSelection(orderCustomers, orderAddresses),
    s.order,
  );
  const lines = await children(
    parent.id,
    'Order',
    'lineItems',
    orderLine,
    s.orderLine,
    { size: 50 },
  );
  const shipping = await children(
    parent.id,
    'Order',
    'shippingLines',
    shippingLine,
    s.shippingLine,
    { args: 'includeRemovals: true', size: 50 },
  );
  // Exports cannot include discounts; they stay unread until an incremental read.
  const discounts = bulk
    ? undefined
    : await children(
        parent.id,
        'Order',
        'discountApplications',
        discountApplication,
        s.discountApplication,
      );
  // Protected address fields are parsed from the page cache and never captured.
  const addresses = orderAddresses
    ? parse(s.orderAddresses, cached(order.id))
    : null;
  const total = order.currentTotalPriceSet?.shopMoney;
  emit('order', ref(order.id), order.updatedAt, {
    displayNumber: order.name,
    placedAt: order.createdAt ?? null,
    total: total
      ? { amount: total.amount, currency: total.currencyCode }
      : null,
    ...(orderCustomers && order.customer !== undefined
      ? {
          customer: order.customer ? ref(order.customer.id) : null,
        }
      : {}),
    addresses: addresses
      ? {
          shared: true,
          shipping: mailingAddress(addresses.shippingAddress),
          billing: mailingAddress(addresses.billingAddress),
        }
      : { shared: false },
    status: order.cancelledAt
      ? 'cancelled'
      : order.closed
        ? 'completed'
        : 'open',
    paymentStatus: statusFrom(
      paymentStatuses,
      order.displayFinancialStatus ?? '',
    ),
    ...orderFacts(order, shipping, discounts),
    lines: lines.map((line) => ({
      id: ref(line.id, order.id),
      sku: line.variant ? ref(line.variant.inventoryItem.id) : null,
      quantity: quantity(line.quantity),
      currentQuantity: quantity(line.currentQuantity),
      cancelledQuantity: quantity(line.quantity - line.currentQuantity),
      ...(line.originalUnitPriceSet?.shopMoney
        ? {
            unitPrice: {
              amount: line.originalUnitPriceSet.shopMoney.amount,
              currency: line.originalUnitPriceSet.shopMoney.currencyCode,
            },
            // The shop setting the order was placed under.
            taxIncluded: order.taxesIncluded ?? null,
          }
        : { unitPrice: null, taxIncluded: null }),
      // Multiple tax jurisdictions do not establish one tax rate.
      taxRate:
        line.taxLines?.length === 1 && line.taxLines[0]?.rate != null
          ? String(line.taxLines[0].rate)
          : line.taxLines?.length === 0
            ? '0'
            : null,
      skuCode: text(line.sku),
      title: text(line.name),
      ...(line.lineItemGroup === undefined
        ? {}
        : {
            bundleGroup: line.lineItemGroup
              ? {
                  id: ref(line.lineItemGroup.id),
                  title: line.lineItemGroup.title,
                  quantity: String(line.lineItemGroup.quantity),
                  product: line.lineItemGroup.productId
                    ? ref(line.lineItemGroup.productId)
                    : null,
                  variant: line.lineItemGroup.variantId
                    ? ref(line.lineItemGroup.variantId)
                    : null,
                  skuCode: text(line.lineItemGroup.variantSku),
                }
              : null,
          }),
      ...lineFacts(line),
    })),
  } satisfies OrderSnapshot);
}

import type { MoneyPair, OrderAddress, OrderSnapshot } from '@luma/connections';
import type { z } from 'zod';

import type * as s from './schemas.js';

type Bag = z.infer<typeof s.moneyBag>;

type Line = OrderSnapshot['lines'][number];

const decimal = /^\d{1,14}(\.\d{1,6})?$/;

// Blank or oversized source text is treated as not provided rather than truncated.
const text = (value: string | null | undefined, max = 512) => {
  const trimmed = value?.trim();

  return trimmed && trimmed.length <= max ? trimmed : null;
};

const enumFrom = <T extends string>(
  mapping: Record<string, T>,
  value: string | null | undefined,
): T | 'unknown' =>
  value && Object.hasOwn(mapping, value)
    ? (mapping[value] ?? 'unknown')
    : 'unknown';

const discountKinds: Record<
  string,
  NonNullable<OrderSnapshot['discounts']>[number]['kind']
> = {
  DiscountCodeApplication: 'code',
  AutomaticDiscountApplication: 'automatic',
  ManualDiscountApplication: 'manual',
  ScriptDiscountApplication: 'script',
};

const cancelReasons: Record<
  string,
  NonNullable<NonNullable<OrderSnapshot['attributes']>['cancelReason']>
> = {
  CUSTOMER: 'customer',
  DECLINED: 'declined',
  FRAUD: 'fraud',
  INVENTORY: 'inventory',
  STAFF: 'staff',
  OTHER: 'other',
};

/** Shop and presentment money exactly as reported; null when either is missing. */
function moneyPair(bag: Bag): MoneyPair | null {
  return bag
    ? {
        shop: {
          amount: bag.shopMoney.amount,
          currency: bag.shopMoney.currencyCode,
        },
        presentment: {
          amount: bag.presentmentMoney.amount,
          currency: bag.presentmentMoney.currencyCode,
        },
      }
    : null;
}

// Shopify reports rates and percentages as floats; values without an exact short decimal form
// are treated as not reported rather than rounded.
const decimalFrom = (value: number | null | undefined, max: number) => {
  if (value == null || !Number.isFinite(value) || value < 0 || value > max)
    return null;
  const formatted = String(value);

  return decimal.test(formatted) ? formatted : null;
};

function discountValue(
  value: z.infer<typeof s.discountApplication>['value'],
): NonNullable<OrderSnapshot['discounts']>[number]['value'] {
  if (!value) return null;
  if ('percentage' in value) {
    const percentage = decimalFrom(value.percentage, 100);

    return percentage ? { type: 'percentage', percentage } : null;
  }

  return {
    type: 'fixed',
    amount: { amount: value.amount, currency: value.currencyCode },
  };
}

/** A source address in the customer profile shape; no names or phone numbers are read. */
export function mailingAddress(
  value: z.infer<typeof s.mailingAddress>,
): OrderAddress | null {
  return value
    ? {
        line1: text(value.address1),
        line2: text(value.address2),
        city: text(value.city, 256),
        region: text(value.provinceCode, 256),
        postalCode: text(value.zip, 64),
        country: text(value.countryCodeV2, 128),
      }
    : null;
}

/**
 * The order's currencies, amounts, tax, shipping and discount facts, tags and operational
 * attributes. `discounts` is undefined when they were not read, which leaves them absent.
 */
export function orderFacts(
  order: z.infer<typeof s.order>,
  shipping: z.infer<typeof s.shippingLine>[],
  discounts: z.infer<typeof s.discountApplication>[] | undefined,
): Omit<OrderSnapshot, 'displayNumber' | 'status' | 'paymentStatus' | 'lines'> {
  const amount = (original: Bag, current: Bag) => ({
    original: moneyPair(original),
    current: moneyPair(current),
  });
  const total = order.currentTotalPriceSet;
  const status = order.displayFulfillmentStatus?.trim();

  return {
    currencies: {
      shop: order.currencyCode ?? null,
      presentment: order.presentmentCurrencyCode ?? null,
    },
    amounts: {
      subtotal: amount(order.subtotalPriceSet, order.currentSubtotalPriceSet),
      shipping: amount(
        order.totalShippingPriceSet,
        order.currentShippingPriceSet,
      ),
      discounts: amount(
        order.totalDiscountsSet,
        order.currentTotalDiscountsSet,
      ),
      tax: amount(order.totalTaxSet, order.currentTotalTaxSet),
      duties: amount(order.originalTotalDutiesSet, order.currentTotalDutiesSet),
      total: amount(
        order.originalTotalPriceSet,
        total?.presentmentMoney
          ? {
              shopMoney: total.shopMoney,
              presentmentMoney: total.presentmentMoney,
            }
          : null,
      ),
    },
    taxesIncluded: order.taxesIncluded ?? null,
    dutiesIncluded: order.dutiesIncluded ?? null,
    ...(order.currentTaxLines
      ? {
          taxLines: order.currentTaxLines.slice(0, 100).map((line) => ({
            title: text(line.title),
            rate: decimalFrom(line.rate, 1),
            amount: moneyPair(line.priceSet),
          })),
        }
      : {}),
    shippingLines: shipping.slice(0, 100).map((line) => ({
      id: text(line.id, 1024),
      title: text(line.title),
      code: text(line.code),
      source: text(line.source),
      carrier: text(line.carrierIdentifier),
      removed: line.isRemoved ?? null,
      original: moneyPair(line.originalPriceSet),
      discounted: moneyPair(line.discountedPriceSet),
      current: moneyPair(line.currentDiscountedPriceSet),
    })),
    ...(discounts
      ? {
          discounts: discounts.slice(0, 250).map((discount) => ({
            index: discount.index ?? null,
            kind: enumFrom(discountKinds, discount.__typename),
            label: text(discount.code ?? discount.title),
            target:
              discount.targetType === 'LINE_ITEM'
                ? 'line_item'
                : discount.targetType === 'SHIPPING_LINE'
                  ? 'shipping_line'
                  : 'unknown',
            allocation:
              discount.allocationMethod === 'ACROSS'
                ? 'across'
                : discount.allocationMethod === 'EACH'
                  ? 'each'
                  : 'unknown',
            value: discountValue(discount.value),
          })),
        }
      : {}),
    ...(order.tags
      ? {
          tags: order.tags
            .map((tag) => tag.trim())
            .filter((tag) => tag.length > 0 && tag.length <= 255)
            .slice(0, 250),
        }
      : {}),
    attributes: {
      edited: order.edited ?? null,
      requiresShipping: order.requiresShipping ?? null,
      test: order.test ?? null,
      cancelReason: order.cancelReason
        ? enumFrom(cancelReasons, order.cancelReason)
        : null,
      cancelledAt: order.cancelledAt,
      closedAt: order.closedAt ?? null,
      processedAt: order.processedAt ?? null,
      channel: text(order.sourceName),
      fulfillmentStatus:
        status && /^[A-Z][A-Z0-9_]{0,63}$/.test(status)
          ? status.toLowerCase()
          : null,
    },
  };
}

/** A line's prices, variant title, shipping requirement and catalog state. */
export function lineFacts(
  line: z.infer<typeof s.orderLine>,
): Pick<Line, 'variantTitle' | 'prices' | 'requiresShipping' | 'catalog'> {
  const original = line.originalUnitPriceSet;

  return {
    variantTitle: text(line.variantTitle),
    prices: {
      originalUnit: original?.presentmentMoney
        ? moneyPair({
            shopMoney: original.shopMoney,
            presentmentMoney: original.presentmentMoney,
          })
        : null,
      discountedUnit: moneyPair(line.discountedUnitPriceAfterAllDiscountsSet),
      totalDiscount: moneyPair(line.totalDiscountSet),
    },
    requiresShipping: line.requiresShipping ?? null,
    // Without a product the line is a custom item or its product was deleted; Shopify does
    // not say which.
    ...(line.variant
      ? { catalog: 'variant' as const }
      : line.product === undefined
        ? {}
        : {
            catalog: line.product
              ? ('variant_removed' as const)
              : ('no_product' as const),
          }),
  };
}

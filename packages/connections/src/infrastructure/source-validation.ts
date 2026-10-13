import { z } from 'zod';

import type { SourceIdentity } from '../domain/capabilities.js';

const uuid = z.string().uuid();

const decimal = z.string().regex(/^-?\d{1,14}(\.\d{1,6})?$/);

const units = (s: string) => {
  const [whole, fraction = ''] = s.replace('-', '').split('.');

  return BigInt(whole!) * 1000000n + BigInt(fraction.padEnd(6, '0'));
};

const positive = decimal.refine((s) => !s.startsWith('-') && units(s) > 0n);

const timestamp = z.string().datetime({ offset: true });

const unit = z.string().min(1).max(64);

const external = z
  .object({
    externalId: z.string().min(1).max(1024),
    scopeKey: z.string().max(1024),
  })
  .strict();

export const sourceSchema = external
  .extend({
    tenantId: uuid,
    connectionId: uuid,
    provider: z.string().min(1).max(100),
    resource: z.enum([
      'order',
      'order_line',
      'fulfillment',
      'sku',
      'location',
      'product',
      'customer',
      'return',
      'refund',
      'supplier',
      'purchase_order',
      'return_reason',
    ]),
  })
  .strict();

const quantity = z.object({ amount: positive, unit }).strict();
const remainingQuantity = z
  .object({ amount: decimal.refine((s) => !s.startsWith('-')), unit })
  .strict();

const money = z
  .object({ amount: decimal, currency: z.string().regex(/^[A-Z]{3}$/) })
  .strict();

const listPrice = z
  .object({
    amount: decimal,
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable(),
  })
  .strict();

const text = z.string().min(1).max(512);

const currency = z.string().regex(/^[A-Z]{3}$/);
const moneyPair = z.object({ shop: money, presentment: money }).strict();
const amount = z
  .object({ original: moneyPair.nullable(), current: moneyPair.nullable() })
  .strict();
const timestampOrNull = timestamp.nullable();

/**
 * Optional commercial and delivery facts of an order; each rule is repeated in the orders
 * owner's snapshot schema. Addresses are not accepted: they are erasable personal data.
 */
const orderCommercialFacts = {
  currencies: z
    .object({ shop: currency.nullable(), presentment: currency.nullable() })
    .strict()
    .optional(),
  amounts: z
    .object({
      subtotal: amount,
      shipping: amount,
      discounts: amount,
      tax: amount,
      duties: amount,
      total: amount,
    })
    .strict()
    .optional(),
  taxesIncluded: z.boolean().nullable().optional(),
  dutiesIncluded: z.boolean().nullable().optional(),
  taxLines: z
    .array(
      z
        .object({
          title: text.nullable(),
          rate: decimal
            .refine((v) => !v.startsWith('-') && Number(v) <= 1)
            .nullable(),
          amount: moneyPair.nullable(),
        })
        .strict(),
    )
    .max(100)
    .optional(),
  shippingLines: z
    .array(
      z
        .object({
          id: z.string().min(1).max(1024).nullable(),
          title: text.nullable(),
          code: text.nullable(),
          source: text.nullable(),
          carrier: text.nullable(),
          removed: z.boolean().nullable(),
          original: moneyPair.nullable(),
          discounted: moneyPair.nullable(),
          current: moneyPair.nullable(),
        })
        .strict(),
    )
    .max(100)
    .optional(),
  discounts: z
    .array(
      z
        .object({
          index: z.number().int().min(0).nullable(),
          kind: z.enum(['code', 'automatic', 'manual', 'script', 'unknown']),
          label: text.nullable(),
          target: z.enum(['line_item', 'shipping_line', 'unknown']),
          allocation: z.enum(['across', 'each', 'unknown']),
          value: z
            .discriminatedUnion('type', [
              z
                .object({
                  type: z.literal('percentage'),
                  percentage: decimal.refine(
                    (v) => !v.startsWith('-') && Number(v) <= 100,
                  ),
                })
                .strict(),
              z.object({ type: z.literal('fixed'), amount: money }).strict(),
            ])
            .nullable(),
        })
        .strict(),
    )
    .max(250)
    .optional(),
  tags: z.array(z.string().min(1).max(255)).max(250).optional(),
  attributes: z
    .object({
      edited: z.boolean().nullable(),
      requiresShipping: z.boolean().nullable(),
      test: z.boolean().nullable(),
      cancelReason: z
        .enum([
          'customer',
          'declined',
          'fraud',
          'inventory',
          'staff',
          'other',
          'unknown',
        ])
        .nullable(),
      cancelledAt: timestampOrNull,
      closedAt: timestampOrNull,
      processedAt: timestampOrNull,
      channel: text.nullable(),
      fulfillmentStatus: z
        .string()
        .regex(/^[a-z][a-z0-9_]{0,63}$/)
        .nullable(),
    })
    .strict()
    .optional(),
};

/** Optional order line facts; each rule is repeated in the orders owner's snapshot schema. */
const orderLineFacts = {
  variantTitle: text.nullable().optional(),
  prices: z
    .object({
      originalUnit: moneyPair.nullable(),
      discountedUnit: moneyPair.nullable(),
      totalDiscount: moneyPair.nullable(),
    })
    .strict()
    .optional(),
  requiresShipping: z.boolean().nullable().optional(),
  catalog: z.enum(['variant', 'variant_removed', 'no_product']).optional(),
};

/** Optional fulfillment facts; each rule is repeated in the orders owner's snapshot schema. */
const fulfillmentFacts = {
  kind: z.enum(['fulfillment_order', 'shipment']).nullable().optional(),
  holds: z
    .array(
      z
        .object({
          reason: z.enum([
            'awaiting_payment',
            'high_risk_of_fraud',
            'incorrect_address',
            'inventory_out_of_stock',
            'unknown_delivery_date',
            'awaiting_return_items',
            'other',
          ]),
        })
        .strict(),
    )
    .max(50)
    .optional(),
  location: z
    .object({ id: external, name: text.nullable() })
    .strict()
    .nullable()
    .optional(),
  fulfillAt: timestamp.nullable().optional(),
  fulfillBy: timestamp.nullable().optional(),
  estimatedDeliveryAt: timestamp.nullable().optional(),
  method: z
    .object({
      type: z.enum([
        'shipping',
        'pick_up',
        'pickup_point',
        'local',
        'retail',
        'none',
        'unknown',
      ]),
      name: text.nullable(),
    })
    .strict()
    .nullable()
    .optional(),
  tracking: z
    .array(
      z
        .object({
          carrier: text.nullable(),
          number: text.nullable(),
          url: z
            .string()
            .max(2048)
            .url()
            .regex(/^https?:\/\//i)
            .nullable(),
        })
        .strict(),
    )
    .max(50)
    .optional(),
  delivery: z
    .enum([
      'label_created',
      'in_transit',
      'out_for_delivery',
      'attempted_delivery',
      'delayed',
      'ready_for_pickup',
      'delivered',
      'failed',
    ])
    .nullable()
    .optional(),
};
const count = decimal.refine((s) => !s.startsWith('-'));

const returnData = z
  .object({
    type: z.literal('return'),
    order: external,
    name: text.nullable(),
    status: z.enum([
      'requested',
      'open',
      'closed',
      'declined',
      'cancelled',
      'unknown',
    ]),
    requestedAt: timestamp.nullable(),
    approvedAt: timestamp.nullable(),
    closedAt: timestamp.nullable(),
    declineReason: z
      .enum(['return_period_ended', 'final_sale', 'other'])
      .nullable(),
    receivedAt: timestamp.nullable(),
    lines: z
      .array(
        z
          .object({
            orderLine: external.nullable(),
            quantity,
            reason: text.nullable(),
            receivedQuantity: count.nullable(),
            restockedQuantity: count.nullable(),
            refundedQuantity: count.nullable(),
            value: money.nullable(),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();

const refundData = z
  .object({
    type: z.literal('refund'),
    order: external,
    return: external.nullable(),
    createdAt: timestamp.nullable(),
    total: money.nullable(),
    lines: z
      .array(
        z
          .object({
            orderLine: external,
            quantity,
            restock: z.enum(['return', 'cancel', 'no_restock', 'unknown']),
            restocked: z.boolean(),
          })
          .strict(),
      )
      .max(500),
    transactions: z
      .array(
        z
          .object({
            status: z.enum(['success', 'pending', 'failed', 'unknown']),
            amount: money,
            processedAt: timestamp.nullable(),
            gateway: text.nullable(),
          })
          .strict(),
      )
      .max(250),
  })
  .strict();

const observation = <T extends z.ZodTypeAny>(
  resource: z.ZodType<SourceIdentity['resource']>,
  data: T,
) =>
  z
    .object({
      id: uuid,
      source: sourceSchema.extend({ resource }),
      kind: z.enum(['snapshot', 'tombstone']),
      observedAt: timestamp,
      sourceUpdatedAt: timestamp.nullable(),
      sourceRevision: z.string().nullable(),
      adapterVersion: z.string().min(1),
      schemaVersion: z.literal(1),
      data,
    })
    .strict();

export const commerceSchema = z.discriminatedUnion('capability', [
  z
    .object({
      capability: z.literal('orders.read'),
      observation: observation(
        z.literal('order'),
        z
          .object({
            displayNumber: z.string().nullable(),
            externalOrderNumber: z.string().max(512).nullable().optional(),
            dueAt: z.string().datetime({ offset: true }).nullable().optional(),
            placedAt: timestamp.nullable().optional(),
            total: money.nullable().optional(),
            status: z.enum(['open', 'completed', 'cancelled', 'unknown']),
            paymentStatus: z.enum([
              'pending',
              'authorized',
              'paid',
              'partially_refunded',
              'refunded',
              'failed',
              'unknown',
            ]),
            ...orderCommercialFacts,
            lines: z.array(
              z
                .object({
                  id: external,
                  sku: external.nullable(),
                  quantity,
                  currentQuantity: remainingQuantity.nullable().optional(),
                  cancelledQuantity: z
                    .object({ amount: decimal, unit })
                    .strict()
                    .nullable(),
                  unitPrice: money.nullable().optional(),
                  taxIncluded: z.boolean().nullable().optional(),
                  taxRate: decimal
                    .refine((v) => !v.startsWith('-') && Number(v) <= 1)
                    .nullable()
                    .optional(),
                  skuCode: text.nullable().optional(),
                  title: text.nullable().optional(),
                  ...orderLineFacts,
                })
                .strict()
                .refine(
                  (v) =>
                    (v.currentQuantity == null ||
                      (v.currentQuantity.unit === v.quantity.unit &&
                        units(v.currentQuantity.amount) <=
                          units(v.quantity.amount))) &&
                    (v.cancelledQuantity === null ||
                      (v.cancelledQuantity.unit === v.quantity.unit &&
                        !v.cancelledQuantity.amount.startsWith('-') &&
                        units(v.cancelledQuantity.amount) <=
                          units(v.quantity.amount))),
                ),
            ),
          })
          .strict(),
      ),
    })
    .strict(),
  z
    .object({
      capability: z.literal('inventory.read'),
      observation: observation(
        z.literal('sku'),
        z
          .object({
            sku: external,
            location: external,
            unit,
            onHand: decimal.nullable(),
            reserved: decimal.nullable(),
            available: decimal.nullable(),
            availabilityBasis: z.enum([
              'provider_reported',
              'derived',
              'unknown',
            ]),
          })
          .strict(),
      ),
    })
    .strict(),
  z
    .object({
      capability: z.literal('fulfillment.read'),
      observation: observation(
        z.literal('fulfillment'),
        z
          .object({
            order: external,
            status: z.enum([
              'pending',
              'processing',
              'completed',
              'shipped',
              'delivered',
              'cancelled',
              'failed',
              'unknown',
            ]),
            lines: z.array(
              z
                .object({
                  orderLine: external,
                  quantity: remainingQuantity,
                  remainingQuantity: remainingQuantity.nullable().optional(),
                })
                .strict()
                .refine(
                  (line) =>
                    line.remainingQuantity == null ||
                    (line.remainingQuantity.unit === line.quantity.unit &&
                      units(line.remainingQuantity.amount) <=
                        units(line.quantity.amount)),
                ),
            ),
            lastProgressAt: timestamp.nullable(),
            progressBasis: z
              .enum(['note_created_or_package_shipped', 'source_updated'])
              .optional(),
            failureCode: z.string().nullable(),
            ...fulfillmentFacts,
          })
          .strict()
          .refine(
            (data) =>
              data.kind === 'fulfillment_order' ||
              data.lines.every((line) => units(line.quantity.amount) > 0n),
          ),
      ),
    })
    .strict(),
  z
    .object({
      capability: z.literal('products.read'),
      observation: observation(
        z.literal('product'),
        z
          .object({
            title: z.string().max(1024).nullable(),
            status: z.enum(['active', 'draft', 'archived', 'unknown']),
            vendor: z.string().max(1024).nullable().optional(),
            published: z.boolean().nullable().optional(),
            skus: z.array(
              z
                .object({
                  id: external,
                  code: z.string().max(1024).nullable(),
                  unit,
                  title: z.string().max(1024).nullable().optional(),
                  price: listPrice.nullable().optional(),
                  barcode: z.string().max(512).nullable().optional(),
                })
                .strict(),
            ),
          })
          .strict(),
      ),
    })
    .strict(),
  z
    .object({
      capability: z.literal('returns.read'),
      observation: observation(
        z.enum(['return', 'refund']),
        z.discriminatedUnion('type', [returnData, refundData]),
      ).refine((v) => v.source.resource === v.data.type, {
        message: 'The source resource must match the record type',
      }),
    })
    .strict(),
]);

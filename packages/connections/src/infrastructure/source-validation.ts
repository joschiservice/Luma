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
            committed: decimal.nullable().optional(),
            incoming: decimal.nullable().optional(),
            damaged: decimal.nullable().optional(),
            qualityControl: decimal.nullable().optional(),
            safetyStock: decimal.nullable().optional(),
            locationActive: z.boolean().nullable().optional(),
            itemActive: z.boolean().nullable().optional(),
            tracked: z.boolean().nullable().optional(),
            inventorySemantics: z.literal('shopify/1').nullable().optional(),
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

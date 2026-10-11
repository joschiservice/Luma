import { z } from 'zod';

const uuid = z.string().uuid();

const decimal = z.string().regex(/^-?\d{1,14}(\.\d{1,6})?$/);

const units = (s: string) => {
  const [whole, fraction = ''] = s.replace('-', '').split('.');

  return BigInt(whole!) * 1000000n + BigInt(fraction.padEnd(6, '0'));
};

const positive = decimal.refine((s) => !s.startsWith('-') && units(s) > 0n);
const count = decimal.refine((s) => !s.startsWith('-'));

const timestamp = z.string().datetime({ offset: true });

const unit = z.string().min(1).max(64);

const text = z.string().min(1).max(512);

const money = z
  .object({ amount: decimal, currency: z.string().regex(/^[A-Z]{3}$/) })
  .strict();

const base = z.object({
  entityId: uuid,
  connectionId: uuid,
  observationId: uuid,
  normalizerVersion: z.string().min(1),
  mappingVersion: z.string().regex(/^[a-f0-9]{64}$/),
  sourceRevision: z.string().nullable(),
  sourceUpdatedAt: timestamp.nullable(),
  observedAt: timestamp,
  deleted: z.boolean(),
});

const line = z
  .object({
    id: uuid,
    skuId: uuid.nullable(),
    quantity: positive,
    currentQuantity: count.nullable().optional(),
    cancelledQuantity: decimal.nullable(),
    unit,
    unitPrice: money.nullable().optional(),
    taxRate: count
      .refine((v) => Number(v) <= 1)
      .nullable()
      .optional(),
    skuCode: text.nullable().optional(),
    title: text.nullable().optional(),
  })
  .strict()
  .refine(
    (v) =>
      (v.currentQuantity == null ||
        units(v.currentQuantity) <= units(v.quantity)) &&
      (v.cancelledQuantity === null ||
        (!v.cancelledQuantity.startsWith('-') &&
          units(v.cancelledQuantity) <= units(v.quantity))),
  );

const order = z
  .object({
    type: z.literal('order'),
    displayNumber: z.string().nullable(),
    dueAt: timestamp.nullable().optional(),
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
    lines: z
      .array(line)
      .refine((v) => new Set(v.map((l) => l.id)).size === v.length),
  })
  .strict();

const fulfillment = z
  .object({
    type: z.literal('fulfillment'),
    orderId: uuid,
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
    lastProgressAt: timestamp.nullable(),
    failureCode: z.string().nullable(),
    lines: z
      .array(
        z
          .object({
            orderLineId: uuid,
            quantity: count,
            unit,
            remainingQuantity: count.nullable().optional(),
          })
          .strict()
          .refine(
            (line) =>
              line.remainingQuantity == null ||
              units(line.remainingQuantity) <= units(line.quantity),
          ),
      )
      .refine((v) => new Set(v.map((l) => l.orderLineId)).size === v.length),
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
      .object({ locationId: uuid.nullable(), name: text.nullable() })
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
  })
  .strict()
  .refine(
    (data) =>
      data.kind === 'fulfillment_order' ||
      data.lines.every((line) => units(line.quantity) > 0n),
  );

const returnRecord = z
  .object({
    type: z.literal('return'),
    orderId: uuid,
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
            orderLineId: uuid.nullable(),
            quantity: positive,
            unit,
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

const refundRecord = z
  .object({
    type: z.literal('refund'),
    orderId: uuid,
    returnId: uuid.nullable(),
    createdAt: timestamp.nullable(),
    total: money.nullable(),
    lines: z
      .array(
        z
          .object({
            orderLineId: uuid,
            quantity: positive,
            unit,
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

// Version 3 adds current order units and remaining fulfillment work. Stored versions 1
// and 2 stay valid; absent quantity facts stay unknown.
// Return and refund snapshots use version 1.
export const snapshotSchema = z.union([
  base
    .extend({
      schemaVersion: z.union([
        z.literal(1),
        z.literal(2),
        z.literal(3),
        z.literal(4),
      ]),
      kind: z.literal('order'),
      data: order,
    })
    .strict(),
  base
    .extend({
      schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      kind: z.literal('fulfillment'),
      data: fulfillment,
    })
    .strict(),
  base
    .extend({
      schemaVersion: z.literal(1),
      kind: z.literal('return'),
      data: returnRecord,
    })
    .strict(),
  base
    .extend({
      schemaVersion: z.literal(1),
      kind: z.literal('refund'),
      data: refundRecord,
    })
    .strict(),
]);

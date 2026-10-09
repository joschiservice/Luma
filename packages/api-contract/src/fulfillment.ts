import { z } from 'zod';

import {
  orderActivitySchema,
  orderIssueSchema,
  orderWorkflowRunSchema,
} from './orders.js';

const timestamp = z.string().datetime({ offset: true });

export const fulfillmentViewSchema = z.enum([
  'attention',
  'held',
  'delayed',
  'open',
  'in_transit',
  'all',
]);

/**
 * Why a fulfillment needs attention. `held`: a source hold stops open work. `overdue`: open
 * work is past the source's fulfill-by date. `stalled`: open work has reported no progress for
 * the stall window. `delivery_issue`: the carrier reports an attempted, delayed or failed
 * delivery. `late_delivery`: a shipment is past its estimated delivery and not delivered.
 * `failed`: the source reports the fulfillment failed.
 */
export const fulfillmentSignalSchema = z.enum([
  'held',
  'overdue',
  'stalled',
  'delivery_issue',
  'late_delivery',
  'failed',
]);

export const fulfillmentKindSchema = z.enum([
  'fulfillment_order',
  'shipment',
  'unknown',
]);

export const fulfillmentSortSchema = z.enum(['waiting', 'recent', 'deadline']);

export const fulfillmentStatusSchema = z.enum([
  'pending',
  'processing',
  'completed',
  'shipped',
  'delivered',
  'cancelled',
  'failed',
  'unknown',
]);

export const fulfillmentHoldReasonSchema = z.enum([
  'awaiting_payment',
  'high_risk_of_fraud',
  'incorrect_address',
  'inventory_out_of_stock',
  'unknown_delivery_date',
  'awaiting_return_items',
  'other',
]);

export const fulfillmentDeliverySchema = z.enum([
  'label_created',
  'in_transit',
  'out_for_delivery',
  'attempted_delivery',
  'delayed',
  'ready_for_pickup',
  'delivered',
  'failed',
]);

const trackingSchema = z.object({
  carrier: z.string().nullable(),
  number: z.string().nullable(),
  url: z.string().url().nullable(),
});

export const fulfillmentItemSchema = z.object({
  id: z.string().uuid(),
  connectionId: z.string().uuid(),
  externalId: z.string().nullable(),
  kind: fulfillmentKindSchema,
  status: fulfillmentStatusSchema,
  deleted: z.boolean(),
  /** Work is still expected: pending or processing, not removed, and the order is not cancelled. */
  open: z.boolean(),
  signals: z.array(fulfillmentSignalSchema),
  /** Null when the source does not report holds. */
  holds: z.array(fulfillmentHoldReasonSchema).nullable(),
  location: z
    .object({ id: z.string().uuid().nullable(), name: z.string().nullable() })
    .nullable(),
  method: z
    .object({ type: z.string(), name: z.string().nullable() })
    .nullable(),
  fulfillAt: timestamp.nullable(),
  fulfillBy: timestamp.nullable(),
  estimatedDeliveryAt: timestamp.nullable(),
  lastProgressAt: timestamp.nullable(),
  /** Last progress, falling back to the source update or read time. */
  progressAt: timestamp,
  delivery: fulfillmentDeliverySchema.nullable(),
  failureCode: z.string().nullable(),
  tracking: z.array(trackingSchema),
  units: z.string(),
  unit: z.string().nullable(),
  order: z.object({
    id: z.string().uuid(),
    number: z.string().nullable(),
    status: z.string().nullable(),
    placedAt: timestamp.nullable(),
  }),
  observedAt: timestamp,
  sourceUpdatedAt: timestamp.nullable(),
});

export const fulfillmentSourceSchema = z.object({
  connectionId: z.string().uuid(),
  label: z.string(),
  system: z.string().nullable(),
  status: z.string(),
  appId: z.string().nullable(),
});

export const fulfillmentQuerySchema = z
  .object({
    q: z.string().trim().max(120).default(''),
    view: fulfillmentViewSchema.default('attention'),
    connectionId: z.string().uuid().optional(),
    locationId: z.string().uuid().optional(),
    kind: z.enum(['fulfillment_order', 'shipment']).optional(),
    sort: fulfillmentSortSchema.default('waiting'),
    cursor: z.string().min(1).max(8192).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(50),
  })
  .strict();

export const fulfillmentListSchema = z.object({
  items: z.array(fulfillmentItemSchema),
  sources: z.array(fulfillmentSourceSchema),
  /** Mapped locations with open work, for filtering. */
  locations: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string().nullable(),
      open: z.number().int().nonnegative(),
    }),
  ),
  counts: z.partialRecord(
    fulfillmentViewSchema,
    z.number().int().nonnegative(),
  ),
  nextCursor: z.string().nullable(),
  /** Open work without reported progress for this long is stalled. */
  stalledAfterHours: z.number().int().positive(),
  asOf: timestamp,
});

export const fulfillmentDetailSchema = z.object({
  item: fulfillmentItemSchema,
  source: fulfillmentSourceSchema,
  lines: z.array(
    z.object({
      orderLineId: z.string().uuid(),
      quantity: z.string(),
      unit: z.string(),
      skuId: z.string().uuid().nullable(),
      skuCode: z.string().nullable(),
      title: z.string().nullable(),
      ordered: z.string().nullable(),
    }),
  ),
  order: z.object({
    id: z.string().uuid(),
    number: z.string().nullable(),
    status: z.string().nullable(),
    paymentStatus: z.string().nullable(),
    placedAt: timestamp.nullable(),
    externalId: z.string().nullable(),
    /** The order-level fulfillment state for this source, as in Orders. */
    fulfillment: z.string().nullable(),
  }),
  /** Up to 50 other fulfillments of the order, from any source, most recent progress first. */
  related: z.array(fulfillmentItemSchema),
  timeline: z.object({
    entries: z.array(
      z.object({
        snapshotId: z.string().uuid(),
        current: z.boolean(),
        deleted: z.boolean(),
        observedAt: timestamp,
        sourceUpdatedAt: timestamp.nullable(),
        status: fulfillmentStatusSchema,
        holds: z.array(fulfillmentHoldReasonSchema).nullable(),
        delivery: fulfillmentDeliverySchema.nullable(),
        lastProgressAt: timestamp.nullable(),
        locationName: z.string().nullable(),
        fulfillBy: timestamp.nullable(),
      }),
    ),
    truncated: z.boolean(),
  }),
  issues: z.array(orderIssueSchema),
  workflows: z.array(
    orderWorkflowRunSchema.extend({
      /** `method_correction` changes a shipping method; it does not prove fulfillment progress. */
      purpose: z.enum(['method_correction', 'other']),
      /** The first later read showing the order shipped or its work completed; null when none. */
      progressObservedAt: timestamp.nullable(),
    }),
  ),
  activity: z.object({
    entries: z.array(orderActivitySchema),
    truncated: z.boolean(),
  }),
  stalledAfterHours: z.number().int().positive(),
  asOf: timestamp,
});

export type FulfillmentView = z.infer<typeof fulfillmentViewSchema>;

export type FulfillmentSignal = z.infer<typeof fulfillmentSignalSchema>;

export type FulfillmentSort = z.infer<typeof fulfillmentSortSchema>;

export type FulfillmentHoldReason = z.infer<typeof fulfillmentHoldReasonSchema>;

export type FulfillmentDelivery = z.infer<typeof fulfillmentDeliverySchema>;

export type FulfillmentItem = z.infer<typeof fulfillmentItemSchema>;

export type FulfillmentSource = z.infer<typeof fulfillmentSourceSchema>;

export type FulfillmentList = z.infer<typeof fulfillmentListSchema>;

export type FulfillmentDetail = z.infer<typeof fulfillmentDetailSchema>;

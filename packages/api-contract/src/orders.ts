import { z } from 'zod';

const timestamp = z.string().datetime();

export const orderStatusSchema = z.enum([
  'open',
  'completed',
  'cancelled',
  'unknown',
]);

export const orderPaymentStatusSchema = z.enum([
  'pending',
  'authorized',
  'paid',
  'partially_refunded',
  'refunded',
  'failed',
  'unknown',
]);

/** Saved slices of the order list. Outstanding, overdue and needs-you use the shared order metric definitions. */
export const orderViewSchema = z.enum([
  'all',
  'outstanding',
  'overdue',
  'needs_you',
  'differs',
]);

export const orderSortSchema = z.enum(['updated', 'placed', 'number', 'due']);

export const orderFulfillmentStateSchema = z.enum([
  'unfulfilled',
  'partial',
  'fulfilled',
  'not_required',
  'no_lines',
]);

export const moneySchema = z.object({
  amount: z.string(),
  currency: z.string(),
});

export const orderSourceSchema = z.object({
  connectionId: z.string().uuid(),
  label: z.string(),
  system: z.string().nullable(),
  connectionStatus: z.string(),
  externalId: z.string().nullable(),
  selected: z.boolean(),
  deleted: z.boolean(),
  observedAt: timestamp,
  sourceUpdatedAt: timestamp.nullable(),
});

export const orderListItemSchema = z.object({
  id: z.string().uuid(),
  displayNumber: z.string().nullable(),
  placedAt: timestamp.nullable(),
  total: moneySchema.nullable(),
  status: orderStatusSchema,
  paymentStatus: orderPaymentStatusSchema,
  fulfillment: orderFulfillmentStateSchema,
  lineCount: z.number().int(),
  open: z.boolean().nullable(),
  overdue: z.boolean().nullable(),
  dueAt: timestamp.nullable(),
  issueIds: z.array(z.string().uuid()),
  differs: z.boolean(),
  sources: z.array(orderSourceSchema),
  observedAt: timestamp,
  sourceUpdatedAt: timestamp.nullable(),
});

export const orderListSchema = z.object({
  items: z.array(orderListItemSchema),
  totalCount: z.number().int(),
  nextCursor: z.string().nullable(),
  asOf: timestamp,
});

export const orderListQuerySchema = z
  .object({
    q: z.string().trim().max(120).default(''),
    view: orderViewSchema.default('all'),
    status: orderStatusSchema.optional(),
    paymentStatus: orderPaymentStatusSchema.optional(),
    connectionId: z.string().uuid().optional(),
    placedFrom: timestamp.optional(),
    placedBefore: timestamp.optional(),
    updatedFrom: timestamp.optional(),
    updatedBefore: timestamp.optional(),
    sort: orderSortSchema.default('updated'),
    direction: z.enum(['asc', 'desc']).default('desc'),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(1024).optional(),
  })
  .strict();

export const orderLineSchema = z.object({
  id: z.string().uuid(),
  skuId: z.string().uuid().nullable(),
  skuCode: z.string().nullable(),
  title: z.string().nullable(),
  quantity: z.string(),
  cancelledQuantity: z.string().nullable(),
  unit: z.string(),
  fulfilledQuantity: z.string(),
  remainingQuantity: z.string().nullable(),
});

export const orderSourceFactsSchema = orderSourceSchema.extend({
  appId: z.string().nullable(),
  mappingMethod: z.string().nullable(),
  displayNumber: z.string().nullable(),
  status: orderStatusSchema,
  paymentStatus: orderPaymentStatusSchema,
  placedAt: timestamp.nullable(),
  total: moneySchema.nullable(),
  dueAt: timestamp.nullable(),
  fulfillment: orderFulfillmentStateSchema,
  open: z.boolean().nullable(),
  lines: z.array(orderLineSchema),
});

export const orderDifferenceSchema = z.object({
  field: z.enum(['status', 'paymentStatus', 'total', 'lines']),
  values: z.array(
    z.object({ connectionId: z.string().uuid(), value: z.string().nullable() }),
  ),
});

export const orderFulfillmentSchema = z.object({
  id: z.string().uuid(),
  connectionId: z.string().uuid(),
  externalId: z.string().nullable(),
  status: z.string(),
  lastProgressAt: timestamp.nullable(),
  failureCode: z.string().nullable(),
  deleted: z.boolean(),
  observedAt: timestamp,
  sourceUpdatedAt: timestamp.nullable(),
  lines: z.array(
    z.object({
      orderLineId: z.string().uuid(),
      quantity: z.string(),
      unit: z.string(),
    }),
  ),
});

export const orderIssueSchema = z.object({
  id: z.string().uuid(),
  class: z.string(),
  state: z.string(),
  severity: z.string().nullable(),
  relationship: z.enum(['order', 'fulfillment', 'sku']),
  needsYou: z.boolean(),
  lastDetectedAt: timestamp.nullable(),
});

export const orderWorkflowRunSchema = z.object({
  id: z.string().uuid(),
  definitionId: z.string(),
  name: z.string().nullable(),
  version: z.string(),
  createdAt: timestamp.nullable(),
  state: z.string(),
  relationship: z.enum(['order', 'issue']),
});

export const orderHistoryEntrySchema = z.object({
  snapshotId: z.string().uuid(),
  entityKind: z.enum(['order', 'fulfillment']),
  entityId: z.string().uuid(),
  connectionId: z.string().uuid(),
  status: z.string(),
  paymentStatus: z.string().nullable(),
  deleted: z.boolean(),
  current: z.boolean(),
  observedAt: timestamp,
  sourceUpdatedAt: timestamp.nullable(),
});

export const orderActivitySchema = z.object({
  id: z.string(),
  recordedAt: timestamp,
  action: z.string(),
  type: z.string(),
  outcome: z.string(),
  actorKind: z.string().nullable(),
  exceptionId: z.string().uuid().nullable(),
  summary: z.string().nullable(),
});

export const orderDetailSchema = z.object({
  order: orderListItemSchema,
  sources: z.array(orderSourceFactsSchema),
  differences: z.array(orderDifferenceSchema),
  fulfillments: z.array(orderFulfillmentSchema),
  issues: z.array(orderIssueSchema),
  workflows: z.array(orderWorkflowRunSchema),
  history: z.object({
    entries: z.array(orderHistoryEntrySchema),
    truncated: z.boolean(),
  }),
  activity: z.object({
    entries: z.array(orderActivitySchema),
    truncated: z.boolean(),
  }),
  asOf: timestamp,
});

export type OrderView = z.infer<typeof orderViewSchema>;

export type OrderSort = z.infer<typeof orderSortSchema>;

export type OrderListQuery = z.infer<typeof orderListQuerySchema>;

export type OrderListItem = z.infer<typeof orderListItemSchema>;

export type OrderList = z.infer<typeof orderListSchema>;

export type OrderDetail = z.infer<typeof orderDetailSchema>;

export type OrderSourceFacts = z.infer<typeof orderSourceFactsSchema>;

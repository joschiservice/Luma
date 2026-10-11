import { z } from 'zod';

import { activityActorSchema } from './activity.js';
import { factAuthoritySchema } from './authority.js';
import { returnListItemSchema } from './returns.js';

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
  comparisonState: z.enum(['matching', 'pending', 'confirmed', 'inconclusive']),
  sources: z.array(orderSourceSchema),
  observedAt: timestamp,
  sourceUpdatedAt: timestamp.nullable(),
});

export const orderListSchema = z.object({
  items: z.array(orderListItemSchema),
  totalCount: z.number().int().nullable(),
  nextCursor: z.string().nullable(),
  asOf: timestamp,
});

export const orderListQuerySchema = z
  .object({
    q: z.string().trim().max(120).default(''),
    count: z
      .literal('exact')
      .optional()
      .describe(
        'Request the exact number of matches. Without this option, totalCount is null.',
      ),
    view: orderViewSchema.default('all'),
    status: orderStatusSchema.optional(),
    paymentStatus: orderPaymentStatusSchema.optional(),
    connectionId: z.string().uuid().optional(),
    customerId: z
      .string()
      .uuid()
      .optional()
      .describe(
        'Imported customer ID: only orders the source attributes to this customer. Requires access to customers.',
      ),
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
  comparisonKey: z.string().uuid().nullable(),
  skuCode: z.string().nullable(),
  title: z.string().nullable(),
  quantity: z
    .string()
    .describe('Originally ordered units, including subsequent reductions.'),
  currentQuantity: z
    .string()
    .nullable()
    .describe(
      'Current units excluding removed and refunded units; null when not reported.',
    ),
  cancelledQuantity: z
    .string()
    .nullable()
    .describe(
      'Reduced units, including removals or refunds when the source reports them; null when unknown.',
    ),
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
  field: z.enum([
    'status',
    'paymentStatus',
    'total',
    'lines',
    'orderedQuantity',
    'currentQuantity',
    'cancelledQuantity',
    'fulfilledQuantity',
    'remainingQuantity',
    'fulfillment',
    'location',
    'overfulfillment',
    'unit',
  ]),
  lineKey: z.string().uuid().nullable(),
  authority: factAuthoritySchema.nullable(),
  values: z.array(
    z.object({
      connectionId: z.string().uuid(),
      value: z.string().nullable(),
      evidence: z.array(
        z.object({
          snapshotId: z.string().uuid(),
          observationId: z.string().uuid(),
          observedAt: timestamp,
        }),
      ),
    }),
  ),
});

export const orderFulfillmentSchema = z.object({
  id: z.string().uuid(),
  connectionId: z.string().uuid(),
  externalId: z.string().nullable(),
  status: z.string(),
  kind: z
    .string()
    .nullable()
    .optional()
    .describe('Shipment or fulfillment work, when reported by the source.'),
  lastProgressAt: timestamp.nullable(),
  failureCode: z.string().nullable(),
  deleted: z.boolean(),
  observedAt: timestamp,
  sourceUpdatedAt: timestamp.nullable(),
  location: z
    .object({
      locationId: z.string().uuid().nullable(),
      name: z.string().nullable(),
    })
    .nullable(),
  tracking: z
    .array(
      z.object({
        carrier: z.string().nullable(),
        number: z.string().nullable(),
        url: z.string().nullable(),
      }),
    )
    .nullable(),
  lines: z.array(
    z.object({
      orderLineId: z.string().uuid(),
      remainingQuantity: z
        .string()
        .nullable()
        .describe(
          'Provider-reported outstanding work; null when not reported.',
        ),
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
  entityKind: z.enum(['order', 'fulfillment', 'return', 'refund']),
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
  actor: activityActorSchema,
  exceptionId: z.string().uuid().nullable(),
  summary: z.string().nullable(),
});

export const orderDetailSchema = z.object({
  redirectedFrom: z.string().uuid().nullable().optional(),
  order: orderListItemSchema,
  sources: z.array(orderSourceFactsSchema),
  differences: z.array(orderDifferenceSchema),
  fulfillments: z.array(orderFulfillmentSchema),
  /** Returns, and refunds without a return, per source; money counts only from successful payments. */
  returns: z.array(returnListItemSchema),
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
  authority: z.object({
    revision: z.number().int().nonnegative(),
    groups: z.array(factAuthoritySchema),
    lines: z
      .object({
        connectionId: z.string().uuid(),
        lines: z.array(
          orderLineSchema.omit({
            fulfilledQuantity: true,
            remainingQuantity: true,
            cancelledQuantity: true,
          }),
        ),
      })
      .nullable(),
    lifecycle: z
      .object({
        connectionId: z.string().uuid(),
        status: orderStatusSchema,
        cancelledQuantities: z.array(
          z.object({
            lineId: z.string().uuid(),
            quantity: z.string().nullable(),
            unit: z.string(),
          }),
        ),
      })
      .nullable(),
    fulfillments: z.array(orderFulfillmentSchema).nullable(),
    tracking: z
      .array(
        z.object({
          fulfillmentId: z.string().uuid(),
          connectionId: z.string().uuid(),
          tracking: orderFulfillmentSchema.shape.tracking,
        }),
      )
      .nullable(),
  }),
});

export type OrderView = z.infer<typeof orderViewSchema>;

export type OrderSort = z.infer<typeof orderSortSchema>;

export type OrderListQuery = z.infer<typeof orderListQuerySchema>;

export type OrderListItem = z.infer<typeof orderListItemSchema>;

export type OrderList = z.infer<typeof orderListSchema>;

export type OrderDetail = z.infer<typeof orderDetailSchema>;

export type OrderSourceFacts = z.infer<typeof orderSourceFactsSchema>;

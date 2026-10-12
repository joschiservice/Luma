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

const orderFulfillmentStateSchema = z.enum([
  'unfulfilled',
  'partial',
  'fulfilled',
  'not_required',
  'no_lines',
]);

const moneySchema = z.object({
  amount: z.string(),
  currency: z.string(),
});

const orderSourceSchema = z.object({
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

const orderListItemSchema = z.object({
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

const moneyPairSchema = z
  .object({
    shop: moneySchema.describe('Amount in the shop currency.'),
    presentment: moneySchema.describe(
      'Amount in the currency the customer was charged in.',
    ),
  })
  .describe('An exact amount in the shop and presentment currencies.');

const orderAmountSchema = z.object({
  original: moneyPairSchema
    .nullable()
    .describe('Amount when the order was placed; null when not reported.'),
  current: moneyPairSchema
    .nullable()
    .describe(
      'Amount after edits, refunds and returns; null when not reported.',
    ),
});

const orderAddressSchema = z.object({
  line1: z.string().nullable(),
  line2: z.string().nullable(),
  city: z.string().nullable(),
  region: z.string().nullable(),
  postalCode: z.string().nullable(),
  country: z.string().nullable(),
});

const orderLineSchema = z.object({
  id: z.string().uuid(),
  skuId: z.string().uuid().nullable(),
  comparisonKey: z.string().uuid().nullable(),
  unitPrice: z
    .object({ amount: z.string(), currency: z.string() })
    .nullable()
    .optional(),
  taxIncluded: z
    .boolean()
    .nullable()
    .optional()
    .describe('Whether the unit price includes tax, as the source states it.'),
  taxRate: z.string().nullable().optional(),
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
  variantTitle: z
    .string()
    .nullable()
    .optional()
    .describe('Variant title at the source; absent when not reported.'),
  prices: z
    .object({
      originalUnit: moneyPairSchema.nullable(),
      discountedUnit: moneyPairSchema
        .nullable()
        .describe('Unit price after line and order discounts.'),
      totalDiscount: moneyPairSchema
        .nullable()
        .describe('Discount on the whole line.'),
    })
    .optional()
    .describe(
      'Source line prices in both currencies; absent when the source does not report them.',
    ),
  requiresShipping: z.boolean().nullable().optional(),
  catalog: z
    .enum(['variant', 'variant_removed', 'no_product'])
    .optional()
    .describe(
      'Whether the line still refers to a catalog variant. `variant_removed`: the variant was deleted but its product remains. `no_product`: a custom item or a deleted product; the source does not say which. Absent when not reported.',
    ),
});

const orderSourceFactsSchema = orderSourceSchema.extend({
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
  currencies: z
    .object({
      shop: z.string().nullable(),
      presentment: z.string().nullable(),
    })
    .optional()
    .describe(
      'The shop currency and the currency the customer was charged in; absent when the source does not report them.',
    ),
  amounts: z
    .object({
      subtotal: orderAmountSchema.describe(
        'Line items after discounts, before shipping and tax.',
      ),
      shipping: orderAmountSchema,
      discounts: orderAmountSchema,
      tax: orderAmountSchema,
      duties: orderAmountSchema,
      total: orderAmountSchema,
    })
    .optional()
    .describe(
      'Order amounts exactly as the source reports them, never recalculated or converted. Absent when the source does not report them.',
    ),
  taxesIncluded: z
    .boolean()
    .nullable()
    .optional()
    .describe('Whether the order prices include tax.'),
  dutiesIncluded: z
    .boolean()
    .nullable()
    .optional()
    .describe('Whether the order prices include duties.'),
  taxLines: z
    .array(
      z.object({
        title: z.string().nullable(),
        rate: z
          .string()
          .nullable()
          .describe('Fractional rate: 0.19 means 19%.'),
        amount: moneyPairSchema.nullable(),
      }),
    )
    .optional()
    .describe('Current tax lines; absent when not reported.'),
  shippingLines: z
    .array(
      z.object({
        id: z.string().nullable(),
        title: z.string().nullable(),
        code: z.string().nullable(),
        source: z.string().nullable(),
        carrier: z.string().nullable(),
        removed: z
          .boolean()
          .nullable()
          .describe('Whether an order edit removed the charge.'),
        original: moneyPairSchema.nullable(),
        discounted: moneyPairSchema.nullable(),
        current: moneyPairSchema.nullable(),
      }),
    )
    .optional()
    .describe(
      'Shipping charges, including removed ones; absent when not reported.',
    ),
  discounts: z
    .array(
      z.object({
        index: z.number().int().nullable(),
        kind: z.enum(['code', 'automatic', 'manual', 'script', 'unknown']),
        label: z
          .string()
          .nullable()
          .describe('Discount code or title. Descriptions are not imported.'),
        target: z.enum(['line_item', 'shipping_line', 'unknown']),
        allocation: z.enum(['across', 'each', 'unknown']),
        value: z
          .discriminatedUnion('type', [
            z.object({
              type: z.literal('percentage'),
              percentage: z.string(),
            }),
            z.object({ type: z.literal('fixed'), amount: moneySchema }),
          ])
          .nullable(),
      }),
    )
    .optional()
    .describe(
      'Discounts applied to the order; absent when not read, for example after a history import.',
    ),
  tags: z
    .array(z.string())
    .optional()
    .describe('Merchant tags; absent when not reported.'),
  attributes: z
    .object({
      edited: z.boolean().nullable(),
      requiresShipping: z.boolean().nullable(),
      test: z.boolean().nullable(),
      cancelReason: z.string().nullable(),
      cancelledAt: timestamp.nullable(),
      closedAt: timestamp.nullable(),
      processedAt: timestamp.nullable(),
      channel: z.string().nullable().describe('Sales channel at the source.'),
      fulfillmentStatus: z
        .string()
        .nullable()
        .describe(
          "The source's own fulfillment status, such as `partially_fulfilled`. Luma's fulfillment state is `fulfillment`.",
        ),
    })
    .optional()
    .describe('Operational facts the source reports about the order.'),
  addresses: z
    .discriminatedUnion('state', [
      z.object({
        state: z.literal('shared'),
        shipping: orderAddressSchema
          .nullable()
          .describe('Null when the order has no delivery address.'),
        billing: orderAddressSchema
          .nullable()
          .describe('Null when the order has no billing address.'),
        observedAt: timestamp,
      }),
      z.object({ state: z.literal('not_shared'), observedAt: timestamp }),
      z.object({ state: z.literal('not_imported') }),
    ])
    .optional()
    .describe(
      'Delivery and billing addresses. `not_shared`: this deployment is not approved to read addresses. `not_imported`: no read has recorded them. Absent without permission to read customers; `hidden` then lists `addresses`.',
    ),
  lines: z.array(orderLineSchema),
});

const orderDifferenceSchema = z.object({
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

const orderFulfillmentSchema = z.object({
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
  /**
   * How many resolved issues of this class about the same record this row stands for; the row
   * is the latest of them. Open issues are always listed individually with 1.
   */
  occurrences: z.number().int().positive(),
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

const orderHistoryEntrySchema = z.object({
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
  /**
   * Ordered SKUs whose stock differs between sources while Luma waits for provider sync to
   * close the gap; an issue is raised for a gap still open at `until`.
   */
  stockSync: z.array(
    z.object({
      skuId: z.string().uuid(),
      since: timestamp,
      until: timestamp,
    }),
  ),
  workflows: z.array(orderWorkflowRunSchema),
  history: z.object({
    entries: z.array(orderHistoryEntrySchema),
    truncated: z.boolean(),
  }),
  activity: z.object({
    entries: z.array(orderActivitySchema),
    truncated: z.boolean(),
  }),
  hidden: z
    .array(
      z.enum([
        'fulfillments',
        'returns',
        'issues',
        'workflows',
        'activity',
        'addresses',
      ]),
    )
    .describe(
      "Sections left out because the reader can't read their area. Treat them as unavailable, not as empty.",
    ),
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

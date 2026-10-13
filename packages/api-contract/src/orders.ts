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
  'stuck',
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
    locationId: z
      .string()
      .uuid()
      .optional()
      .describe(
        'Canonical fulfillment warehouse. Requires fulfillment access.',
      ),
    stockBlocked: z
      .union([
        z.literal(true),
        z.literal('true').transform(() => true as const),
      ])
      .optional()
      .describe(
        'Open orders with an explicit source inventory-out-of-stock hold observed within five minutes. Missing or stale holds remain unknown. Requires inventory and fulfillment access.',
      ),
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
  bundleGroup: z
    .object({
      id: z.object({ externalId: z.string(), scopeKey: z.string() }),
      title: z.string(),
      quantity: z.string(),
      product: z
        .object({ externalId: z.string(), scopeKey: z.string() })
        .nullable(),
      variant: z
        .object({ externalId: z.string(), scopeKey: z.string() })
        .nullable(),
      skuCode: z.string().nullable(),
    })
    .nullable()
    .optional()
    .describe(
      'Merchandising group of this component. It is not an additional stock or fulfillment line. Omitted means unread; null means standalone.',
    ),
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

const journeyStageSchema = z.enum([
  'placed',
  'paid',
  'reserved',
  'picked',
  'shipped',
  'delivered',
  'returned',
]);
const journeySchema = z.object({
  timings: z.array(
    z.object({
      partId: z.string(),
      orderLineId: z.uuid().nullable(),
      connectionId: z.uuid().nullable(),
      from: journeyStageSchema,
      to: journeyStageSchema,
      durationMs: z.number().nonnegative().nullable(),
    }),
  ),
  events: z.array(
    z.object({
      id: z.string(),
      orderId: z.uuid(),
      partId: z.string(),
      orderLineId: z.uuid().nullable(),
      stage: journeyStageSchema,
      provenance: z.enum(['provider_observation', 'luma_action', 'inference']),
      connectionId: z.uuid().nullable(),
      actorId: z.string().nullable(),
      occurredAt: timestamp.nullable(),
      observedAt: timestamp,
      quantity: z.string().nullable(),
      unit: z.string().nullable(),
      references: z.array(
        z.object({
          kind: z.enum([
            'order',
            'order_line',
            'shipment',
            'return',
            'invoice',
            'reservation',
            'snapshot',
            'observation',
            'activity',
          ]),
          id: z.string(),
          connectionId: z.uuid().nullable(),
        }),
      ),
    }),
  ),
  truncated: z.boolean(),
  candidates: z.array(
    z.object({
      code: z.enum(['paid_without_reservation', 'shipped_without_reservation']),
      orderLineId: z.uuid(),
      connectionId: z.uuid(),
      observedSince: timestamp,
    }),
  ),
  comparisons: z.array(
    z.object({
      from: journeyStageSchema,
      to: journeyStageSchema,
      count: z.number().int().nonnegative(),
      medianMs: z.number().nullable(),
      p90Ms: z.number().nullable(),
    }),
  ),
});

export const orderDetailSchema = z.object({
  journey: journeySchema.optional(),
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

const orderChangeKindSchema = z.enum([
  'quantity',
  'item',
  'address',
  'location',
  'cancellation',
]);

const decimalQuantity = z
  .string()
  .regex(/^\d{1,14}(\.\d{1,6})?$/, 'Use a nonnegative decimal quantity.');

/**
 * A proposed change to plan. Without `kind`, the plan covers the differences source comparison
 * detected. `quantity` needs `lineKey` and `quantity`; `item` (removing a line) needs `lineKey`;
 * `location` may name a line; `cancellation` and `address` concern the whole order.
 */
export const orderChangePlanQuerySchema = z
  .object({
    kind: orderChangeKindSchema
      .optional()
      .describe('The change to plan; omit to plan detected differences.'),
    lineKey: z
      .string()
      .uuid()
      .optional()
      .describe(
        'The line’s comparison key: its shared line ID or its mapped SKU, as `comparisonKey` in order detail.',
      ),
    quantity: decimalQuantity
      .optional()
      .describe('The intended current units of the line.'),
  })
  .strict()
  .superRefine((value, issues) => {
    const lineKey = ['quantity', 'item'].includes(value.kind ?? '');
    const forbidden = (field: 'lineKey' | 'quantity') =>
      issues.addIssue({
        code: 'custom',
        path: [field],
        message: `Remove ${field} for this change.`,
      });
    if (lineKey && !value.lineKey)
      issues.addIssue({
        code: 'custom',
        path: ['lineKey'],
        message: 'Choose the line to change.',
      });
    if (value.kind === 'quantity' && value.quantity === undefined)
      issues.addIssue({
        code: 'custom',
        path: ['quantity'],
        message: 'Enter the intended quantity.',
      });
    if (value.kind !== 'quantity' && value.quantity !== undefined)
      forbidden('quantity');
    if (value.lineKey && !lineKey && value.kind !== 'location')
      forbidden('lineKey');
  });

const planReasonSchema = z.object({
  code: z
    .enum([
      'work_started',
      'shipped',
      'fulfilled_beyond_target',
      'cancelled',
      'closed',
      'stale_evidence',
      'incomplete_evidence',
      'ambiguous_line',
      'unknown_progress',
      'unknown_value',
      'authority_unknown',
      'authority_conflict',
      'no_fulfilment_source',
      'fulfilment_hidden',
    ])
    .describe(
      'Why the change is unsafe (work_started, shipped, fulfilled_beyond_target, cancelled, closed) or unknown (every other code).',
    ),
  connectionId: z.string().uuid().nullable(),
  lineKey: z.string().uuid().nullable(),
});

const planStepSchema = z.object({
  id: z.string(),
  kind: z.enum([
    'confirm',
    'request_hold',
    'reassign_work',
    'update_record',
    'notify',
    'escalate',
  ]),
  action: z.enum([
    'check_progress',
    'confirm_picking',
    'stop_work',
    'hold_for_address',
    'stop_and_reassign',
    'return_or_refund',
    'update_quantity',
    'cancel_order',
    'update_address',
    'reassign_location',
    'carrier_redirect',
    'notify_added_units',
    'notify_customer',
    'escalate_unsafe',
    'escalate_unknown',
  ]),
  performer: z
    .enum(['luma', 'person'])
    .describe(
      'Luma steps run a governed capability through approval and execution; person steps are for the named role.',
    ),
  role: z.enum(['warehouse', 'carrier', 'finance', 'operator']).nullable(),
  connectionId: z.string().uuid().nullable(),
  capability: z.string().nullable(),
  executable: z
    .boolean()
    .describe(
      'Whether Luma could run this step now. It still needs a preview, approval and fresh verification.',
    ),
  blockedBy: z
    .enum([
      'not_granted',
      'unavailable',
      'authority',
      'unmapped',
      'whole_units',
      'observe_only',
      'unsafe',
      'unknown',
    ])
    .nullable(),
  permission: z
    .string()
    .nullable()
    .describe('The permission a person needs to request this Luma step.'),
  viewerCanRequest: z.boolean().describe('Whether you hold `permission`.'),
  handoff: z
    .object({
      orderExternalId: z.string(),
      lines: z.array(
        z.object({ externalId: z.string(), quantity: decimalQuantity }),
      ),
    })
    .nullable()
    .describe('Source references for the provider action, when mapped.'),
});

const orderChangePlanSchema = z.object({
  change: z.object({
    kind: orderChangeKindSchema,
    origin: z.enum(['detected', 'proposed']),
    lineKey: z.string().uuid().nullable(),
    line: z
      .object({ skuCode: z.string().nullable(), title: z.string().nullable() })
      .nullable(),
    from: z.string().nullable(),
    to: z
      .string()
      .nullable()
      .describe(
        'The intended value; null when no authoritative source reports it.',
      ),
    unit: z.string().nullable(),
  }),
  acknowledgements: z.array(
    z.object({
      connectionId: z.string().uuid(),
      state: z.enum(['reflects', 'differs', 'unknown']),
      value: z.string().nullable(),
      readAt: timestamp,
      fresh: z.boolean(),
    }),
  ),
  shipped: z
    .array(
      z.object({
        lineKey: z.string().uuid(),
        units: z.string().nullable(),
        unit: z.string().nullable(),
        basis: z.enum(['authority', 'maximum', 'unknown']),
        connectionId: z.string().uuid().nullable(),
        sources: z.array(
          z.object({ connectionId: z.string().uuid(), units: z.string() }),
        ),
      }),
    )
    .describe(
      'Shipped units counted once: summed within one source, never across mirrored sources.',
    ),
  safety: z.object({
    state: z.enum(['safe', 'unsafe', 'unknown']),
    reasons: z.array(planReasonSchema),
  }),
  steps: z.array(planStepSchema),
});

export const orderChangePlansSchema = z.object({
  orderId: z.string().uuid(),
  comparisonState: z.enum(['matching', 'pending', 'confirmed', 'inconclusive']),
  plans: z.array(orderChangePlanSchema).max(20),
  hidden: z
    .array(z.literal('fulfillments'))
    .describe(
      'Fulfilment facts you can’t read; plans then report safety as unknown.',
    ),
  asOf: timestamp,
});

export type OrderChangePlanQuery = z.infer<typeof orderChangePlanQuerySchema>;

export type OrderChangePlan = z.infer<typeof orderChangePlanSchema>;

export type OrderChangePlans = z.infer<typeof orderChangePlansSchema>;

export type OrderView = z.infer<typeof orderViewSchema>;

export type OrderSort = z.infer<typeof orderSortSchema>;

export type OrderListQuery = z.infer<typeof orderListQuerySchema>;

export type OrderListItem = z.infer<typeof orderListItemSchema>;

export type OrderList = z.infer<typeof orderListSchema>;

export type OrderDetail = z.infer<typeof orderDetailSchema>;

export type OrderSourceFacts = z.infer<typeof orderSourceFactsSchema>;

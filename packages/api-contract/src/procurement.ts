import { z } from 'zod';

import {
  collectionGroupKeyParameter,
  collectionGroupLimitParameter,
  collectionGroupParameter,
  collectionGroupSchema,
  collectionTimeZoneParameter,
  collectionWhereParameter,
} from './collections.js';
import { stockPositionSchema } from './inventory.js';
import { purchasingTimelineSchema } from './purchasing-timeline.js';

const text = z.string().trim().min(1).max(200);

const externalReferenceSchema = z
  .object({
    system: text,
    externalId: text,
    connectionId: z.string().uuid().optional(),
  })
  .strict();
const externalReferences = z.array(externalReferenceSchema).max(20).default([]);

export const supplierInputSchema = z
  .object({
    id: z.string().uuid(),
    name: text,
    externalReferences,
    email: z.string().email().max(254).optional(),
    language: z.enum(['en', 'de']).optional(),
  })
  .strict();

const supplierLinkSchema = z
  .object({
    connectionId: z.string().uuid(),
    externalId: z.string().min(1).max(200),
    scopeKey: z.string().max(1024),
    name: z.string().nullable(),
    linkedBy: z.string(),
    linkedAt: z.string().datetime(),
  })
  .strict();

export const supplierSchema = supplierInputSchema.extend({
  tenantId: z.string().uuid(),
  createdAt: z.string().datetime(),
  revision: z.number().int().min(1).optional(),
  link: supplierLinkSchema.nullable().optional(),
  confirmationHours: z.number().int().min(1).optional(),
});

const purchaseOrderStatusSchema = z.enum([
  'draft',
  'open',
  'closed',
  'cancelled',
]);

export const purchaseOrderInputSchema = z
  .object({
    id: z.string().uuid(),
    supplierId: z.string().uuid(),
    reference: text,
    authority: z.enum(['luma', 'external']).default('luma'),
    externalReferences,
    origin: z
      .object({
        workflowRunId: z.string().uuid().optional(),
        actionId: text.optional(),
        outcomeId: text.optional(),
        sourcePurchaseOrderId: z.string().uuid().optional(),
        sourceAttentionKey: z.string().min(1).max(400).optional(),
      })
      .strict()
      .default({}),
    lines: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            sku: text,
            description: text,
            quantity: z.number().finite().positive().max(1_000_000_000),
            unitPrice: z
              .object({
                amount: z
                  .string()
                  .regex(/^\d+(?:\.\d{1,8})?$/)
                  .max(30),
                currency: z.string().regex(/^[A-Z]{3}$/),
              })
              .strict()
              .optional(),
            locationId: z.string().uuid().optional(),
            supplierArticleNumber: z.string().trim().min(1).max(256).optional(),
            requestedDeliveryDate: z.string().date().optional(),
            unit: z.string().trim().min(1).max(40),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

export const transitionInputSchema = z
  .object({
    id: z.string().uuid(),
    expectedRevision: z.number().int().min(1),
    status: purchaseOrderStatusSchema,
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();

export const purchaseOrderSchema = purchaseOrderInputSchema.extend({
  tenantId: z.string().uuid(),
  supplierName: text,
  status: purchaseOrderStatusSchema,
  revision: z.number().int().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type SupplierInput = z.input<typeof supplierInputSchema>;

export type Supplier = z.output<typeof supplierSchema>;

export type PurchaseOrderInput = z.input<typeof purchaseOrderInputSchema>;

export type PurchaseOrder = z.output<typeof purchaseOrderSchema>;

export type TransitionInput = z.output<typeof transitionInputSchema>;

export type PurchaseOrderStatus = PurchaseOrder['status'];

const procurementEventSchema = z.object({
  id: z.string().uuid(),
  commandId: z.string().uuid().optional(),
  occurredAt: z.string().datetime(),
  actorId: z.string(),
  from: purchaseOrderStatusSchema.nullable(),
  to: purchaseOrderStatusSchema,
  revision: z.number().int(),
  reason: z.string(),
});

export const purchaseOrderDetailSchema = z.object({
  order: purchaseOrderSchema,
  history: z.array(procurementEventSchema),
  allowedTransitions: z.array(purchaseOrderStatusSchema),
  canManage: z.boolean(),
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const externalIdSchema = z.object({
  externalId: z.string(),
  scopeKey: z.string(),
});

export const supplierLinkInputSchema = z
  .object({
    expectedRevision: z.number().int().min(1),
    link: z
      .object({
        connectionId: z.string().uuid(),
        externalId: text,
        scopeKey: z.string().max(1024),
      })
      .strict()
      .nullable(),
    confirmationHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 30),
  })
  .strict();

export const purchasingConnectionSchema = z.object({
  id: z.string().uuid(),
  label: z.string(),
  provider: z.string().nullable(),
  status: z.string(),
  canSubmit: z.boolean(),
  canReadOrders: z.boolean(),
  canListSuppliers: z.boolean(),
});

export const purchasingSupplierSchema = z.object({
  externalId: z.string(),
  scopeKey: z.string(),
  name: z.string().nullable(),
  number: z.string().nullable(),
  active: z.boolean().nullable(),
  email: z.string().nullable(),
});

const submissionStateSchema = z.enum([
  'not_executed',
  'approval_required',
  'approved',
  'rejected',
  'expired',
  'submitting',
  'uncertain',
  'submitted',
  'failed',
]);

const submissionSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  purchaseOrderId: z.string().uuid(),
  channel: z.enum(['purchasing_system', 'email']).optional(),
  outgoing: z
    .object({
      outboundId: z.string().uuid(),
      threadId: z.string().uuid(),
      sentMessageId: z.string().nullable(),
    })
    .optional(),
  connectionId: z.string().uuid(),
  supplier: externalIdSchema,
  requestedDeliveryDate: isoDate,
  lines: z.array(
    z.object({
      lineId: z.string().uuid(),
      sku: externalIdSchema,
      quantity: z.number(),
      unit: z.string(),
    }),
  ),
  actionId: z.string().uuid(),
  decisionId: z.string().uuid().nullable(),
  requestedBy: z.string(),
  requestedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  state: submissionStateSchema,
  externalOrder: z
    .object({ externalId: z.string(), orderNumber: z.string().nullable() })
    .nullable(),
  submittedAt: z.string().datetime().nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().datetime().nullable(),
  failure: z.string().nullable(),
  updatedAt: z.string().datetime(),
});

export const submissionViewSchema = submissionSchema.extend({
  observeOnly: z.boolean().optional(),
  approvalOutcome: z.enum(['approved', 'rejected']).nullable(),
  canApprove: z.boolean(),
  canSend: z.boolean(),
  canCheck: z.boolean(),
  message: z.string(),
});

const commitmentKindSchema = z.enum([
  'confirmed_quantity',
  'promised_date',
  'shipped',
  'received',
  'condition',
  'shortage',
  'damaged',
]);

export const commitmentSchema = z.object({
  orderRevision: z.number().int().positive().optional(),
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  purchaseOrderId: z.string().uuid(),
  lineId: z.string().uuid().nullable(),
  kind: commitmentKindSchema,
  quantity: z.number().nullable(),
  date: isoDate.nullable(),
  text: z.string().nullable(),
  source: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('purchasing_system'),
      connectionId: z.string().uuid(),
      observationId: z.string().uuid(),
      observedAt: z.string().datetime(),
      externalOrderId: z.string(),
    }),
    z.object({
      kind: z.literal('communication'),
      communicationId: z.string().uuid(),
      span: z.object({ start: z.number().int(), end: z.number().int() }),
      extraction: z
        .object({ id: z.string(), factId: z.string(), model: z.string() })
        .nullable(),
    }),
    z.object({ kind: z.literal('correction'), reason: z.string() }),
    z.object({
      kind: z.literal('manual_receipt'),
      receivedAt: z.string().datetime({ offset: true }),
      condition: z.enum(['good', 'mixed', 'damaged']),
      reason: z.string(),
      evidence: z.array(z.string()),
    }),
  ]),
  status: z.enum(['confirmed', 'needs_review', 'rejected']),
  reviewReasons: z.array(
    z.enum([
      'low_confidence',
      'quantity_changed',
      'date_later',
      'unmatched_line',
      'supplier_condition',
    ]),
  ),
  supersedes: z.string().uuid().nullable(),
  recordedAt: z.string().datetime(),
  recordedBy: z.object({ kind: z.enum(['user', 'luma']), id: z.string() }),
  review: z
    .object({
      outcome: z.enum(['confirmed', 'rejected']),
      by: z.string(),
      at: z.string().datetime(),
    })
    .nullable(),
});

export const communicationSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  supplierId: z.string().uuid(),
  purchaseOrderId: z.string().uuid().nullable(),
  channel: z.enum(['email', 'portal', 'phone', 'other']),
  from: z.string(),
  subject: z.string().nullable(),
  body: z.string().nullable(),
  receivedAt: z.string().datetime({ offset: true }),
  messageId: z.string().nullable(),
  digest: z.string(),
  capturedBy: z.string(),
  capturedAt: z.string().datetime(),
  retainUntil: z.string().datetime(),
  purgedAt: z.string().optional(),
  purgeReason: z.enum(['retention', 'request']).optional(),
});

export const extractionSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  communicationId: z.string().uuid(),
  attempt: z.number().int(),
  state: z.enum(['completed', 'unavailable', 'failed']),
  relatesToOrder: z.boolean().nullable(),
  commitmentIds: z.array(z.string().uuid()),
  discarded: z.number().int(),
  model: z.string().nullable(),
  reason: z.string().nullable(),
  createdAt: z.string().datetime(),
  createdBy: z.string(),
});

export const followUpSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  purchaseOrderId: z.string().uuid(),
  key: z.string(),
  response: z.enum(['accepted', 'following_up', 'credited', 'written_off']),
  note: z.string(),
  nextCheckAt: z.string().datetime({ offset: true }).nullable(),
  respondedBy: z.string(),
  respondedAt: z.string().datetime(),
});

const purchasingObservationSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  purchaseOrderId: z.string().uuid(),
  submissionId: z.string().uuid(),
  connectionId: z.string().uuid(),
  externalId: z.string(),
  observedAt: z.string().datetime(),
  digest: z.string(),
  status: z.string(),
  orderNumber: z.string().nullable(),
  confirmed: z.boolean().nullable(),
  lines: z.array(
    z.object({
      lineId: z.string().uuid().nullable(),
      externalLineId: z.string(),
      quantity: z.string(),
      deliveredQuantity: z.string().nullable(),
      confirmedQuantity: z.string().nullable(),
      confirmedDeliveryDate: z.string().nullable(),
      confirmed: z.boolean().nullable(),
    }),
  ),
});

export const orderStageSchema = z.enum([
  'draft',
  'awaiting_approval',
  'sending',
  'send_failed',
  'awaiting_confirmation',
  'confirmed',
  'changed',
  'partially_received',
  'received',
  'closed',
  'cancelled',
]);

const attentionSchema = z.object({
  key: z.string(),
  kind: z.enum([
    'submission_approval',
    'submission_uncertain',
    'submission_failed',
    'review_commitment',
    'commitment_changed',
    'confirmation_overdue',
    'delivery_overdue',
    'receipt_difference',
  ]),
  lineId: z.string().uuid().nullable(),
  commitmentId: z.string().uuid().nullable(),
  submissionId: z.string().uuid().nullable(),
  dueAt: z.string(),
  summary: z.string(),
});

const nextOwnerSchema = z.enum([
  'buyer',
  'approver',
  'supplier',
  'warehouse',
  'luma',
  'none',
]);

const orderProgressSchema = z.object({
  milestones: z.array(
    z.object({
      key: z.enum(['drafted', 'submitted', 'confirmed', 'received']),
      state: z.enum([
        'complete',
        'partial',
        'in_progress',
        'attention',
        'pending',
        'not_started',
        'stopped',
      ]),
      at: z.string().nullable(),
      evidence: z.string(),
    }),
  ),
  lines: z.array(
    z.object({
      lineId: z.string().uuid(),
      sku: z.string(),
      description: z.string(),
      unit: z.string(),
      ordered: z.number(),
      confirmed: z.number().nullable(),
      confirmedSource: z
        .enum([
          'purchasing_system',
          'communication',
          'correction',
          'manual_receipt',
        ])
        .nullable(),
      promisedDate: isoDate.nullable(),
      requestedDate: isoDate.nullable(),
      expectedDate: isoDate.nullable(),
      received: z.number(),
      receivedObservedAt: z.string().nullable(),
      outstanding: z.number(),
      shippedDate: isoDate.nullable(),
      shipped: z.number().nullable(),
      damaged: z.number(),
      shortage: z.number(),
      goodReceived: z.number(),
      orderedDifference: z.number().nullable(),
      shippedDifference: z.number().nullable(),
      receivedDifference: z.number().nullable(),
      stage: z.enum([
        'not_submitted',
        'awaiting_confirmation',
        'confirmed',
        'changed',
        'partially_received',
        'received',
        'cancelled',
      ]),
      overdue: z.boolean(),
    }),
  ),
  expectedDate: isoDate.nullable(),
  confirmationDueAt: z.string().nullable(),
  attention: z.array(attentionSchema),
  next: z.object({
    owner: nextOwnerSchema,
    title: z.string(),
    detail: z.string(),
  }),
});

export const purchaseOrderRecordSchema = z.object({
  timeline: purchasingTimelineSchema,
  order: purchaseOrderSchema,
  supplier: supplierSchema.nullable(),
  history: z.array(procurementEventSchema),
  submission: submissionViewSchema.nullable(),
  submissions: z.array(submissionSchema),
  commitments: z.array(commitmentSchema),
  followUps: z.array(followUpSchema),
  communications: z.array(communicationSchema),
  extractions: z.array(extractionSchema),
  observations: z.array(purchasingObservationSchema),
  readiness: z.object({
    ready: z.boolean(),
    blockers: z.array(z.string()),
    connection: z.object({ id: z.string(), label: z.string() }).nullable(),
    lines: z.array(
      z.object({ lineId: z.string(), sku: z.string(), mapped: z.boolean() }),
    ),
  }),
  progress: orderProgressSchema,
  stage: orderStageSchema,
  draftVerified: z.boolean(),
  canManage: z.boolean(),
  reconciliation: z.object({
    available: z.boolean(),
    decisions: z.boolean(),
    manualReceipt: z.boolean(),
  }),
  extraction: z.object({
    available: z.boolean(),
    reason: z.string().nullable(),
  }),
});

export const orderSummarySchema = z.object({
  id: z.string().uuid(),
  stage: orderStageSchema,
  expectedDate: isoDate.nullable(),
  attention: z.number().int(),
  attentionKinds: z
    .array(attentionSchema.shape.kind)
    .optional()
    .describe(
      'Kinds of the open items counted in `attention`, each once. A pending send approval shows in the stage instead.',
    ),
  overdue: z.boolean(),
  nextOwner: nextOwnerSchema,
  externalOrderNumber: z.string().nullable(),
  confirmationDueAt: z
    .string()
    .datetime()
    .nullable()
    .optional()
    .describe(
      'When the supplier should confirm a sent order; null before it is sent.',
    ),
  nextCheckAt: z
    .string()
    .datetime()
    .nullable()
    .optional()
    .describe(
      'Earliest check time recorded for an item someone is following up. A past time means the item needs attention again.',
    ),
  value: z
    .union([
      z.object({ amount: z.string(), currency: z.string() }),
      z.literal('unknown'),
    ])
    .nullable()
    .optional()
    .describe(
      'Sum of quantity × unit price over every line. Null when no line has a price; `unknown` when only some lines have one or prices use different currencies.',
    ),
});

const listCursor = z.string().min(1).max(1024).optional();

const listCount = z
  .literal('exact')
  .optional()
  .describe(
    'Request the exact number of matches. Without this option, totalCount is null.',
  );

export const purchaseOrderSortSchema = z.enum([
  'created',
  'updated',
  'expected',
  'reference',
  'supplier',
  'confirmationDue',
  'nextCheck',
  'value',
]);

/** Native supplier list sorts; `custom:<field ID>` sorts are accepted beside them. */
export const supplierSortSchema = z.enum(['name', 'created', 'orders']);

export const purchaseOrderListQuerySchema = z
  .object({
    q: z
      .string()
      .trim()
      .max(200)
      .default('')
      .describe(
        'Matches the reference, supplier name or a line SKU, ignoring case.',
      ),
    stage: z
      .union([orderStageSchema, z.literal('attention')])
      .optional()
      .describe(
        'Orders in this stage, or `attention`: orders with at least one item that needs an answer beyond a pending send approval.',
      ),
    supplierId: z.string().uuid().optional(),
    status: purchaseOrderStatusSchema.optional(),
    where: collectionWhereParameter.optional(),
    group: collectionGroupParameter.optional(),
    groupKey: collectionGroupKeyParameter.optional(),
    groupLimit: collectionGroupLimitParameter,
    timeZone: collectionTimeZoneParameter,
    sort: z
      .union([
        purchaseOrderSortSchema,
        z.templateLiteral(['custom:', z.uuid()]),
      ])
      .default('created')
      .describe(
        '`expected` is the earliest expected date of outstanding units, `confirmationDue` when the supplier should confirm, `nextCheck` the earliest follow-up check and `value` the order value: by currency code, then amount, both in the sort direction, so amounts are only ranked within their currency. `custom:<field ID>` sorts by a readable custom purchase-order field that holds one value. Orders without a value come last in both directions.',
      ),
    direction: z
      .enum(['asc', 'desc'])
      .optional()
      .describe(
        'Defaults to descending for `created` and `updated`, ascending for every other sort.',
      ),
    limit: z.coerce.number().int().min(1).max(50).default(50),
    count: listCount,
    cursor: listCursor,
  })
  .strict();

export const purchaseOrderListSchema = z.object({
  items: z.array(
    purchaseOrderSchema.extend({
      summary: orderSummarySchema.describe(
        'Stage, expected date and attention, evaluated at `asOf`.',
      ),
    }),
  ),
  canManage: z.boolean(),
  totalCount: z.number().int().nonnegative().nullable(),
  counts: z
    .object({
      all: z.number().int().nonnegative(),
      attention: z.number().int().nonnegative(),
      stages: z.partialRecord(orderStageSchema, z.number().int().nonnegative()),
    })
    .nullable()
    .describe(
      'Orders in the workspace, needing attention and per stage. Returned with the first page of an unfiltered list only; null otherwise.',
    ),
  nextCursor: z.string().nullable(),
  groups: z
    .array(collectionGroupSchema)
    .optional()
    .describe(
      'With `group`: each group in display order with its exact count, first rows (whose items are in `items`) and per-currency value sums. With `groupKey`: the one group, with this page of its rows.',
    ),
  groupsTruncated: z
    .boolean()
    .optional()
    .describe(
      'More than 50 groups match; narrow the conditions to see the rest.',
    ),
  asOf: z.string().datetime(),
});

export const supplierListQuerySchema = z
  .object({
    q: z
      .string()
      .trim()
      .max(200)
      .default('')
      .describe(
        'Matches the name or an external reference system or ID, ignoring case.',
      ),
    where: collectionWhereParameter.optional(),
    timeZone: collectionTimeZoneParameter,
    sort: z
      .union([supplierSortSchema, z.templateLiteral(['custom:', z.uuid()])])
      .default('name')
      .describe(
        '`orders` is the number of purchase orders of the supplier. `custom:<field ID>` sorts by a readable custom supplier field that holds one value; suppliers without a value come last in both directions.',
      ),
    direction: z
      .enum(['asc', 'desc'])
      .optional()
      .describe('Defaults to ascending for `name`, descending otherwise.'),
    limit: z.coerce.number().int().min(1).max(50).default(50),
    count: listCount,
    cursor: listCursor,
  })
  .strict();

export const supplierListSchema = z.object({
  items: z.array(
    supplierSchema.extend({ orderCount: z.number().int().nonnegative() }),
  ),
  canManage: z.boolean(),
  totalCount: z.number().int().nonnegative().nullable(),
  nextCursor: z.string().nullable(),
});

export const supplierRecordSchema = z.object({
  supplier: supplierSchema,
  connection: purchasingConnectionSchema.nullable(),
  confirmationHours: z.number().int(),
  canManage: z.boolean(),
  communications: z.array(communicationSchema),
  orders: z.array(
    z.object({
      order: purchaseOrderSchema,
      stage: orderStageSchema,
      progress: orderProgressSchema,
      externalOrderNumber: z.string().nullable(),
    }),
  ),
});

export const submissionInputSchema = z
  .object({ id: z.string().uuid(), requestedDeliveryDate: isoDate })
  .strict();

export const submissionDecisionSchema = z
  .object({
    decisionId: z.string().uuid(),
    outcome: z.enum(['approved', 'rejected']),
  })
  .strict();

export const messageInputSchema = z
  .object({
    id: z.string().uuid(),
    channel: z.enum(['email', 'portal', 'phone', 'other']).default('email'),
    from: z.string().trim().min(1).max(320),
    subject: z.string().trim().max(500).default(''),
    body: z.string().trim().min(1).max(20_000),
    receivedAt: z.string().datetime({ offset: true }),
    messageId: z.string().trim().min(1).max(250).nullable().default(null),
  })
  .strict();

export const commitmentInputSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.enum([
      'confirmed_quantity',
      'promised_date',
      'shipped',
      'condition',
    ]),
    lineId: z.string().uuid().nullable().default(null),
    quantity: z
      .number()
      .finite()
      .min(0)
      .max(1_000_000_000)
      .nullable()
      .default(null),
    date: isoDate.nullable().default(null),
    text: z.string().trim().max(300).nullable().default(null),
    communicationId: z.string().uuid().nullable().default(null),
    span: z
      .object({ start: z.number().int().min(0), end: z.number().int().min(1) })
      .strict()
      .nullable()
      .default(null),
    supersedes: z.string().uuid().nullable().default(null),
    reason: z.string().trim().max(500).nullable().default(null),
  })
  .strict();

export const reviewInputSchema = z
  .object({
    outcome: z.enum(['confirmed', 'rejected']),
    acceptChange: z.boolean().default(false),
  })
  .strict();

export const followUpInputSchema = z
  .object({
    id: z.string().uuid(),
    key: z.string().min(1).max(400),
    response: z.enum(['accepted', 'following_up', 'credited', 'written_off']),
    note: z.string().trim().min(1).max(1000),
    nextCheckAt: z.string().datetime({ offset: true }).nullable().default(null),
    expectedOrderRevision: z.number().int().nonnegative().optional(),
    expectedScopeFingerprint: z.string().min(1).max(1_000_000).optional(),
  })
  .strict();

export type SupplierLinkInput = z.input<typeof supplierLinkInputSchema>;

export type Commitment = z.infer<typeof commitmentSchema>;

export type Communication = z.infer<typeof communicationSchema>;

export type OrderProgress = z.infer<typeof orderProgressSchema>;

export type OrderStage = z.infer<typeof orderStageSchema>;

export type PurchaseOrderRecord = z.infer<typeof purchaseOrderRecordSchema>;

export type PurchaseOrderListQuery = z.input<
  typeof purchaseOrderListQuerySchema
>;

export type PurchaseOrderList = z.infer<typeof purchaseOrderListSchema>;

export type SupplierListQuery = z.input<typeof supplierListQuerySchema>;

export type SupplierList = z.infer<typeof supplierListSchema>;

export type SupplierRecord = z.infer<typeof supplierRecordSchema>;

export type MessageInput = z.input<typeof messageInputSchema>;

export type CommitmentInput = z.input<typeof commitmentInputSchema>;

export type FollowUpInput = z.input<typeof followUpInputSchema>;

const relatedIssueSchema = z.object({
  id: z.string().uuid(),
  label: z.string(),
  state: z.string(),
});

const skuContextSchema = z.object({
  sku: z.string(),
  skuId: z.string().uuid().nullable(),
  title: z.string().nullable(),
  positions: z.array(stockPositionSchema),
  otherOrders: z.array(
    z.object({
      id: z.string().uuid(),
      label: z.string(),
      status: z.string(),
      quantity: z.number(),
      unit: z.string(),
    }),
  ),
});

export const purchaseOrderContextSchema = z.object({
  lines: z.array(skuContextSchema.extend({ lineId: z.string().uuid() })),
  issues: z.array(relatedIssueSchema),
  replenishment: z
    .object({
      runId: z.string().uuid(),
      definitionId: z.string(),
      startedAt: z.string(),
      positionId: z.string().uuid().nullable(),
      location: z.string().nullable(),
      minimum: z.number().nullable(),
      target: z.number().nullable(),
      stock: z.object({
        available: z.number().nullable(),
        unit: z.string().nullable(),
        checkedAt: z.string().nullable(),
      }),
      proposedQuantity: z.number().nullable(),
      approval: z.enum([
        'approved',
        'rejected',
        'pending',
        'not_required',
        'unknown',
      ]),
      approvedAt: z.string().nullable(),
      verification: z.enum([
        'verified',
        'failed',
        'inconclusive',
        'not_verified',
      ]),
      verifiedAt: z.string().nullable(),
    })
    .nullable(),
  truncated: z.boolean(),
  asOf: z.string().datetime(),
});

export const supplierContextSchema = z.object({
  skus: z.array(
    skuContextSchema.extend({
      onOrder: z.array(z.object({ quantity: z.number(), unit: z.string() })),
    }),
  ),
  issues: z.array(relatedIssueSchema),
  truncated: z.boolean(),
  asOf: z.string().datetime(),
});

export type PurchaseOrderContext = z.infer<typeof purchaseOrderContextSchema>;

export type SupplierContext = z.infer<typeof supplierContextSchema>;

export type Attention = z.infer<typeof attentionSchema>;

/** Records cumulative receipt or difference quantities; retries reuse the same command ID. */
export const receiptInputSchema = z
  .object({
    id: z.string().uuid(),
    lineId: z.string().uuid(),
    kind: z.enum(['received', 'shortage', 'damaged']),
    quantity: z.number().finite().min(0).max(1_000_000_000),
    expectedCommitmentId: z.string().uuid().nullable(),
    expectedDamagedCommitmentId: z.string().uuid().nullable().optional(),
    damagedQuantity: z.number().finite().min(0).max(1_000_000_000).optional(),
    receivedAt: z.string().datetime({ offset: true }),
    condition: z.enum(['good', 'mixed', 'damaged']),
    reason: z.string().trim().min(1).max(1000),
    evidence: z.array(z.string().trim().min(1).max(2000)).min(1).max(20),
  })
  .strict();

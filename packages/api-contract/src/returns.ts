import { z } from 'zod';

const timestamp = z.string().datetime({ offset: true });

const moneySchema = z.object({ amount: z.string(), currency: z.string() });

export const returnStageSchema = z.enum([
  'requested',
  'awaiting_items',
  'awaiting_refund',
  'refund_pending',
  'refund_failed',
  'ready_to_close',
  'closed',
  'declined',
  'cancelled',
  'refunded',
  'refund_recorded',
  'unknown',
]);

export const returnViewSchema = z.enum(['action', 'waiting', 'done', 'all']);

const refundStateSchema = z.enum([
  'none',
  'recorded',
  'pending',
  'failed',
  'partial',
  'refunded',
]);

const returnStatusSchema = z.enum([
  'requested',
  'open',
  'closed',
  'declined',
  'cancelled',
  'unknown',
]);

export const returnListItemSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['return', 'refund']),
  connectionId: z.string().uuid(),
  externalId: z.string().nullable(),
  name: z.string().nullable(),
  order: z.object({
    id: z.string().uuid(),
    displayNumber: z.string().nullable(),
  }),
  status: returnStatusSchema.nullable(),
  stage: returnStageSchema,
  group: returnViewSchema.exclude(['all']),
  refund: z.object({
    state: refundStateSchema,
    currency: z.string().nullable(),
    refunded: z.string().nullable(),
    pending: z.string().nullable(),
    failedAttempts: z.number().int().nonnegative(),
  }),
  quantity: z.string().nullable(),
  received: z.string().nullable(),
  refundedUnits: z.string().nullable(),
  value: moneySchema.nullable(),
  reasons: z.array(z.string()),
  requestedAt: timestamp.nullable(),
  activityAt: timestamp,
  observedAt: timestamp,
  sourceUpdatedAt: timestamp.nullable(),
  deleted: z.boolean(),
});

const returnSourceSchema = z.object({
  connectionId: z.string().uuid(),
  label: z.string(),
  system: z.string().nullable(),
  appId: z.string().nullable(),
  status: z.string(),
  access: z.enum(['granted', 'not_granted', 'not_requested']),
  records: z.number().int().nonnegative(),
  importing: z.boolean(),
  fullReadAt: timestamp.nullable(),
  lastReadAt: timestamp.nullable(),
  failing: z.boolean(),
});

export const returnQuerySchema = z
  .object({
    q: z.string().trim().max(120).default(''),
    view: returnViewSchema.default('all'),
    stage: returnStageSchema.optional(),
    connectionId: z.string().uuid().optional(),
    sort: z.enum(['requested', 'activity']).default('requested'),
    direction: z.enum(['asc', 'desc']).default('desc'),
    cursor: z.string().min(1).max(4096).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(50),
  })
  .strict();

export const returnListSchema = z.object({
  items: z.array(returnListItemSchema),
  sources: z.array(returnSourceSchema),
  counts: z.object({
    views: z.partialRecord(returnViewSchema, z.number().int().nonnegative()),
    stages: z.partialRecord(returnStageSchema, z.number().int().nonnegative()),
  }),
  nextCursor: z.string().nullable(),
  asOf: timestamp,
});

const transactionSchema = z.object({
  status: z.enum(['success', 'pending', 'failed', 'unknown']),
  amount: moneySchema,
  processedAt: timestamp.nullable(),
  gateway: z.string().nullable(),
});

export const returnDetailSchema = z.object({
  item: returnListItemSchema,
  source: returnSourceSchema.nullable(),
  order: z
    .object({
      id: z.string().uuid(),
      displayNumber: z.string().nullable(),
      externalId: z.string().nullable(),
      status: z.string(),
      paymentStatus: z.string(),
      placedAt: timestamp.nullable(),
      total: moneySchema.nullable(),
    })
    .nullable(),
  lines: z.array(
    z.object({
      orderLineId: z.string().uuid().nullable(),
      title: z.string().nullable(),
      skuId: z.string().uuid().nullable(),
      skuCode: z.string().nullable(),
      quantity: z.string(),
      unit: z.string(),
      reason: z.string().nullable(),
      received: z.string().nullable(),
      restocked: z.string().nullable(),
      refunded: z.string().nullable(),
      value: moneySchema.nullable(),
    }),
  ),
  timeline: z.object({
    requestedAt: timestamp.nullable(),
    approvedAt: timestamp.nullable(),
    receivedAt: timestamp.nullable(),
    closedAt: timestamp.nullable(),
    declineReason: z
      .enum(['return_period_ended', 'final_sale', 'other'])
      .nullable(),
  }),
  refunds: z.array(
    z.object({
      id: z.string().uuid(),
      externalId: z.string().nullable(),
      createdAt: timestamp.nullable(),
      total: moneySchema.nullable(),
      lines: z.array(
        z.object({
          orderLineId: z.string().uuid(),
          title: z.string().nullable(),
          quantity: z.string(),
          unit: z.string(),
          restock: z.enum(['return', 'cancel', 'no_restock', 'unknown']),
          restocked: z.boolean(),
        }),
      ),
      transactions: z.array(transactionSchema),
      observedAt: timestamp,
      sourceUpdatedAt: timestamp.nullable(),
    }),
  ),
  related: z.array(returnListItemSchema),
  history: z.object({
    entries: z.array(
      z.object({
        snapshotId: z.string().uuid(),
        entityKind: z.enum(['return', 'refund']),
        entityId: z.string().uuid(),
        status: z.string().nullable(),
        current: z.boolean(),
        deleted: z.boolean(),
        observedAt: timestamp,
        sourceUpdatedAt: timestamp.nullable(),
      }),
    ),
    truncated: z.boolean(),
  }),
  asOf: timestamp,
});

export type ReturnStage = z.infer<typeof returnStageSchema>;

export type ReturnView = z.infer<typeof returnViewSchema>;

export type RefundState = z.infer<typeof refundStateSchema>;

export type ReturnListItem = z.infer<typeof returnListItemSchema>;

export type ReturnSource = z.infer<typeof returnSourceSchema>;

export type ReturnList = z.infer<typeof returnListSchema>;

export type ReturnDetail = z.infer<typeof returnDetailSchema>;

import { z } from 'zod';

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

export const supplierOutputSchema = supplierInputSchema.extend({
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

export const purchaseOrderOutputSchema = purchaseOrderInputSchema.extend({
  tenantId: z.string().uuid(),
  supplierName: text,
  status: purchaseOrderStatusSchema,
  revision: z.number().int().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => !Number.isNaN(Date.parse(v)));

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

export const submissionInputSchema = z
  .object({ id: z.string().uuid(), requestedDeliveryDate: date })
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
    date: date.nullable().default(null),
    text: z.string().trim().max(300).nullable().default(null),
    communicationId: z.string().uuid().nullable().default(null),
    span: z
      .object({
        start: z.number().int().min(0),
        end: z.number().int().min(1),
      })
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
  })
  .strict();

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

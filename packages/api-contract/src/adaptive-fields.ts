import { z } from 'zod';

export const adaptiveRecordTypeSchema = z.enum([
  'order',
  'product',
  'supplier',
  'purchase_order',
]);

export const customFieldTypeSchema = z.enum([
  'text',
  'number',
  'date',
  'boolean',
  'single_choice',
  'multi_choice',
  'person',
]);

export const customFieldValueSchema = z.union([
  z.string().max(4000),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(120)).max(100),
  z.null(),
]);
const label = z
  .object({
    en: z.string().trim().min(1).max(100),
    de: z.string().trim().min(1).max(100),
  })
  .strict();

export const customFieldInputSchema = z
  .object({
    recordType: adaptiveRecordTypeSchema,
    key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    label,
    type: customFieldTypeSchema,
    choices: z
      .array(
        z
          .object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), label })
          .strict(),
      )
      .max(100)
      .default([]),
    readPermission: z.string().max(120).default('adaptive.fields.read'),
    writePermission: z.string().max(120).default('adaptive.fields.write'),
  })
  .strict();

export const customFieldSchema = customFieldInputSchema.extend({
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  archived: z.boolean(),
  source: z.enum(['luma', 'provider']),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const customFieldRecordValueSchema = z.object({
  fieldId: z.string().uuid(),
  value: customFieldValueSchema,
  revision: z.number().int().positive(),
  updatedAt: z.string().datetime(),
  updatedBy: z.string().uuid(),
});

export const customFieldRecordSchema = z.object({
  fields: z.array(customFieldSchema),
  values: z.array(customFieldRecordValueSchema),
});

const customFieldFilterSchema = z
  .object({
    fieldId: z.string().uuid(),
    operator: z.enum([
      'eq',
      'ne',
      'gt',
      'gte',
      'lt',
      'lte',
      'contains',
      'is_empty',
    ]),
    value: customFieldValueSchema.optional(),
  })
  .strict();

export const customFieldQuerySchema = z
  .object({
    recordType: adaptiveRecordTypeSchema,
    filters: z.array(customFieldFilterSchema).max(20).default([]),
    sort: z
      .object({
        fieldId: z.string().uuid(),
        direction: z.enum(['asc', 'desc']),
      })
      .strict()
      .optional(),
    groupBy: z.string().uuid().optional(),
    offset: z.number().int().min(0).max(100000).default(0),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();

export const customFieldQueryResultSchema = z.object({
  recordIds: z.array(z.string().uuid()),
  groups: z.array(
    z.object({
      value: customFieldValueSchema,
      count: z.number().int().nonnegative(),
    }),
  ),
  hasMore: z.boolean(),
});

export type AdaptiveRecordType = z.infer<typeof adaptiveRecordTypeSchema>;

export type CustomFieldInput = z.infer<typeof customFieldInputSchema>;

export type CustomField = z.infer<typeof customFieldSchema>;

export type CustomFieldValue = z.infer<typeof customFieldValueSchema>;

export type CustomFieldRecord = z.infer<typeof customFieldRecordSchema>;

export const fieldWorkflowReviewSchema = z.object({
  runId: z.string().uuid(),
  stepId: z.string(),
  definitionId: z.string(),
  field: customFieldSchema,
  recordType: adaptiveRecordTypeSchema,
  recordId: z.string().uuid(),
  beforeValue: customFieldValueSchema,
  proposedValue: customFieldValueSchema,
  revision: z.number().int().nonnegative(),
  currentRevision: z.number().int().nonnegative(),
  fieldRevision: z.number().int().positive(),
  currentFieldRevision: z.number().int().positive(),
  decisionId: z.string().uuid().nullable(),
  actionHash: z.string(),
  requesterId: z.string().uuid(),
  requestedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  canRespond: z.boolean(),
  requireIndependentApproval: z.boolean(),
  stale: z.boolean(),
  status: z.enum([
    'approval_required',
    'approved',
    'rejected',
    'succeeded',
    'unavailable',
  ]),
  risk: z.literal('medium'),
});

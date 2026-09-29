import { z } from 'zod';

export const recordKindSchema = z.enum([
  'order',
  'fulfillment',
  'position',
  'sku',
  'product',
  'issue',
]);

export const recordLinkSchema = z.object({
  kind: recordKindSchema,
  id: z.string().uuid(),
  label: z.string(),
  relationship: z.string(),
});

export const recordSourceSchema = z.object({
  connectionId: z.string().uuid(),
  label: z.string(),
  status: z.string(),
  externalId: z.string().nullable(),
  mappingMethod: z.string().nullable(),
  observedAt: z.string().datetime().nullable(),
  sourceUpdatedAt: z.string().datetime().nullable(),
});

export const recordSummarySchema = z.object({
  kind: recordKindSchema,
  id: z.string().uuid(),
  label: z.string(),
  description: z.string(),
  status: z.string(),
  coverage: z.enum(['projected', 'identity_only']),
  sources: z.array(recordSourceSchema),
  observedAt: z.string().datetime().nullable(),
  sourceUpdatedAt: z.string().datetime().nullable(),
});

export const recordListSchema = z.object({
  items: z.array(recordSummarySchema),
  /** Continues the same search on the next page; null on the last page. */
  nextCursor: z.string().nullable(),
  coverage: z.object({
    customer: z.literal('unavailable'),
    return: z.literal('unavailable'),
  }),
});

export const recordDetailSchema = z.object({
  record: recordSummarySchema,
  links: z.array(recordLinkSchema),
  snapshots: z.array(
    z.object({
      connectionId: z.string().uuid(),
      observedAt: z.string().datetime(),
      sourceUpdatedAt: z.string().datetime().nullable(),
      data: z.record(z.string(), z.unknown()),
    }),
  ),
});

export const recordQuerySchema = z
  .object({
    q: z.string().trim().max(120).default(''),
    kind: recordKindSchema.optional(),
    connectionId: z.string().uuid().optional(),
    cursor: z.string().min(1).max(1024).optional(),
  })
  .strict();

export type RecordKind = z.infer<typeof recordKindSchema>;

export type RecordSummary = z.infer<typeof recordSummarySchema>;

export type RecordDetail = z.infer<typeof recordDetailSchema>;

import { z } from 'zod';

export const metricIdSchema = z.enum([
  'orders.open',
  'orders.overdue',
  'orders.attention',
]);
const timestamp = z.string().datetime({ offset: true });

export const metricScopeSchema = z
  .object({
    connectionId: z.string().uuid().optional(),
    updatedFrom: timestamp.optional(),
    updatedBefore: timestamp.optional(),
  })
  .strict();

export const metricRequestSchema = z
  .object({
    definitionVersion: z.literal(1).default(1),
    scope: metricScopeSchema.default({}),
    limit: z.number().int().min(1).max(100).default(20),
    cursor: z
      .string()
      .min(1)
      .max(2048)
      .optional()
      .describe(
        'A metric’s nextCursor. That metric lists the records after the previous page, read from current data; the other metrics return their first page.',
      ),
  })
  .strict()
  .refine(
    (v) =>
      !v.scope.updatedFrom ||
      !v.scope.updatedBefore ||
      Date.parse(v.scope.updatedFrom) < Date.parse(v.scope.updatedBefore),
    'The reporting window must end after it starts.',
  );

export const metricDefinitionSchema = z.object({
  id: metricIdSchema,
  title: z.string(),
  description: z.string(),
  predicate: z.string(),
  timeSemantics: z.string(),
  version: z.literal(1),
  unit: z.literal('canonical_order'),
  dimensions: z.array(z.literal('connectionId')),
  filters: z.array(z.enum(['connectionId', 'updatedFrom', 'updatedBefore'])),
  permissions: z.literal('workspace_member'),
  drillDown: z.literal('orders.cohort'),
});

export const metricResponseSchema = z.object({
  nextRefreshAt: timestamp
    .nullable()
    .optional()
    .describe(
      'Next deadline or freshness boundary. Refresh current metrics at this time, even if no change event arrives.',
    ),
  definitionVersion: z.literal(1),
  scope: metricScopeSchema,
  asOf: timestamp,
  readAt: timestamp,
  timezone: z.literal('UTC'),
  observedAt: timestamp.nullable(),
  dataThrough: timestamp.nullable(),
  freshness: z.enum(['fresh', 'stale', 'unobserved']),
  coverage: z.enum(['partial', 'unavailable']),
  coverageExplanation: z.string(),
  limit: z.number(),
  metrics: z.array(
    z.object({
      definition: metricDefinitionSchema,
      total: z.number().int().nonnegative().nullable(),
      observedCount: z.number().int().nonnegative(),
      unknownCount: z.number().int().nonnegative(),
      offset: z
        .number()
        .int()
        .nonnegative()
        .describe(
          'Records paged past before this page. It labels the page; records may have changed since earlier pages.',
        ),
      nextCursor: z
        .string()
        .nullable()
        .describe(
          'Pass as cursor to read the records after this page. Null when no more records match.',
        ),
      items: z.array(
        z.object({
          id: z.string().uuid(),
          displayNumber: z.string().nullable(),
          connectionId: z.string().uuid(),
          dueAt: timestamp.nullable(),
          observedAt: timestamp,
          sourceUpdatedAt: timestamp.nullable(),
          open: z.boolean().nullable(),
          overdue: z.boolean().nullable(),
          attention: z.boolean(),
          issueIds: z.array(z.string().uuid()),
        }),
      ),
    }),
  ),
});

export type MetricRequest = z.input<typeof metricRequestSchema>;

export type MetricResponse = z.infer<typeof metricResponseSchema>;

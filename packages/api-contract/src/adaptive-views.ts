import { z } from 'zod';

export const adaptiveViewDomainSchema = z.enum([
  'orders',
  'inventory',
  'fulfillment',
  'customers',
  'products',
  'procurement',
  'issues',
  'decisions',
]);
const scalar = z.union([
  z.string().max(2000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const field = z.string().min(1).max(120);

const adaptiveViewActionSchema = z
  .object({
    id: z.string().uuid(),
    label: z
      .object({
        en: z.string().trim().min(1).max(80),
        de: z.string().trim().min(1).max(80),
      })
      .strict(),
    target: z
      .object({
        kind: z.enum(['capability', 'workflow']),
        id: z.string().min(1).max(200),
        version: z.string().max(100).optional(),
      })
      .strict(),
    inputs: z
      .record(
        z.string().min(1).max(100),
        z.discriminatedUnion('source', [
          z.object({ source: z.literal('row'), field }).strict(),
          z.object({ source: z.literal('literal'), value: scalar }).strict(),
        ]),
      )
      .refine((values) => Object.keys(values).length <= 50),
  })
  .strict();

/** Versioned query descriptions keep live records in their owning domains. */
export const adaptiveViewQuerySchema = z
  .object({
    version: z.literal(1),
    domain: adaptiveViewDomainSchema,
    filters: z
      .record(z.string().min(1).max(100), scalar)
      .refine((values) => Object.keys(values).length <= 30)
      .default({}),
    customFilters: z
      .array(
        z
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
            value: scalar,
          })
          .strict(),
      )
      .max(20)
      .default([]),
    columns: z.array(field).min(1).max(30),
    sort: z
      .object({ field, direction: z.enum(['asc', 'desc']) })
      .strict()
      .nullable()
      .default(null),
    groupBy: field.nullable().default(null),
    layout: z.enum(['table', 'board']).default('table'),
    metrics: z
      .array(
        z
          .object({
            id: field,
            operation: z.enum(['count', 'sum', 'average']),
            field: field.nullable().default(null),
          })
          .strict(),
      )
      .max(8)
      .default([]),
    charts: z
      .array(
        z
          .object({
            id: field,
            type: z.enum(['bar', 'line']),
            groupBy: field,
            metricId: field,
          })
          .strict(),
      )
      .max(4)
      .default([]),
    actions: z.array(adaptiveViewActionSchema).max(8).default([]),
  })
  .strict()
  .superRefine((query, context) => {
    if (new Set(query.columns).size !== query.columns.length)
      context.addIssue({
        code: 'custom',
        message: 'Columns must be unique',
        path: ['columns'],
      });
    if (
      query.metrics.some(
        (metric) => metric.operation !== 'count' && metric.field === null,
      )
    )
      context.addIssue({
        code: 'custom',
        message: 'Numeric metrics require a field',
        path: ['metrics'],
      });
    if (
      new Set(query.actions.map((action) => action.id)).size !==
      query.actions.length
    )
      context.addIssue({
        code: 'custom',
        message: 'Action identities must be unique',
        path: ['actions'],
      });
    if (
      new Set(query.charts.map((chart) => chart.id)).size !==
      query.charts.length
    )
      context.addIssue({
        code: 'custom',
        message: 'Chart identities must be unique',
        path: ['charts'],
      });
    if (query.layout === 'board' && !query.groupBy)
      context.addIssue({
        code: 'custom',
        message: 'Board layout requires grouping',
        path: ['groupBy'],
      });
    if (
      new Set(query.metrics.map((metric) => metric.id)).size !==
      query.metrics.length
    )
      context.addIssue({
        code: 'custom',
        message: 'Metrics must have unique identities',
        path: ['metrics'],
      });
    for (const chart of query.charts)
      if (!query.metrics.some((metric) => metric.id === chart.metricId))
        context.addIssue({
          code: 'custom',
          message: 'Chart metric must belong to this query',
          path: ['charts'],
        });
  });

const adaptiveViewSharingSchema = z
  .object({
    scope: z.enum(['private', 'workspace', 'roles']),
    roleIds: z.array(z.string().min(1).max(100)).max(50).default([]),
  })
  .strict()
  .superRefine((sharing, context) => {
    if ((sharing.scope === 'roles') !== sharing.roleIds.length > 0)
      context.addIssue({
        code: 'custom',
        message:
          'Role sharing requires roles; other scopes cannot contain roles',
        path: ['roleIds'],
      });
  });

export const adaptiveViewInputSchema = z
  .object({
    commandId: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).default(''),
    sharing: adaptiveViewSharingSchema,
    query: adaptiveViewQuerySchema,
    reviewed: z.literal(true),
  })
  .strict();

export const adaptiveViewSchema = adaptiveViewInputSchema
  .omit({ reviewed: true, commandId: true })
  .extend({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    ownerId: z.string().uuid(),
    revision: z.number().int().positive(),
    archived: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    canEdit: z.boolean(),
  });

export const adaptiveViewRevisionSchema = adaptiveViewSchema
  .omit({ canEdit: true })
  .extend({ changedBy: z.string().uuid() });

export const builtInAdaptiveViewSchema = z.object({
  id: z.enum(['stuck-orders', 'inventory-discrepancies', 'supplier-decisions']),
  name: z.object({ en: z.string(), de: z.string() }),
  query: adaptiveViewQuerySchema,
});

export const adaptiveViewPreviewSchema = z.object({
  items: z.array(z.record(z.string(), z.unknown())).max(100),
  nextCursor: z.string().nullable(),
  asOf: z.string().datetime({ offset: true }),
  totalCount: z.number().int().nonnegative().nullable(),
  warnings: z.array(z.string().max(1000)).max(50),
  availableColumns: z.array(field),
  groups: z
    .array(
      z.object({ key: z.unknown(), count: z.number().int().nonnegative() }),
    )
    .max(100)
    .default([]),
  chartSeries: z
    .array(
      z.object({
        id: field,
        points: z
          .array(
            z.object({
              key: z.unknown(),
              value: z.number().nullable(),
              count: z.number().int().nonnegative(),
            }),
          )
          .max(100),
        truncated: z.boolean(),
        complete: z.boolean(),
      }),
    )
    .max(4)
    .default([]),
  aggregates: z
    .array(
      z.object({
        metricId: field,
        value: z.number().nullable(),
        complete: z.boolean(),
      }),
    )
    .default([]),
});

export const adaptiveViewDraftSchema = z.object({
  status: z.enum([
    'ready',
    'needs_clarification',
    'unsupported',
    'unavailable',
  ]),
  query: adaptiveViewQuerySchema.nullable(),
  explanation: z.string().max(2000),
  warnings: z.array(z.string().max(1000)).max(20),
  preview: adaptiveViewPreviewSchema.nullable(),
});

export type AdaptiveViewDomain = z.infer<typeof adaptiveViewDomainSchema>;

export type AdaptiveViewQuery = z.infer<typeof adaptiveViewQuerySchema>;

export type AdaptiveViewInput = z.infer<typeof adaptiveViewInputSchema>;

export type AdaptiveView = z.infer<typeof adaptiveViewSchema>;

export type AdaptiveViewPreview = z.infer<typeof adaptiveViewPreviewSchema>;

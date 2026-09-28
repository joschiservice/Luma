import { z } from 'zod';

export const operationalMetricIdSchema = z.enum([
  'cases.active',
  'cases.attention',
  'cases.oldest_unresolved_age',
  'inventory.below_minimum',
  'inventory.replenishment_unknown',
  'procurement.purchase_orders.draft',
  'procurement.purchase_orders.open',
  'connections.needing_attention',
]);
const timestamp = z.string().datetime({ offset: true });

export const operationalMetricDefinitionSchema = z.object({
  id: operationalMetricIdSchema,
  title: z.string(),
  description: z.string(),
  version: z.literal(2),
  family: z.enum(['cases', 'inventory', 'procurement', 'connections']),
  unit: z.enum([
    'case',
    'second',
    'stock_position',
    'purchase_order',
    'connection',
  ]),
  filters: z.array(z.enum(['connectionId', 'supplierId', 'authority'])),
  timeSemantics: z.string(),
  permissions: z.literal('workspace_member'),
});

export const operationalMetricScopeSchema = z
  .object({
    connectionId: z.string().uuid().optional(),
    supplierId: z.string().uuid().optional(),
    authority: z.enum(['luma', 'external']).optional(),
  })
  .strict();

export const operationalMetricRequestSchema = z
  .object({
    definitionVersion: z.literal(2),
    metrics: z.array(operationalMetricIdSchema).min(1).max(8),
    scope: operationalMetricScopeSchema.default({}),
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).max(10000).default(0),
    asOf: timestamp.optional(),
    snapshot: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
  .refine(
    (v) => new Set(v.metrics).size === v.metrics.length,
    'Choose each metric once.',
  )
  .refine(
    (v) =>
      (!v.snapshot && !v.asOf && v.offset === 0) || (!!v.snapshot && !!v.asOf),
    'Pagination requires the snapshot and evaluation time.',
  )
  .refine(
    (v) =>
      Object.keys(v.scope).every((key) =>
        v.metrics.every((id) =>
          key === 'connectionId'
            ? id.startsWith('inventory.') || id.startsWith('connections.')
            : id.startsWith('procurement.'),
        ),
      ),
    'The selected metrics do not support these filters.',
  );

export const operationalMetricItemSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('case'),
    id: z.string().uuid(),
    subjectKind: z.string(),
    subjectId: z.string(),
    state: z.string(),
    title: z.string(),
    detectedAt: z.string().nullable(),
    ageSeconds: z.number().nonnegative().nullable(),
    reason: z
      .enum(['approval', 'manual_intervention', 'uncertainty'])
      .nullable(),
  }),
  z.object({
    kind: z.literal('stock_position'),
    id: z.string().uuid(),
    ruleId: z.string().uuid(),
    connectionId: z.string().uuid(),
    sku: z.string(),
    minimum: z.number(),
    available: z.number().nullable(),
    unit: z.string().nullable(),
    observedAt: z.string().nullable(),
    reason: z
      .enum([
        'missing',
        'deleted',
        'nonnumeric',
        'future',
        'expired',
        'invalid_time',
      ])
      .nullable(),
    commitmentIds: z.array(z.string().uuid()),
  }),
  z.object({
    kind: z.literal('purchase_order'),
    id: z.string().uuid(),
    reference: z.string(),
    supplierId: z.string().uuid(),
    supplierName: z.string(),
    authority: z.enum(['luma', 'external']),
    status: z.enum(['draft', 'open']),
    createdAt: timestamp,
    ageSeconds: z.number().nullable(),
  }),
  z.object({
    kind: z.literal('connection'),
    id: z.string().uuid(),
    label: z.string(),
    status: z.enum([
      'pending',
      'active',
      'degraded',
      'revoked',
      'disconnected',
    ]),
    lastObservedAt: timestamp.nullable(),
    freshness: z.enum(['fresh', 'stale', 'unobserved']),
    nextRefreshAt: timestamp.nullable().optional(),
    reasons: z.array(z.string()),
  }),
]);

export const operationalMetricResponseSchema = z.object({
  definitionVersion: z.literal(2),
  scope: operationalMetricScopeSchema,
  asOf: timestamp,
  readAt: timestamp,
  snapshot: z.string(),
  timezone: z.literal('UTC'),
  nextRefreshAt: timestamp.nullable(),
  limit: z.number(),
  offset: z.number(),
  metrics: z.array(
    z.object({
      definition: operationalMetricDefinitionSchema,
      value: z.number().nonnegative().nullable(),
      total: z.number().nonnegative().nullable(),
      observedCount: z.number().int().nonnegative(),
      unknownCount: z.number().int().nonnegative(),
      population: z.number().int().nonnegative(),
      coverage: z.enum(['complete', 'partial', 'unavailable']),
      coverageExplanation: z.string(),
      freshness: z.enum(['fresh', 'stale', 'unobserved']),
      observedAt: z.string().nullable(),
      dataThrough: timestamp.nullable(),
      nextRefreshAt: timestamp.nullable(),
      breakdown: z.array(
        z.object({ reason: z.string(), count: z.number().int().nonnegative() }),
      ),
      items: z.array(operationalMetricItemSchema),
    }),
  ),
});

export type OperationalMetricRequest = z.input<
  typeof operationalMetricRequestSchema
>;

export type OperationalMetricResponse = z.infer<
  typeof operationalMetricResponseSchema
>;

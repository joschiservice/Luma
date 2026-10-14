import { z } from 'zod';

import { connectionHealthSchema } from './connections.js';
import {
  measurementEnvironmentSchema,
  resolutionMetricItemSchema,
} from './measurement.js';

const operationalMetricIdSchema = z.enum([
  'cases.active',
  'cases.attention',
  'cases.oldest_unresolved_age',
  'inventory.below_minimum',
  'inventory.replenishment_unknown',
  'procurement.purchase_orders.draft',
  'procurement.purchase_orders.open',
  'connections.needing_attention',
  'resolution.unknown_eligibility',
  'resolution.eligible',
  'resolution.verified',
  'resolution.autonomous',
  'resolution.human',
  'resolution.unknown',
  'resolution.pending',
  'resolution.recurrent',
  'resolution.incorrect_actions',
  'resolution.time_to_outcome',
  'resolution.unresolved_age',
  'resolution.detected',
  'resolution.completed',
  'resolution.completion_time',
]);
const timestamp = z.string().datetime({ offset: true });

export const operationalMetricDefinitionSchema = z.object({
  id: operationalMetricIdSchema,
  title: z.string(),
  description: z.string(),
  version: z.literal(2),
  family: z.enum([
    'cases',
    'inventory',
    'procurement',
    'connections',
    'resolution',
  ]),
  unit: z.enum([
    'case',
    'second',
    'stock_position',
    'purchase_order',
    'connection',
  ]),
  filters: z.array(
    z.enum([
      'connectionId',
      'supplierId',
      'authority',
      'environment',
      'window',
      'start',
      'end',
      'issueClass',
      'artifactId',
      'artifactVersion',
    ]),
  ),
  timeSemantics: z.string(),
  permissions: z.literal('workspace_member'),
});

const operationalMetricScopeSchema = z
  .object({
    connectionId: z.string().uuid().optional(),
    supplierId: z.string().uuid().optional(),
    authority: z.enum(['luma', 'external']).optional(),
    environment: measurementEnvironmentSchema.optional(),
    window: z.enum(['24h', '7d', '30d']).optional(),
    start: z.string().datetime({ offset: true }).optional(),
    end: z.string().datetime({ offset: true }).optional(),
    issueClass: z.string().min(1).max(100).optional(),
    artifactId: z.string().min(1).max(200).optional(),
    artifactVersion: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine(
    (scope) =>
      (scope.artifactId === undefined) ===
      (scope.artifactVersion === undefined),
    'Provide both workflow identity and version.',
  )
  .refine(
    (scope) => (scope.start === undefined) === (scope.end === undefined),
    'Provide both reporting bounds.',
  )
  .refine(
    (scope) =>
      !scope.start ||
      !scope.end ||
      (Date.parse(scope.end) > Date.parse(scope.start) &&
        Date.parse(scope.end) - Date.parse(scope.start) <= 366 * 86400000),
    'Use a reporting interval of up to 366 days.',
  );

export const operationalMetricRequestSchema = z
  .object({
    definitionVersion: z.literal(2),
    metrics: z.array(operationalMetricIdSchema).min(1).max(19),
    scope: operationalMetricScopeSchema.default({}),
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
    (v) => new Set(v.metrics).size === v.metrics.length,
    'Choose each metric once.',
  )
  .refine(
    (v) =>
      Object.keys(v.scope).every((key) =>
        v.metrics.every((id) =>
          [
            'environment',
            'window',
            'start',
            'end',
            'issueClass',
            'artifactId',
            'artifactVersion',
          ].includes(key)
            ? id.startsWith('resolution.')
            : key === 'connectionId'
              ? id.startsWith('inventory.') ||
                id.startsWith('connections.') ||
                id.startsWith('resolution.')
              : id.startsWith('procurement.'),
        ),
      ),
    'The selected metrics do not support these filters.',
  );

const operationalMetricItemSchema = z.discriminatedUnion('kind', [
  resolutionMetricItemSchema,
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
    health: connectionHealthSchema.optional(),
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
  timezone: z.literal('UTC'),
  nextRefreshAt: timestamp.nullable(),
  limit: z.number(),
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

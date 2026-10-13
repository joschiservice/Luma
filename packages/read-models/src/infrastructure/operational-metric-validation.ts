import { z } from 'zod';

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

const operationalMetricScopeSchema = z
  .object({
    connectionId: z.string().uuid().optional(),
    supplierId: z.string().uuid().optional(),
    authority: z.enum(['luma', 'external']).optional(),
    environment: z
      .enum(['live', 'pilot', 'synthetic', 'shadow', 'observe_only', 'unknown'])
      .optional(),
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
    cursor: z.string().max(2048).optional(),
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

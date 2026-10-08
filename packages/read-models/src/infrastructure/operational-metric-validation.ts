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
]);

export const operationalMetricScopeSchema = z
  .object({
    connectionId: z.string().uuid().optional(),
    supplierId: z.string().uuid().optional(),
    authority: z.enum(['luma', 'external']).optional(),
    environment: z
      .enum(['live', 'pilot', 'synthetic', 'shadow', 'unknown'])
      .optional(),
    window: z.enum(['24h', '7d']).optional(),
  })
  .strict();

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
          key === 'environment' || key === 'window'
            ? id.startsWith('resolution.')
            : key === 'connectionId'
              ? id.startsWith('inventory.') || id.startsWith('connections.')
              : id.startsWith('procurement.'),
        ),
      ),
    'The selected metrics do not support these filters.',
  );

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

import { z } from 'zod';
import { caseSummarySchema } from './cases.js';
export const overviewQuerySchema = z
  .object({
    window: z.enum(['24h', '7d']).default('24h'),
  })
  .strict();
const count = z.number().int().nonnegative();
export const operationsOverviewSchema = z.object({
  generatedAt: z.string().datetime(),
  window: z.object({
    start: z.string().datetime(),
    end: z.string().datetime(),
  }),
  freshnessThresholdHours: z.literal(24),
  connections: z.array(
    z.object({
      id: z.string().uuid(),
      label: z.string(),
      status: z.enum([
        'pending',
        'active',
        'degraded',
        'disconnected',
        'revoked',
      ]),
      lastObservedAt: z.string().datetime().nullable(),
      freshness: z.enum(['fresh', 'stale', 'unobserved']),
    }),
  ),
  attentionCount: count,
  activeCount: count,
  verifiedResolutions: count,
  automaticallyResolved: count.nullable(),
  automation: z
    .object({ numerator: count, denominator: count })
    .refine((v) => v.numerator <= v.denominator)
    .nullable(),
  prioritizedDecisions: z.array(caseSummarySchema).max(5),
});
export type OperationsOverview = z.infer<typeof operationsOverviewSchema>;

import { z } from 'zod';

import { caseSummarySchema } from './cases.js';

export const overviewQuerySchema = z
  .object({
    window: z.enum(['24h', '7d']).default('24h'),
    /** Exact verification interval from a morning brief; current case state is still current. */
    start: z.string().datetime().optional(),
    end: z.string().datetime().optional(),
  })
  .strict()
  .refine(
    (value) => (value.start === undefined) === (value.end === undefined),
    { message: 'Provide both start and end.' },
  )
  .refine(
    (value) =>
      !value.start ||
      !value.end ||
      (Date.parse(value.start) < Date.parse(value.end) &&
        Date.parse(value.end) <= Date.now()),
    {
      message:
        'The verification interval must end in the past and start before its end.',
    },
  );

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
  measurement: z
    .object({
      environment: z.literal('live'),
      countingUnit: z.literal('incident'),
      coverage: z.enum(['complete', 'partial', 'unavailable']),
      explanation: z.string(),
      eligible: count,
      verified: count,
      autonomous: count,
      human: count,
      unknownEligibility: count,
      unknownAttribution: count,
      unknownEnvironment: count,
      pending: count,
      dataThrough: z.string().datetime().nullable(),
    })
    .optional(),
  attentionCount: count,
  activeCount: count,
  verifiedResolutions: count,
  verifiedCases: z.array(caseSummarySchema).max(5).optional(),
  automaticallyResolved: count.nullable(),
  automation: z
    .object({ numerator: count, denominator: count })
    .refine((v) => v.numerator <= v.denominator)
    .nullable(),
  prioritizedDecisions: z.array(caseSummarySchema).max(5),
});

export type OperationsOverview = z.infer<typeof operationsOverviewSchema>;

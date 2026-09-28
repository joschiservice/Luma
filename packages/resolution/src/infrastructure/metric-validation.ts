import { z } from 'zod';

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
    offset: z.number().int().min(0).max(10000).default(0),
    asOf: timestamp.optional(),
    snapshot: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
  .refine(
    (v) =>
      !v.scope.updatedFrom ||
      !v.scope.updatedBefore ||
      Date.parse(v.scope.updatedFrom) < Date.parse(v.scope.updatedBefore),
    'The reporting window must end after it starts.',
  )
  .refine(
    (v) =>
      (!v.snapshot && !v.asOf && v.offset === 0) || (!!v.snapshot && !!v.asOf),
    'Pagination requires the snapshot and evaluation time.',
  );

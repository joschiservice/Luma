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
    cursor: z.string().max(2048).optional(),
  })
  .strict()
  .refine(
    (v) =>
      !v.scope.updatedFrom ||
      !v.scope.updatedBefore ||
      Date.parse(v.scope.updatedFrom) < Date.parse(v.scope.updatedBefore),
    'The reporting window must end after it starts.',
  );

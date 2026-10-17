import { z } from 'zod';

import type { CitedRead } from '../domain/capabilities.js';
import { sourceSchema } from './source-validation.js';

/** Validates one cited provider read with its source identity, freshness and completeness. */
const citedReadSchema: z.ZodType<CitedRead> = z
  .object({
    id: z.string().uuid(),
    // The adapter's own tenant and connection; the citing owner stores them in its tenant scope.
    source: sourceSchema.extend({
      tenantId: z.string().min(1).max(200),
      connectionId: z.string().min(1).max(200),
    }),
    kind: z.literal('snapshot'),
    observedAt: z.string().datetime(),
    sourceUpdatedAt: z.string().datetime().nullable(),
    sourceRevision: z.string().max(200).nullable(),
    adapterVersion: z.string().min(1).max(100),
    schemaVersion: z.literal(1),
    data: z.unknown(),
    completeness: z.enum(['complete', 'partial']),
  })
  .strict();

/** The reads an aggregate result cites; each evidence reference names one of them. */
export const citedReadsSchema = z.array(citedReadSchema).max(20);

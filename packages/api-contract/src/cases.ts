import { z } from 'zod';

import { diagnosisSchema, evidenceReferenceSchema } from './diagnosis.js';

export const caseClasses = [
  'sync_failure',
  'stuck_fulfillment',
  'inventory_mismatch',
  'workflow_failure',
] as const;

export const caseStates = [
  'detected',
  'diagnosed',
  'proposed',
  'awaiting_approval',
  'allowed',
  'executing',
  'verifying',
  'resolved',
  'failed',
  'escalated',
] as const;

export const caseQuerySchema = z
  .object({
    view: z.enum(['needs_you', 'active', 'history']).default('needs_you'),
    class: z.enum(caseClasses).optional(),
    severity: z.enum(['high', 'medium']).optional(),
    state: z.enum(caseStates).optional(),
    cursor: z.string().min(1).max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export type CaseQuery = z.infer<typeof caseQuerySchema>;

export const caseSummarySchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  class: z.string().min(1).max(100),
  state: z.enum(caseStates),
  severity: z.enum(['high', 'medium']),
  summary: z.string().max(2000),
  subject: z.object({
    kind: z.string(),
    id: z.string(),
    scope: z.array(z.string()).max(100),
  }),
  sources: z.array(z.string()).max(100),
  detectedAt: z.string().datetime(),
  lastActivityAt: z.string().datetime(),
  attention: z.object({
    required: z.boolean(),
    reason: z
      .enum(['approval', 'manual_intervention', 'uncertainty'])
      .nullable(),
    explanation: z.string(),
    requestedAt: z.string().datetime().nullable(),
  }),
  freshness: z.enum(['fresh', 'stale', 'unknown']),
  diagnosisStatus: z.enum([
    'pending',
    'ready',
    'insufficient_evidence',
    'failed',
  ]),
  resolution: z.enum(['verified', 'human_disposition']).nullable(),
});

export const caseListSchema = z.object({
  items: z.array(caseSummarySchema).max(100),
  nextCursor: z.string().nullable(),
  coverage: z.enum(['observed', 'unobserved']),
});

export const caseDetailSchema = caseSummarySchema.extend({
  diagnosis: diagnosisSchema.nullable(),
});

export type CaseSummary = z.infer<typeof caseSummarySchema>;

export type CaseDetail = z.infer<typeof caseDetailSchema>;

/** Historical evidence references, including observations outside the current diagnosis. */
export const caseEvidenceQuerySchema = z
  .object({
    cursor: z.string().min(1).max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export const caseEvidenceSchema = evidenceReferenceSchema.extend({
  completeness: z.enum(['complete', 'incomplete', 'unknown']),
});

export const caseEvidencePageSchema = z.object({
  schemaVersion: z.literal(1),
  items: z.array(caseEvidenceSchema).max(100),
  nextCursor: z.string().nullable(),
});

export type CaseEvidenceQuery = z.infer<typeof caseEvidenceQuerySchema>;

export type CaseEvidencePage = z.infer<typeof caseEvidencePageSchema>;

import { z } from 'zod';

const hours = z.number().int().min(1).max(2160);
const phase = z.enum(['receipt', 'inspection', 'proposal', 'financial']);
const reason = z.enum([
  'missing_units',
  'inspection',
  'proposal',
  'not_requested',
  'pending_money',
  'failed_money',
  'partial_money',
  'missing_evidence',
  'stale_evidence',
  'unavailable_evidence',
]);
const policy = z.object({
  revision: z.number().int().positive(),
  enabled: z.boolean(),
  receiptHours: hours,
  inspectionHours: hours,
  financialHours: hours,
  sourceMaxAgeSeconds: z.number().int().min(30).max(300),
  updatedBy: z.string(),
  updatedAt: z.string().datetime(),
});

/** Reads merchant deadlines without claiming automatic monitoring or source freshness. */
export const returnDeadlinePolicySchema = z.object({
  policy: policy.nullable(),
  canManage: z.boolean(),
});

/** A revision-checked, replay-safe change to merchant deadlines. */
export const configureReturnDeadlinesSchema = z
  .object({
    commandId: z.string().uuid(),
    expectedRevision: z.number().int().min(0),
    enabled: z.boolean(),
    receiptHours: hours,
    inspectionHours: hours,
    financialHours: hours,
    sourceMaxAgeSeconds: z.number().int().min(30).max(300).default(300),
  })
  .strict();
const episode = z.object({
  id: z.string().uuid(),
  caseId: z.string().uuid(),
  orderId: z.string().uuid(),
  connectionId: z.string().uuid(),
  phase,
  anchorAt: z.string().datetime(),
  anchorOrigin: z.enum([
    'case_opened',
    'receipt_recorded',
    'inspection_recorded',
    'resolution_proposed',
    'action_requested',
  ]),
  policyRevision: z.number().int().positive(),
  occurrence: z.number().int().positive(),
  dueAt: z.string().datetime(),
  state: z.enum(['waiting', 'escalated', 'verified', 'superseded', 'paused']),
  reason,
  ownerId: z.string(),
  units: z.number().int().min(0).nullable(),
  observedAt: z.string().datetime().nullable(),
  evidenceRefs: z.array(z.string()),
  openedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
});

/** Durable waits retain superseded and verified occurrences separately from current attention. */
export const returnWaitingViewSchema = z.object({
  policy: policy.nullable(),
  episodes: z.array(episode).max(500),
  ownerId: z.string(),
  canManage: z.boolean(),
  asOf: z.string().datetime(),
});

export type ReturnDeadlinePolicyView = z.infer<
  typeof returnDeadlinePolicySchema
>;

export type ReturnWaitingView = z.infer<typeof returnWaitingViewSchema>;

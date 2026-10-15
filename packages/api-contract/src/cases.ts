import { z } from 'zod';

import {
  collectionGroupKeyParameter,
  collectionGroupLimitParameter,
  collectionGroupParameter,
  collectionGroupSchema,
  collectionTimeZoneParameter,
  collectionWhereParameter,
} from './collections.js';
import { diagnosisSchema, evidenceReferenceSchema } from './diagnosis.js';

export const caseClasses = [
  'sync_failure',
  'stuck_fulfillment',
  'inventory_mismatch',
  'order_quantity_mismatch',
  'stock_sync_stall',
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

/** Kinds of record an issue is about. */
export const caseSubjectKinds = [
  'connection',
  'fulfillment',
  'sku',
  'order',
  'workflow_run',
] as const;

/** Orders the issue list accepts. */
const caseSorts = [
  'urgency',
  'detected',
  'lastActivity',
  'waitingSince',
] as const;

export const caseQuerySchema = z
  .object({
    view: z.enum(['needs_you', 'active', 'history']).default('active'),
    ownerId: z
      .union([z.string().uuid(), z.literal('unassigned')])
      .optional()
      .describe(
        'Issues of one owner, or `unassigned`. Kept for older links; prefer an `owner` condition.',
      ),
    class: z.enum(caseClasses).optional(),
    severity: z.enum(['high', 'medium']).optional(),
    state: z.enum(caseStates).optional(),
    q: z
      .string()
      .trim()
      .max(120)
      .default('')
      .describe(
        'Matches the summary, the record ID or its type, ignoring case. Never stored in saved views.',
      ),
    where: collectionWhereParameter.optional(),
    group: collectionGroupParameter.optional(),
    groupKey: collectionGroupKeyParameter.optional(),
    groupLimit: collectionGroupLimitParameter,
    timeZone: collectionTimeZoneParameter,
    sort: z
      .enum(caseSorts)
      .default('urgency')
      .describe(
        '`urgency` puts high severity first, then the oldest attention request, or the oldest detection for issues that need nobody. `waitingSince` is when the issue started waiting on a person; issues that wait on nobody come last in both directions.',
      ),
    direction: z
      .enum(['asc', 'desc'])
      .optional()
      .describe(
        'Defaults to ascending for `urgency` and `waitingSince`, descending for `detected` and `lastActivity`.',
      ),
    cursor: z.string().min(1).max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export type CaseQuery = z.infer<typeof caseQuerySchema>;

export const caseOwnerSchema = z.object({
  userId: z.string().uuid().nullable(),
  name: z.string().nullable(),
  revision: z.number().int().positive(),
  assignedBy: z.string().uuid(),
  assignedAt: z.string().datetime(),
});

export const caseSummarySchema = z.object({
  owner: caseOwnerSchema.nullable().optional(),
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  class: z.string().min(1).max(100),
  state: z.enum(caseStates),
  severity: z.enum(['high', 'medium']),
  summary: z.string().max(2000),
  subject: z.object({
    label: z.string().optional(),
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
  totalCount: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  items: z.array(caseSummarySchema).max(2500),
  nextCursor: z.string().nullable(),
  coverage: z.enum(['observed', 'unobserved']),
  groups: z
    .array(collectionGroupSchema)
    .optional()
    .describe(
      'With `group`: each group in display order with its exact count and first rows, whose issues are in `items`. With `groupKey`: the one group, with this page of its rows. An issue with several sources counts in each source’s group.',
    ),
  groupsTruncated: z
    .boolean()
    .optional()
    .describe(
      'More than 50 groups match; narrow the conditions to see the rest.',
    ),
});

export const caseDetailSchema = caseSummarySchema.extend({
  detectionLimits: z
    .object({
      inventoryTolerance: z.string(),
      propagationSeconds: z.number(),
      oversellPropagationSeconds: z.number(),
      stuckSeconds: z.number(),
      stallSeconds: z.number(),
      stallMinPositions: z.number(),
      stallSharePercent: z.number(),
    })
    .optional(),
  diagnosis: diagnosisSchema.nullable(),
  productIdentities: z
    .array(
      z.object({
        source: z.string(),
        title: z.string().nullable(),
        sku: z.string().nullable(),
      }),
    )
    .optional(),
  inventorySources: z
    .object({ left: z.string().nullable(), right: z.string().nullable() })
    .strict()
    .nullable()
    .optional(),
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

const caseEvidenceSchema = evidenceReferenceSchema.extend({
  completeness: z.enum(['complete', 'incomplete', 'unknown']),
});

export const caseEvidencePageSchema = z.object({
  schemaVersion: z.literal(1),
  items: z.array(caseEvidenceSchema).max(100),
  nextCursor: z.string().nullable(),
});

export type CaseEvidencePage = z.infer<typeof caseEvidencePageSchema>;

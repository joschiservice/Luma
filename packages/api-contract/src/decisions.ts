import { z } from 'zod';

import { actionDiffSchema } from './action-diff.js';
import {
  collectionGroupKeyParameter,
  collectionGroupLimitParameter,
  collectionGroupParameter,
  collectionGroupSchema,
  collectionTimeZoneParameter,
  collectionWhereParameter,
} from './collections.js';
import { evidenceReferenceLimit, evidenceSubjectSchema } from './evidence.js';
import { recordKindSchema } from './records.js';

const timestamp = z.string().datetime({ offset: true });

/** The owners whose authoritative decisions Needs you projects. */
export const decisionKinds = [
  'case',
  'custom_field',
  'return_case',
  'replenishment',
  'shipment_publication',
  'fulfillment_recovery',
  'inventory_correction',
  'order_edit',
  'supplier_commitment',
  'workflow_handover',
  'human_task',
  'message_reply',
] as const;

/** The owner whose authoritative decision an item projects. */
const decisionKindSchema = z.enum(decisionKinds);

/**
 * Why a person is needed: `approval` waits for an approve or reject; `run` is an approved change
 * waiting for its requester; `recovery` is an accepted or uncertain write that needs a check;
 * `manual_intervention` is a step Luma can't take; `uncertainty` is evidence Luma won't act on.
 */
export const decisionReasons = [
  'approval',
  'run',
  'recovery',
  'manual_intervention',
  'uncertainty',
] as const;

const decisionReasonSchema = z.enum(decisionReasons);

/** Operational areas a decision affects. */
export const decisionDomains = [
  'orders',
  'fulfillment',
  'inventory',
  'procurement',
  'operations',
] as const;

const decisionDomainSchema = z.enum(decisionDomains);

/** How much a decision affects operations; `unknown` when its owner can't tell. */
export const decisionImpacts = ['high', 'medium', 'low', 'unknown'] as const;

/** Orders the Needs you queue accepts. */
const decisionSorts = ['urgency', 'deadline', 'requested'] as const;

/**
 * What the reader can do now: `decide` approve or reject; `run` the approved change they requested;
 * `check` an accepted or uncertain write; `investigate` in the issue; `awaiting_other` means
 * someone else must approve; `view_only` means the reader's permissions don't allow a response.
 */
const decisionResponseSchema = z.enum([
  'decide',
  'run',
  'check',
  'investigate',
  'awaiting_other',
  'view_only',
]);

const decisionViewSchema = z.enum(['all', 'mine', 'unassigned']);

/** Where the authoritative decision controls live. Every surface acts on this same owner. */
const decisionOwnerSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('custom_field'),
    runId: z.string().uuid(),
    stepId: z.string().min(1),
  }),
  z.object({ kind: z.literal('return_case'), caseId: z.string().uuid() }),
  z.object({
    kind: z.literal('human_task'),
    definitionId: z.string(),
    runId: z.string().uuid(),
    stepId: z.string(),
  }),
  z.object({ kind: z.literal('case'), exceptionId: z.string().uuid() }),
  z.object({
    kind: z.literal('workflow_run'),
    definitionId: z.string().min(1),
    runId: z.string().uuid(),
    followUpProposalId: z.string().uuid().optional(),
  }),
  z.object({
    kind: z.literal('app_fulfillment'),
    appId: z.string().min(1),
    connectionId: z.string().uuid(),
    orderId: z.string().min(1),
    fulfillmentId: z.string().min(1),
  }),
  z.object({
    kind: z.literal('app_inventory'),
    appId: z.string().min(1),
    positionId: z.string().uuid(),
  }),
  z.object({
    kind: z.literal('app_order'),
    appId: z.string().min(1),
    connectionId: z.string().uuid(),
    orderId: z.string().min(1),
  }),
  z.object({
    kind: z.literal('purchase_order'),
    purchaseOrderId: z.string().uuid(),
  }),
  z.object({ kind: z.literal('purchasing_plan'), planId: z.string().uuid() }),
  z.object({ kind: z.literal('message_thread'), threadId: z.string().uuid() }),
]);

const decisionAssignmentSchema = z.object({
  assigneeId: z.string().uuid().nullable(),
  assignedBy: z.string().uuid(),
  assignedAt: timestamp,
  /** Send this revision back to change the assignment; 0 means never assigned. */
  revision: z.number().int().nonnegative(),
});

export const decisionItemSchema = z.object({
  diff: actionDiffSchema.nullable().optional(),
  outcome: z
    .object({
      state: z.enum(['approved', 'rejected', 'expired', 'resolved']),
      at: timestamp.nullable(),
      actorId: z.string().nullable(),
      actorName: z.string().nullable(),
      actorEmail: z.string().nullable(),
      next: z.enum(['pending', 'running', 'verified', 'failed', 'uncertain']),
      workflow: z.boolean(),
      purchaseOrderId: z.string().uuid().optional(),
      runId: z.string().uuid().optional(),
      definitionId: z.string().optional(),
    })
    .optional(),
  previousChange: z
    .array(z.object({ label: z.string(), value: z.string() }))
    .optional(),
  automatic: z.boolean().optional(),
  observeOnly: z.boolean().optional(),
  /** Stable queue ID, such as `case:<uuid>`. Assignments and links use it. */
  id: z.string().min(1).max(200),
  kind: decisionKindSchema,
  reason: decisionReasonSchema,
  domain: decisionDomainSchema,
  title: z.string(),
  /** Why Luma stopped and needs a person. */
  why: z.string(),
  /** What each available response causes. */
  consequences: z
    .array(z.object({ response: z.string(), text: z.string() }))
    .max(4),
  /** The exact proposed change or affected facts, such as source, location and quantity. */
  change: z.array(z.object({ label: z.string(), value: z.string() })).max(12),
  impact: z.object({
    level: z.enum(decisionImpacts),
    text: z.string().nullable(),
  }),
  /** `expiring` proposals lose their authority within 30 minutes. */
  urgency: z.enum(['expiring', 'high', 'normal']),
  requestedAt: timestamp,
  /** When the proposal or its evidence stops being valid; null when nothing expires. */
  deadline: timestamp.nullable(),
  requesterId: z.string().uuid().nullable(),
  evidence: z.object({
    observedAt: timestamp.nullable(),
    validUntil: timestamp.nullable(),
    state: z.enum(['fresh', 'stale', 'unknown']),
  }),
  response: decisionResponseSchema,
  assignment: decisionAssignmentSchema.nullable(),
  subject: z.object({ label: z.string(), detail: z.string().nullable() }),
  /** The canonical record this decision affects, when Luma can resolve it. */
  record: z
    .object({ kind: recordKindSchema, id: z.string().uuid() })
    .nullable(),
  owner: decisionOwnerSchema,
  /**
   * The record whose cited evidence backs this decision, for the evidence resolver; `refs` names
   * the references this decision relies on when they are a part of what the record cites.
   * Absent when the decision cites no stored evidence.
   */
  citedEvidence: z
    .object({
      subject: evidenceSubjectSchema,
      refs: z
        .array(z.string().min(1).max(500))
        .min(1)
        .max(evidenceReferenceLimit)
        .optional(),
      covers: z
        .enum([
          'return_creation',
          'exchange_check',
          'deadline_wait',
          'refund_step',
          'restock_step',
          'exchange_step',
        ])
        .optional()
        .describe(
          'Which record the evidence belongs to, when the decision could cite another one: a return case cites its creation, exchange completion check, due deadline wait, or latest refund, restock or exchange step.',
        ),
    })
    .optional(),
  /** Items with the same cause share a group; each still needs its own response. */
  group: z.object({ key: z.string(), label: z.string() }),
});

export const decisionQuerySchema = z.object({
  scope: z
    .enum(['actionable', 'waiting', 'all'])
    .default('actionable')
    .describe(
      'Actionable work by default; waiting holds decisions that need someone else. Direct item reads include either scope.',
    ),
  view: decisionViewSchema.default('all'),
  domain: decisionDomainSchema.optional(),
  reason: decisionReasonSchema.optional(),
  q: z
    .string()
    .trim()
    .max(120)
    .default('')
    .describe('Matches the title, ignoring case. Never stored in saved views.'),
  where: collectionWhereParameter.optional(),
  group: collectionGroupParameter.optional(),
  groupKey: collectionGroupKeyParameter.optional(),
  groupLimit: collectionGroupLimitParameter,
  timeZone: collectionTimeZoneParameter,
  sort: z
    .enum(decisionSorts)
    .default('urgency')
    .describe(
      '`urgency` puts proposals that expire within 30 minutes first, then high impact, then the earliest deadline and the oldest request. `deadline` and `requested` (waiting since) put decisions without one last in both directions.',
    ),
  direction: z
    .enum(['asc', 'desc'])
    .default('asc')
    .describe('Ascending puts the most urgent, earliest or oldest first.'),
  cursor: z.string().max(2000).optional(),
  /** Reads only this decision, for direct links; its counts cover that item alone. */
  id: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const decisionSourceSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** `unavailable`: the owner failed to answer, so its decisions are missing from this page. */
  state: z.enum(['available', 'unavailable']),
});

export const decisionListSchema = z.object({
  schemaVersion: z.literal(1),
  asOf: timestamp,
  items: z.array(decisionItemSchema),
  nextCursor: z.string().nullable(),
  /** Matching items for the current view and filters. */
  totalCount: z.number().int().nonnegative(),
  /** Items before this page in the same view and filters. */
  offset: z.number().int().nonnegative(),
  counts: z.object({
    views: z.partialRecord(decisionViewSchema, z.number().int().nonnegative()),
    domains: z.partialRecord(
      decisionDomainSchema,
      z.number().int().nonnegative(),
    ),
    reasons: z.partialRecord(
      decisionReasonSchema,
      z.number().int().nonnegative(),
    ),
  }),
  sources: z.array(decisionSourceSchema),
  groups: z
    .array(collectionGroupSchema)
    .optional()
    .describe(
      'With `group`: each group in display order with its exact count and first rows, whose decisions are in `items`. With `groupKey`: the one group, with this page of its rows. `complete` is false while an owner is unavailable.',
    ),
  groupsTruncated: z
    .boolean()
    .optional()
    .describe(
      'More than 50 groups match; narrow the conditions to see the rest.',
    ),
});

export const decisionAssignInputSchema = z
  .object({
    decisionId: z.string().min(1).max(200),
    /** Null releases the item. */
    assigneeId: z.string().uuid().nullable(),
    revision: z.number().int().nonnegative(),
  })
  .strict();

export const decisionAssignResultSchema = z.object({
  decisionId: z.string(),
  assignment: decisionAssignmentSchema,
});

export type DecisionKind = z.infer<typeof decisionKindSchema>;

export type DecisionReason = z.infer<typeof decisionReasonSchema>;

export type DecisionDomain = z.infer<typeof decisionDomainSchema>;

export type DecisionView = z.infer<typeof decisionViewSchema>;

export type DecisionOwner = z.infer<typeof decisionOwnerSchema>;

export type DecisionItem = z.infer<typeof decisionItemSchema>;

export type DecisionList = z.infer<typeof decisionListSchema>;

export type DecisionAssignInput = z.infer<typeof decisionAssignInputSchema>;

import { z } from 'zod';

import { recordKindSchema } from './records.js';

const timestamp = z.string().datetime({ offset: true });

/** The owner whose authoritative decision an item projects. */
export const decisionKindSchema = z.enum([
  'case',
  'replenishment',
  'fulfillment_recovery',
  'inventory_correction',
  'supplier_commitment',
  'workflow_handover',
]);

/**
 * Why a person is needed: `approval` waits for an approve or reject; `run` is an approved change
 * waiting for its requester; `recovery` is an accepted or uncertain write that needs a check;
 * `manual_intervention` is a step Luma can't take; `uncertainty` is evidence Luma won't act on.
 */
export const decisionReasonSchema = z.enum([
  'approval',
  'run',
  'recovery',
  'manual_intervention',
  'uncertainty',
]);

export const decisionDomainSchema = z.enum([
  'orders',
  'fulfillment',
  'inventory',
  'procurement',
  'operations',
]);

/**
 * What the reader can do now: `decide` approve or reject; `run` the approved change they requested;
 * `check` an accepted or uncertain write; `investigate` in the issue; `awaiting_other` means
 * someone else must approve; `view_only` means the reader's permissions don't allow a response.
 */
export const decisionResponseSchema = z.enum([
  'decide',
  'run',
  'check',
  'investigate',
  'awaiting_other',
  'view_only',
]);

export const decisionViewSchema = z.enum(['all', 'mine', 'unassigned']);

/** Where the authoritative decision controls live. Every surface acts on this same owner. */
export const decisionOwnerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('case'), exceptionId: z.string().uuid() }),
  z.object({
    kind: z.literal('workflow_run'),
    definitionId: z.string().min(1),
    runId: z.string().uuid(),
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
    kind: z.literal('purchase_order'),
    purchaseOrderId: z.string().uuid(),
  }),
]);

export const decisionAssignmentSchema = z.object({
  assigneeId: z.string().uuid().nullable(),
  assignedBy: z.string().uuid(),
  assignedAt: timestamp,
  /** Send this revision back to change the assignment; 0 means never assigned. */
  revision: z.number().int().nonnegative(),
});

export const decisionItemSchema = z.object({
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
    level: z.enum(['high', 'medium', 'low', 'unknown']),
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
  /** Items with the same cause share a group; each still needs its own response. */
  group: z.object({ key: z.string(), label: z.string() }),
});

export const decisionQuerySchema = z.object({
  view: decisionViewSchema.default('all'),
  domain: decisionDomainSchema.optional(),
  reason: decisionReasonSchema.optional(),
  cursor: z.string().max(2000).optional(),
  /** Reads only this decision, for direct links; its counts cover that item alone. */
  id: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const decisionSourceSchema = z.object({
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
    views: z.record(decisionViewSchema, z.number().int().nonnegative()),
    domains: z.record(decisionDomainSchema, z.number().int().nonnegative()),
    reasons: z.record(decisionReasonSchema, z.number().int().nonnegative()),
  }),
  sources: z.array(decisionSourceSchema),
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

export type DecisionResponse = z.infer<typeof decisionResponseSchema>;

export type DecisionView = z.infer<typeof decisionViewSchema>;

export type DecisionOwner = z.infer<typeof decisionOwnerSchema>;

export type DecisionItem = z.infer<typeof decisionItemSchema>;

export type DecisionQuery = z.infer<typeof decisionQuerySchema>;

export type DecisionList = z.infer<typeof decisionListSchema>;

export type DecisionAssignment = z.infer<typeof decisionAssignmentSchema>;

export type DecisionAssignInput = z.infer<typeof decisionAssignInputSchema>;

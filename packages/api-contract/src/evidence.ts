import { z } from 'zod';

import { activityActorSchema } from './activity.js';

const uuid = z.string().uuid();
const instant = z.string().datetime();

/**
 * The record whose cited evidence is read. Each kind needs its own read permission:
 * `procurement.read` for purchase orders, purchasing plans and replenishment runs,
 * `inventory.read` for native stock receipts, `returns.read` for return writes, exchanges and
 * deadline waits, `messages.read` for replies, `issues.read` for cases, and for an app decision
 * the read permission of its change's area (`inventory.read`, `orders.read` or
 * `fulfillment.read`). An app decision is named by its proposal ID, a replenishment run by its
 * workflow run ID and a deadline wait by its occurrence ID.
 */
export const evidenceSubjectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('purchase_order'), id: uuid }).strict(),
  z.object({ kind: z.literal('purchasing_plan'), id: uuid }).strict(),
  z.object({ kind: z.literal('replenishment_run'), id: uuid }).strict(),
  z.object({ kind: z.literal('native_receipt'), id: uuid }).strict(),
  z.object({ kind: z.literal('app_decision'), id: uuid }).strict(),
  z.object({ kind: z.literal('return_creation'), id: uuid }).strict(),
  z.object({ kind: z.literal('return_settlement'), id: uuid }).strict(),
  z.object({ kind: z.literal('return_exchange'), id: uuid }).strict(),
  z.object({ kind: z.literal('return_exchange_step'), id: uuid }).strict(),
  z.object({ kind: z.literal('return_wait'), id: uuid }).strict(),
  z.object({ kind: z.literal('reply'), id: uuid }).strict(),
  z.object({ kind: z.literal('case'), id: uuid }).strict(),
]);

/** The most references one request resolves. */
export const evidenceReferenceLimit = 100;

export const evidenceRequestSchema = z
  .object({
    subject: evidenceSubjectSchema,
    /** The cited references to resolve; omitted, every reference the subject cites. */
    refs: z
      .array(z.string().min(1).max(500))
      .min(1)
      .max(evidenceReferenceLimit)
      .optional(),
  })
  .strict();

/** Normalized read fields shown as a summary. Provider payloads are never returned. */
export const evidenceSummaryFields = [
  'status',
  'state',
  'outcome',
  'payment',
  'orderNumber',
  'number',
  'confirmed',
  'requestedDeliveryDate',
  'available',
  'onHand',
  'reserved',
  'quantity',
  'amount',
  'currency',
  'lines',
] as const;

/** Luma records a reference can name. */
export const evidenceRecordKinds = [
  'purchase_order',
  'purchasing_plan',
  'order_change',
  'submission',
  'commitment',
  'supplier_message',
  'follow_up',
  'policy_decision',
  'approval',
  'return_case',
  'return_creation',
  'return_settlement',
  'return_exchange',
  'return_exchange_step',
  'thread',
  'reply',
  'case',
  'case_proposal',
  'procurement_event',
  'stock_receipt_review',
  'ledger_entry',
  'stock_ownership_change',
  'stock_booking',
  'receipt_note',
  'replenishment_rule',
  'replenishment_proposal',
  'supplier',
] as const;

/** What a purchase order's lifecycle event recorded. */
const procurementEventKinds = ['created', 'status_changed', 'revised'] as const;

const connectionSchema = z.object({
  id: uuid,
  /** The connection's name in this workspace; null when it was removed. */
  label: z.string().nullable(),
});

const providerRecordSchema = z.object({
  resource: z.string(),
  externalId: z.string(),
});

const quantity = z.string().max(40);

/** Facts some Luma records carry, so the evidence view can show them without another read. */
const evidenceRecordDetailSchema = z.discriminatedUnion('kind', [
  z.object({
    /** A purchase order was created, changed status or was revised to a new revision. */
    kind: z.literal('procurement_event'),
    event: z.enum(procurementEventKinds),
    /** The order status before and after; null when the event did not record it. */
    from: z.string().max(40).nullable(),
    to: z.string().max(40).nullable(),
    revision: z.number().int().nullable(),
  }),
  z.object({
    /** A stock receipt waiting for, or given, an inventory review. */
    kind: z.literal('stock_receipt_review'),
    state: z.enum(['pending', 'approved', 'rejected']),
    /** Good units the receipt books in total. */
    quantity: quantity.nullable(),
    unit: z.string().max(40).nullable(),
  }),
  z.object({
    /** A committed stock ledger entry: what it posted to each account and the balance after. */
    kind: z.literal('ledger_entry'),
    purpose: z.string().max(40),
    /** A later entry reversed this one. */
    reversed: z.boolean(),
    postings: z
      .array(
        z.object({
          state: z.string().max(40),
          unit: z.string().max(40),
          quantity,
          balanceAfter: quantity,
          /** The account's version after this posting. */
          version: z.number().int(),
        }),
      )
      .max(20),
  }),
]);

/** What a cited reference resolves to. */
const evidenceResolutionSchema = z.discriminatedUnion('kind', [
  z.object({
    /** A stored provider read: what Luma saw, from which system, when and how completely. */
    kind: z.literal('read'),
    provider: z.string(),
    connection: connectionSchema,
    record: providerRecordSchema.nullable(),
    /** When the read started, on Luma's clock. */
    observedAt: instant,
    /** When the source last changed the record, as it reported; null when it did not say. */
    sourceUpdatedAt: instant.nullable(),
    sourceRevision: z.string().nullable(),
    /** A partial read cannot establish an outcome; null when the owner did not record it. */
    completeness: z.enum(['complete', 'partial']).nullable(),
    adapterVersion: z.string().nullable(),
    summary: z
      .array(
        z.object({
          field: z.enum(evidenceSummaryFields),
          value: z.string().max(200),
        }),
      )
      .max(evidenceSummaryFields.length),
  }),
  z.object({
    /** A provider's acceptance of a write. Acceptance is not verification. */
    kind: z.literal('write_receipt'),
    provider: z.string(),
    connection: connectionSchema,
    /** The capability the write used; null when neither the receipt nor its attempt names it. */
    capability: z.string().nullable(),
    acceptedAt: instant,
    records: z.array(providerRecordSchema).max(20),
    providerRequestId: z.string().nullable(),
    /** The adapter version that made the write; null when it was not recorded. */
    adapterVersion: z.string().nullable(),
  }),
  z.object({
    /** A Luma record, such as the case, approval or reply the entry refers to. */
    kind: z.literal('luma_record'),
    record: z.enum(evidenceRecordKinds),
    id: z.string(),
    /** When the record was written, for records that keep the time. */
    at: instant.nullable().optional(),
    /** Who wrote the record, for records that keep the actor. */
    actor: activityActorSchema.nullable().optional(),
    detail: evidenceRecordDetailSchema.nullable().optional(),
  }),
  z.object({
    /**
     * A message Luma stored from a connected mailbox: who sent it, when, its subject and whether
     * the receiving system authenticated the sender. The message text is never returned.
     */
    kind: z.literal('message'),
    provider: z.string(),
    connection: connectionSchema,
    direction: z.enum(['inbound', 'outbound']),
    sender: z.object({
      address: z.string().max(320),
      name: z.string().max(200).nullable(),
    }),
    receivedAt: instant,
    subject: z.string().max(300),
    /** Only `aligned` identifies the sender; `unknown` when the mailbox did not say. */
    senderAuthentication: z.enum(['aligned', 'unaligned', 'unknown']),
  }),
  z.object({
    /** Evidence another area guards; the reader lacks `permission`, so it is not shown. */
    kind: z.literal('restricted'),
    permission: z.string().max(100),
  }),
  z.object({
    /** Cited before Luma stored this kind of evidence; the read or receipt was never kept. */
    kind: z.literal('not_retained'),
    retentionStartedAt: instant,
  }),
  z.object({
    /** No stored evidence or Luma record matches, and Luma cannot tell why. */
    kind: z.literal('unresolved'),
  }),
]);

const evidenceItemSchema = z.object({
  ref: z.string(),
  /** How the subject cites the reference; null when the subject's records don't cite it. */
  citedAs: z.enum(['read', 'write_receipt', 'record']).nullable(),
  /** When the citing record was written; null when unknown. */
  citedAt: instant.nullable(),
  resolution: evidenceResolutionSchema,
});

export const evidenceListSchema = z.object({
  subject: evidenceSubjectSchema,
  items: z.array(evidenceItemSchema).max(evidenceReferenceLimit),
  /** The subject cites more references than one response returns. */
  truncated: z.boolean(),
  asOf: instant,
});

export type EvidenceSubject = z.infer<typeof evidenceSubjectSchema>;

export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

export type EvidenceList = z.infer<typeof evidenceListSchema>;

export type EvidenceSummaryField = (typeof evidenceSummaryFields)[number];

export type EvidenceRecordKind = (typeof evidenceRecordKinds)[number];

export type EvidenceRecordDetail = z.infer<typeof evidenceRecordDetailSchema>;

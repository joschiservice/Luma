import { z } from 'zod';

const uuid = z.string().uuid();
const instant = z.string().datetime();

/**
 * The record whose cited evidence is read. Each kind needs its own read permission:
 * `procurement.read` for purchase orders, `returns.read` for return writes, `messages.read` for
 * replies and `issues.read` for cases.
 */
const evidenceSubjectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('purchase_order'), id: uuid }).strict(),
  z.object({ kind: z.literal('return_creation'), id: uuid }).strict(),
  z.object({ kind: z.literal('return_settlement'), id: uuid }).strict(),
  z.object({ kind: z.literal('return_exchange_step'), id: uuid }).strict(),
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
  'quantity',
  'amount',
  'currency',
  'lines',
  'complete',
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
] as const;

const connectionSchema = z.object({
  id: uuid,
  /** The connection's name in this workspace; null when it was removed. */
  label: z.string().nullable(),
});

const providerRecordSchema = z.object({
  resource: z.string(),
  externalId: z.string(),
});

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
  }),
  z.object({
    /** A Luma record, such as the case, approval or reply the entry refers to. */
    kind: z.literal('luma_record'),
    record: z.enum(evidenceRecordKinds),
    id: z.string(),
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

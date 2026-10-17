/** The most references one request resolves. */
export const evidenceReferenceLimit = 100;

/**
 * Normalized read fields the evidence view shows, in display order. Everything else in a read,
 * such as names, addresses and message text, stays on the server.
 */
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

export type EvidenceSummaryField = (typeof evidenceSummaryFields)[number];

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

export type EvidenceRecordKind = (typeof evidenceRecordKinds)[number];

/** A connection by ID, with its workspace name; null once removed. */
interface EvidenceConnection {
  id: string;
  label: string | null;
}

/** What a cited reference resolves to. */
export type EvidenceResolution =
  | {
      kind: 'read';
      provider: string;
      connection: EvidenceConnection;
      record: { resource: string; externalId: string } | null;
      observedAt: string;
      sourceUpdatedAt: string | null;
      sourceRevision: string | null;
      completeness: 'complete' | 'partial' | null;
      adapterVersion: string | null;
      summary: { field: EvidenceSummaryField; value: string }[];
    }
  | {
      kind: 'write_receipt';
      provider: string;
      connection: EvidenceConnection;
      capability: string | null;
      acceptedAt: string;
      records: { resource: string; externalId: string }[];
      providerRequestId: string | null;
    }
  | { kind: 'luma_record'; record: EvidenceRecordKind; id: string }
  | { kind: 'not_retained'; retentionStartedAt: string }
  | { kind: 'unresolved' };

/** One resolved reference and how the subject cites it. */
export interface EvidenceItem {
  ref: string;
  citedAs: 'read' | 'write_receipt' | 'record' | null;
  citedAt: string | null;
  resolution: EvidenceResolution;
}

/** The kinds of provider evidence whose storage began at a recorded time. */
export type RetentionKind =
  'procurement_reads' | 'return_reads' | 'write_receipts';

/** How a record cites a reference, and when that record was written. */
export interface Citation {
  ref: string;
  citedAs: 'read' | 'write_receipt' | 'record';
  citedAt: string | null;
  /** The capability of the write whose attempt cites a receipt, when known. */
  capability?: string | null;
}

/** A stored provider read as its owner keeps it, before presentation. */
export interface StoredRead {
  kind: 'read';
  id: string;
  provider: string;
  connectionId: string;
  record: { resource: string; externalId: string } | null;
  observedAt: string;
  sourceUpdatedAt: string | null;
  sourceRevision: string | null;
  adapterVersion: string | null;
  completeness: 'complete' | 'partial' | null;
  /** The adapter's normalized read; only allowlisted fields leave the server. */
  data: unknown;
}

/** A stored provider write receipt as its owner keeps it. */
export interface StoredReceipt {
  kind: 'write_receipt';
  id: string;
  provider: string;
  connectionId: string;
  /** Null when the owner's receipt does not name it; the citing attempt may. */
  capability: string | null;
  acceptedAt: string;
  records: { resource: string; externalId: string }[];
  providerRequestId: string | null;
}

/** A Luma record that a reference names. */
export interface NamedRecord {
  kind: 'luma_record';
  id: string;
  record: EvidenceRecordKind;
}

/** What an owner found for a reference. */
export type StoredEvidence = StoredRead | StoredReceipt | NamedRecord;

const summaryFields = new Set<string>(evidenceSummaryFields);

function isSummaryField(field: string): field is EvidenceSummaryField {
  return summaryFields.has(field);
}

/**
 * Picks the allowlisted top-level fields of a normalized read: scalars as text and lists as
 * their length. Names, addresses, message text and every other field stay on the server.
 */
export function summarizeRead(data: unknown) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const summary: { field: EvidenceSummaryField; value: string }[] = [];
  for (const [field, value] of Object.entries(data)) {
    if (!isSummaryField(field)) continue;
    if (Array.isArray(value))
      summary.push({ field, value: String(value.length) });
    else if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    )
      summary.push({ field, value: String(value).slice(0, 200) });
  }

  return summary.sort(
    (a, b) =>
      evidenceSummaryFields.indexOf(a.field) -
      evidenceSummaryFields.indexOf(b.field),
  );
}

/**
 * Decides what a reference without stored evidence or a Luma record means. A read or receipt
 * cited before its owner began storing that kind was never captured, so it is not retained.
 * Anything else, including a citation whose time or owner start is unknown, stays unresolved:
 * evidence that should exist but does not is never explained away.
 */
export function missingEvidence(
  citation: Citation | undefined,
  start: string | null,
): EvidenceResolution {
  if (
    citation?.citedAt &&
    citation.citedAs !== 'record' &&
    start &&
    Date.parse(citation.citedAt) < Date.parse(start)
  )
    return { kind: 'not_retained', retentionStartedAt: start };

  return { kind: 'unresolved' };
}

/**
 * Resolves each reference once, in request order. Stored evidence wins over a Luma record
 * with the same ID; references the owners did not find fall back to `missingEvidence`.
 */
export function resolveEvidence(input: {
  refs: readonly string[];
  citations: readonly Citation[];
  found: readonly StoredEvidence[];
  /** Connection names by ID; removed connections have none. */
  labels: ReadonlyMap<string, string | null>;
  /** When storage began for each kind a citation of this subject needs. */
  start: (citedAs: Citation['citedAs']) => string | null;
}): EvidenceItem[] {
  const cited = new Map<string, Citation>();
  for (const citation of input.citations) {
    const known = cited.get(citation.ref);
    // The earliest citation decides whether the evidence could have been stored.
    if (
      !known ||
      (citation.citedAt &&
        (!known.citedAt ||
          Date.parse(citation.citedAt) < Date.parse(known.citedAt)))
    )
      cited.set(citation.ref, citation);
  }
  const found = new Map<string, StoredEvidence>();
  for (const evidence of input.found) {
    const known = found.get(evidence.id);
    if (!known || known.kind === 'luma_record')
      found.set(evidence.id, evidence);
  }
  const connection = (id: string) => ({
    id,
    label: input.labels.get(id) ?? null,
  });

  return [...new Set(input.refs)].map((ref) => {
    const citation = cited.get(ref);
    const evidence = found.get(ref);
    const resolution: EvidenceResolution = !evidence
      ? missingEvidence(
          citation,
          citation ? input.start(citation.citedAs) : null,
        )
      : evidence.kind === 'read'
        ? {
            kind: 'read',
            provider: evidence.provider,
            connection: connection(evidence.connectionId),
            record: evidence.record,
            observedAt: evidence.observedAt,
            sourceUpdatedAt: evidence.sourceUpdatedAt,
            sourceRevision: evidence.sourceRevision,
            completeness: evidence.completeness,
            adapterVersion: evidence.adapterVersion,
            summary: summarizeRead(evidence.data),
          }
        : evidence.kind === 'write_receipt'
          ? {
              kind: 'write_receipt',
              provider: evidence.provider,
              connection: connection(evidence.connectionId),
              capability: evidence.capability ?? citation?.capability ?? null,
              acceptedAt: evidence.acceptedAt,
              records: evidence.records.slice(0, 20),
              providerRequestId: evidence.providerRequestId,
            }
          : { kind: 'luma_record', record: evidence.record, id: evidence.id };

    return {
      ref,
      citedAs: citation?.citedAs ?? null,
      citedAt: citation?.citedAt ?? null,
      resolution,
    };
  });
}

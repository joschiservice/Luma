/** The most references one request resolves. */
export const evidenceReferenceLimit = 100;

/** The kinds of record whose cited evidence can be read, each resolved by its owner. */
export type EvidenceSubjectKind =
  | 'purchase_order'
  | 'purchasing_plan'
  | 'replenishment_run'
  | 'native_receipt'
  | 'app_decision'
  | 'return_creation'
  | 'return_settlement'
  | 'return_exchange'
  | 'return_exchange_step'
  | 'return_wait'
  | 'reply'
  | 'case';

const areaPermissions = {
  inventory: 'inventory.read',
  orders: 'orders.read',
  fulfillment: 'fulfillment.read',
} as const;

/**
 * The read permission that guards the evidence of a write through `capability`, such as
 * `inventory.read` for `inventory.available.reconcile`: the capability's area decides. Null for
 * capabilities outside those areas, whose evidence no app decision shows.
 */
export function capabilityReadPermission(capability: string) {
  const area = capability.split('.')[0] ?? '';

  return isArea(area) ? areaPermissions[area] : null;
}

function isArea(area: string): area is keyof typeof areaPermissions {
  return Object.hasOwn(areaPermissions, area);
}

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
  'reserved',
  'quantity',
  'amount',
  'currency',
  'lines',
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

type EvidenceRecordKind = (typeof evidenceRecordKinds)[number];

/** Facts a Luma record carries for the evidence view. */
type EvidenceRecordDetail =
  | {
      kind: 'procurement_event';
      event: 'created' | 'status_changed' | 'revised';
      from: string | null;
      to: string | null;
      revision: number | null;
    }
  | {
      kind: 'stock_receipt_review';
      state: 'pending' | 'approved' | 'rejected';
      quantity: string | null;
      unit: string | null;
    }
  | {
      kind: 'ledger_entry';
      purpose: string;
      reversed: boolean;
      postings: {
        state: string;
        unit: string;
        quantity: string;
        balanceAfter: string;
        version: number;
      }[];
    };

/** Who wrote a record, as the evidence view names them. */
export interface EvidenceActor {
  kind: 'member' | 'former_member' | 'luma' | 'service' | 'unrecorded';
  id: string | null;
  name: string | null;
  email: string | null;
  workflow: null;
}

/** A workspace person a recorded user ID names, including people who left. */
export type EvidencePerson = {
  id: string;
  name: string | null;
  email: string | null;
  member: boolean;
};

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
      adapterVersion: string | null;
    }
  | {
      kind: 'luma_record';
      record: EvidenceRecordKind;
      id: string;
      at?: string | null;
      actor?: EvidenceActor | null;
      detail?: EvidenceRecordDetail | null;
    }
  | {
      kind: 'message';
      provider: string;
      connection: EvidenceConnection;
      direction: 'inbound' | 'outbound';
      sender: { address: string; name: string | null };
      receivedAt: string;
      subject: string;
      senderAuthentication: 'aligned' | 'unaligned' | 'unknown';
    }
  | { kind: 'restricted'; permission: string }
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
  | 'procurement_reads'
  | 'return_reads'
  | 'write_receipts'
  | 'replenishment_demand_reads';

/**
 * Evidence a subject relied on but cites no references for, because the subject was recorded
 * before Luma kept them: a replenishment run's order reads behind a known demand estimate.
 */
export interface UncitedEvidence {
  evidence: 'demand_reads';
  /** When the subject recorded what it relied on. */
  recordedAt: string;
}

/** Evidence a subject relied on that was never kept, and when Luma began keeping it. */
export interface NotRetainedEvidence {
  evidence: UncitedEvidence['evidence'];
  retentionStartedAt: string;
}

const uncitedRetention = {
  demand_reads: 'replenishment_demand_reads',
} as const satisfies Record<UncitedEvidence['evidence'], RetentionKind>;

/**
 * Explains evidence a subject relied on without citing it. Only what was recorded before Luma
 * began keeping that kind is not retained; anything recorded later, or whose start is unknown,
 * is left out rather than explained away, because a missing citation after storage began is a
 * defect, not history.
 */
export function notRetainedEvidence(
  uncited: readonly UncitedEvidence[],
  start: (kind: RetentionKind) => string | null,
): NotRetainedEvidence[] {
  return uncited.flatMap((entry) => {
    const startedAt = start(uncitedRetention[entry.evidence]);

    return startedAt && Date.parse(entry.recordedAt) < Date.parse(startedAt)
      ? [{ evidence: entry.evidence, retentionStartedAt: startedAt }]
      : [];
  });
}

/** How a record cites a reference, and when that record was written. */
export interface Citation {
  ref: string;
  citedAs: 'read' | 'write_receipt' | 'record';
  citedAt: string | null;
  /** The capability of the write whose attempt cites a receipt, when known. */
  capability?: string | null;
}

/** A stored provider read as its owner keeps it, before presentation. */
interface StoredRead {
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
interface StoredReceipt {
  kind: 'write_receipt';
  id: string;
  provider: string;
  connectionId: string;
  /** Null when the owner's receipt does not name it; the citing attempt may. */
  capability: string | null;
  acceptedAt: string;
  records: { resource: string; externalId: string }[];
  providerRequestId: string | null;
  /** The adapter that made the write; absent or null when the owner did not record it. */
  adapterVersion?: string | null | undefined;
}

/**
 * A Luma record that a reference names. `id` is the reference; `recordId` names the record when
 * the reference is not its ID, such as a note a person recorded with a receipt.
 */
interface NamedRecord {
  kind: 'luma_record';
  id: string;
  record: EvidenceRecordKind;
  recordId?: string;
  /** When the record was written. */
  at?: string | null;
  /** The recorded actor: a user ID, another principal, or null when none was recorded. */
  actorId?: string | null;
  detail?: EvidenceRecordDetail | null;
}

/** A message a mailbox owner stored, without its text. */
interface StoredMessage {
  kind: 'message';
  id: string;
  provider: string;
  connectionId: string;
  direction: 'inbound' | 'outbound';
  sender: { address: string; name: string | null };
  receivedAt: string;
  subject: string;
  senderAuthentication: 'aligned' | 'unaligned' | 'unknown';
}

/** Evidence another area guards, found for a reader who lacks its read permission. */
interface RestrictedEvidence {
  kind: 'restricted';
  id: string;
  permission: string;
}

/** What an owner found for a reference. */
export type StoredEvidence =
  StoredRead | StoredReceipt | NamedRecord | StoredMessage | RestrictedEvidence;

const nilUser = '00000000-0000-0000-0000-000000000000';
const userId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Names who wrote a record: a current or former workspace member, Luma for the nil user ID, a
 * service for other recorded principals, or `unrecorded`. Email is kept only for current
 * members. Undefined when the record does not keep an actor.
 */
export function evidenceActor(
  actorId: string | null | undefined,
  people: ReadonlyMap<string, EvidencePerson>,
): EvidenceActor | undefined {
  if (actorId === undefined) return undefined;
  const base = { id: actorId, name: null, email: null, workflow: null };
  if (actorId === null) return { ...base, kind: 'unrecorded' };
  if (actorId === nilUser) return { ...base, kind: 'luma' };
  if (!userId.test(actorId))
    return { ...base, kind: 'service', name: actorId.slice(0, 200) };
  const person = people.get(actorId.toLowerCase());

  return person?.member
    ? { ...base, kind: 'member', name: person.name, email: person.email }
    : { ...base, kind: 'former_member', name: person?.name ?? null };
}

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

/** Presents a Luma record with the time, actor and facts its owner recorded. */
function lumaRecord(
  evidence: NamedRecord,
  people: ReadonlyMap<string, EvidencePerson>,
): EvidenceResolution {
  const actor = evidenceActor(evidence.actorId, people);

  return {
    kind: 'luma_record',
    record: evidence.record,
    id: evidence.recordId ?? evidence.id,
    ...(evidence.at !== undefined ? { at: evidence.at } : {}),
    ...(actor ? { actor } : {}),
    ...(evidence.detail !== undefined ? { detail: evidence.detail } : {}),
  };
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
  /** Workspace people by lowercase user ID, for record actors. */
  people?: ReadonlyMap<string, EvidencePerson>;
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
  // Stored evidence wins over a Luma record, and both over a restricted placeholder.
  const weight = (evidence: StoredEvidence) =>
    evidence.kind === 'restricted'
      ? 0
      : evidence.kind === 'luma_record'
        ? 1
        : 2;
  const found = new Map<string, StoredEvidence>();
  for (const evidence of input.found) {
    const known = found.get(evidence.id);
    if (!known || weight(known) < weight(evidence))
      found.set(evidence.id, evidence);
  }
  const people = input.people ?? new Map<string, EvidencePerson>();
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
              adapterVersion: evidence.adapterVersion ?? null,
            }
          : evidence.kind === 'message'
            ? {
                kind: 'message',
                provider: evidence.provider,
                connection: connection(evidence.connectionId),
                direction: evidence.direction,
                sender: evidence.sender,
                receivedAt: evidence.receivedAt,
                subject: evidence.subject.slice(0, 300),
                senderAuthentication: evidence.senderAuthentication,
              }
            : evidence.kind === 'restricted'
              ? { kind: 'restricted', permission: evidence.permission }
              : lumaRecord(evidence, people);

    return {
      ref,
      citedAs: citation?.citedAs ?? null,
      citedAt: citation?.citedAt ?? null,
      resolution,
    };
  });
}

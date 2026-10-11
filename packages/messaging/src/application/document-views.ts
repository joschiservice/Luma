/** What document reads return to people; mirrors the HTTP contract shapes. */

import type { TenantContext } from '@luma/identity';
import { hasPermission } from '@luma/identity';

import type { Representation } from '../domain/documents.js';
import type {
  FactChange,
  FactLocator,
  FactMatch,
  FactOrigin,
  FactRecord,
  FactReview,
  FactStatus,
  FactValue,
} from '../domain/facts.js';
import type { FactRow, StoredRepresentation } from './documents-store.js';
import type { DocumentRow } from './store.js';
import type { DocumentSummary, RecordView } from './views.js';
import { documentSummary, recordView } from './views.js';

export interface FactView {
  id: string;
  documentId: string;
  value: FactValue;
  locator: FactLocator;
  quote: string;
  confidence: 'high' | 'low';
  match: {
    state: FactMatch['state'];
    record: RecordView | null;
    candidates: RecordView[];
  };
  status: FactStatus;
  origin: FactOrigin;
  change: FactChange | null;
  review: FactReview | null;
  createdAt: string;
}

export interface DocumentDetail {
  document: DocumentSummary;
  representation: Representation | null;
  facts: FactView[];
  removedFacts: FactView[];
  extraction: { available: boolean; reason: string | null };
  canReview: boolean;
}

/** Records the facts of these rows refer to, for one label lookup. */
export function factRecords(facts: readonly FactRow[]): FactRecord[] {
  return facts.flatMap((fact) => [
    ...(fact.document.match.record ? [fact.document.match.record] : []),
    ...fact.document.match.candidates,
  ]);
}

/** Presents a fact; record labels show only to readers of the record. */
export function factView(
  context: TenantContext,
  fact: FactRow,
  labels: ReadonlyMap<string, string>,
): FactView {
  const document = fact.document;
  const record = (r: FactRecord) => recordView(context, r.kind, r.id, labels);

  return {
    id: fact.id,
    documentId: fact.documentId,
    value: document.value,
    locator: document.locator,
    quote: document.quote,
    confidence: document.confidence,
    match: {
      state: document.match.state,
      record: document.match.record ? record(document.match.record) : null,
      candidates: document.match.candidates.map(record),
    },
    status: fact.status,
    origin: document.origin,
    change: document.change,
    review: document.review,
    createdAt: fact.createdAt,
  };
}

/** Presents a document beside its facts and what the previous version had that this one lacks. */
export function documentDetail(
  context: TenantContext,
  input: {
    document: DocumentRow;
    receivedAt: string;
    stored: StoredRepresentation | null;
    facts: readonly FactRow[];
    removed: readonly FactRow[];
    labels: ReadonlyMap<string, string>;
    extractor: { available: boolean; reason: string | null };
  },
): DocumentDetail {
  const toReview = input.facts.filter(
    (fact) => fact.status === 'proposed' || fact.status === 'needs_correction',
  ).length;

  return {
    document: documentSummary(input.document, input.receivedAt, toReview),
    representation: input.document.purgedAt
      ? null
      : (input.stored?.representation ?? null),
    facts: input.facts.map((fact) => factView(context, fact, input.labels)),
    removedFacts: input.removed.map((fact) =>
      factView(context, fact, input.labels),
    ),
    extraction: {
      available: input.extractor.available,
      reason:
        input.stored?.extraction.reason ??
        (input.extractor.available ? null : input.extractor.reason),
    },
    canReview:
      hasPermission(context, 'messages.manage') &&
      input.document.state === 'ready',
  };
}

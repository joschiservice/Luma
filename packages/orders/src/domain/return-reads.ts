/**
 * A provider read that return verification, the audit or deadline evidence cites. Its ID is the
 * cited reference, so the stored read is the evidence itself.
 */
export interface ReturnRead {
  id: string;
  source: {
    provider: string;
    connectionId: string;
    resource: string;
    externalId: string;
    scopeKey: string;
  };
  /** When the read started, on Luma's clock. */
  observedAt: string;
  sourceUpdatedAt: string | null;
  sourceRevision: string | null;
  adapterVersion: string;
  /** A partial read cannot establish a creation, settlement, exchange or settled money. */
  completeness: 'complete' | 'partial';
  /** The adapter's normalized read. */
  data: unknown;
}

/** What a stored read was cited for. */
export type ReturnReadPurpose =
  'creation' | 'settlement' | 'exchange' | 'completion';

/** A cited read as orders stores it, with the case and the request or check that cited it. */
export interface ReturnReadEvidence extends ReturnRead {
  tenantId: string;
  caseId: string;
  purpose: ReturnReadPurpose;
  /** The creation, settlement, exchange step or exchange operation that cited the read. */
  subjectId: string;
}

/**
 * The reads that `refs` names, once each. Returns null when any reference has no read: a
 * reference that cannot be stored must not be cited.
 */
export function citedReads(
  refs: readonly string[],
  reads: readonly ReturnRead[],
): ReturnRead[] | null {
  const byId = new Map(reads.map((read) => [read.id, read]));
  const cited: ReturnRead[] = [];
  for (const ref of new Set(refs)) {
    const read = byId.get(ref);
    if (!read) return null;
    cited.push(read);
  }

  return cited;
}

/** Whether every read is complete; only complete reads can establish an outcome. */
export function completeReads(reads: readonly ReturnRead[]) {
  return reads.every((read) => read.completeness === 'complete');
}

/** Builds the stored evidence for one cited read of a tenant's return case. */
export function returnReadEvidence(
  tenantId: string,
  caseId: string,
  subject: { purpose: ReturnReadPurpose; id: string },
  read: ReturnRead,
): ReturnReadEvidence {
  return {
    id: read.id,
    tenantId,
    caseId,
    purpose: subject.purpose,
    subjectId: subject.id,
    source: read.source,
    observedAt: read.observedAt,
    sourceUpdatedAt: read.sourceUpdatedAt,
    sourceRevision: read.sourceRevision,
    adapterVersion: read.adapterVersion,
    completeness: read.completeness,
    data: read.data,
  };
}

import type { Permission, TenantContext } from '@luma/identity';
import type { SqlTransaction } from '@luma/platform';

import type {
  Citation,
  EvidenceItem,
  RetentionKind,
  StoredEvidence,
} from '../domain/evidence.js';

/** The record whose cited evidence is read. */
export interface EvidenceSubject {
  kind:
    | 'purchase_order'
    | 'return_creation'
    | 'return_settlement'
    | 'return_exchange_step'
    | 'reply'
    | 'case';
  id: string;
}

/** The subject and, optionally, the cited references to resolve. */
export interface EvidenceRequest {
  subject: EvidenceSubject;
  /** Without references, every reference the subject cites, up to the limit. */
  refs?: string[] | undefined;
}

/** The resolved references of one subject. */
export interface EvidenceList {
  subject: EvidenceSubject;
  items: EvidenceItem[];
  /** The subject cites more references than one response returns. */
  truncated: boolean;
  asOf: string;
}

/** What a subject cites: the actions it executed and the references its own records name. */
export interface SubjectCitations {
  /** Proposals whose execution attempts belong to the subject. */
  actionIds: string[];
  citations: Citation[];
}

/**
 * The owner of one kind of subject, such as procurement for purchase orders. Both functions run
 * in the reader's read-only tenant transaction and must scope every query to the tenant and the
 * subject.
 */
export interface EvidenceSubjectOwner {
  /** The read permission of the subject's area. */
  permission: Permission;
  /** When storage began for the reads and write receipts this subject cites. */
  retention: {
    read: RetentionKind | null;
    write_receipt: RetentionKind | null;
  };
  /** Returns null when the tenant has no such subject. */
  citations(
    tx: SqlTransaction,
    tenantId: string,
    subjectId: string,
  ): Promise<SubjectCitations | null>;
  /**
   * Finds stored evidence and Luma records among the references. Owner tables are matched
   * through the subject; tables that cannot be, such as an app's evidence, only for `cited`
   * references.
   */
  lookup(
    tx: SqlTransaction,
    tenantId: string,
    subjectId: string,
    refs: EvidenceLookup,
  ): Promise<StoredEvidence[]>;
}

/** The references one request resolves. */
export interface EvidenceLookup {
  all: string[];
  /** The references that can name a row: stored evidence and records have UUID IDs. */
  uuids: string[];
  /** The UUID references the subject cites as reads or write receipts. */
  cited: string[];
}

export type EvidenceOwners = Partial<
  Record<EvidenceSubject['kind'], EvidenceSubjectOwner>
>;

/**
 * Resolves the references a subject cites to stored reads, write receipts, Luma records, or
 * evidence that was never retained. Requires the subject area's read permission and throws
 * not found when the tenant has no such subject.
 */
export interface EvidenceReader {
  resolve(
    context: TenantContext,
    request: EvidenceRequest,
  ): Promise<EvidenceList>;
}

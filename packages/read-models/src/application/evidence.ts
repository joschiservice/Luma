import type { Permission, TenantContext } from '@luma/identity';
import type { SqlTransaction } from '@luma/platform';

import type {
  Citation,
  EvidenceItem,
  RetentionKind,
  StoredEvidence,
} from '../domain/evidence.js';

/** The record whose cited evidence is read. */
interface EvidenceSubject {
  kind:
    | 'purchase_order'
    | 'purchasing_plan'
    | 'native_receipt'
    | 'app_decision'
    | 'return_creation'
    | 'return_settlement'
    | 'return_exchange_step'
    | 'reply'
    | 'case';
  id: string;
}

/** The subject and, optionally, the cited references to resolve. */
interface EvidenceRequest {
  subject: EvidenceSubject;
  /** Without references, every reference the subject cites, up to the limit. */
  refs?: string[] | undefined;
}

/** The resolved references of one subject. */
interface EvidenceList {
  subject: EvidenceSubject;
  items: EvidenceItem[];
  /** The subject cites more references than one response returns. */
  truncated: boolean;
  asOf: string;
}

/** What a subject cites: the actions it executed and the references its own records name. */
interface SubjectCitations {
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
  /**
   * The read permission of the subject's area. Null when it depends on the subject, such as an
   * app decision's change; `citations` then checks `access` and throws forbidden itself.
   */
  permission: Permission | null;
  /** When storage began for the reads and write receipts this subject cites. */
  retention: {
    read: RetentionKind | null;
    write_receipt: RetentionKind | null;
  };
  /**
   * Returns null when the tenant has no such subject. `access` names the reader's other read
   * permissions, for citations another area guards, such as stock booking proof.
   */
  citations(
    tx: SqlTransaction,
    tenantId: string,
    subjectId: string,
    access: EvidenceAccess,
  ): Promise<SubjectCitations | null>;
  /**
   * Finds stored evidence and Luma records among the references. Owner tables are matched
   * through the subject; tables that cannot be, such as an app's evidence, only for `cited`
   * references. Evidence another area guards is returned as `restricted` when `access` lacks
   * that area's read permission, never left out.
   */
  lookup(
    tx: SqlTransaction,
    tenantId: string,
    subjectId: string,
    refs: EvidenceLookup,
    access: EvidenceAccess,
  ): Promise<StoredEvidence[]>;
}

/** The reader's read permissions, for evidence another area guards. */
export interface EvidenceAccess {
  can(permission: Permission): boolean;
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

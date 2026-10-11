import type { Representation } from '../domain/documents.js';
import type { FactDocument, FactStatus } from '../domain/facts.js';
import type { DocumentRow } from './store.js';

/** How automatic extraction went for a document. */
export interface ExtractionNote {
  state: 'completed' | 'unavailable' | 'failed';
  /** For people: why extraction did not run or what it left out. */
  reason: string | null;
  /** Proposed facts dropped because their quote was not in the document or their value was invalid. */
  discarded: number;
  model: string | null;
}

/** The stored reading of a document; removed with its content. */
export interface StoredRepresentation {
  representation: Representation;
  /** Rows, columns, pages or characters beyond the limits were cut. */
  truncated: boolean;
  extraction: ExtractionNote;
}

export interface FactRow {
  id: string;
  documentId: string;
  /** Deduplicates repeated reads of the same fact. */
  factKey: string;
  document: FactDocument;
  status: FactStatus;
  createdAt: string;
  updatedAt: string;
}

/** Document reading and facts within one tenant transaction. */
export interface DocumentReadingRepository {
  /** A document without its content; `lock` holds it until the transaction ends. */
  get(id: string, lock?: boolean): Promise<DocumentRow | null>;
  representation(id: string): Promise<StoredRepresentation | null>;
  /**
   * Claims documents of mailboxes read as `principalId`: pending ones, and reads that stopped
   * without finishing once their retry wait passed. Claimed documents are `reading` with one
   * more attempt.
   */
  claim(principalId: string, at: string, limit: number): Promise<DocumentRow[]>;
  /** Serializes reads of the same content in the workspace until the transaction ends. */
  lockContent(sha256: string): Promise<void>;
  /** The earliest read document with this content, other than `excludeId`. */
  original(sha256: string, excludeId: string): Promise<DocumentRow | null>;
  /** The latest ready version in the document's family that arrived no later than it. */
  previousVersion(document: DocumentRow): Promise<DocumentRow | null>;
  /**
   * Writes state, identity and version fields. `content` replaces stored content and
   * representation when given.
   */
  update(
    document: DocumentRow,
    content?: {
      bytes: Uint8Array | null;
      representation: StoredRepresentation | null;
    },
  ): Promise<void>;
  /** Facts of the documents, in the order they were found. */
  facts(documentIds: string[]): Promise<FactRow[]>;
  fact(id: string, lock?: boolean): Promise<FactRow | null>;
  /** Returns false when the document already has a fact with this key. */
  insertFact(fact: FactRow): Promise<boolean>;
  updateFact(fact: FactRow): Promise<void>;
}

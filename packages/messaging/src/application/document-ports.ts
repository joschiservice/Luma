import type { TenantContext } from '@luma/identity';

import type {
  DocumentFormat,
  ReadOutcome,
  Representation,
} from '../domain/documents.js';
import type { FactValue } from '../domain/facts.js';

type AttachmentResult =
  | {
      ok: true;
      bytes: Uint8Array;
      /** The digest the provider reported, checked against the bytes. */
      sha256: string | null;
    }
  | { ok: false; code: string };

/** Reads attachment content through the installed connection's capabilities. */
export interface AttachmentReader {
  read(
    context: TenantContext,
    connectionId: string,
    input: {
      message: { externalId: string; scopeKey: string };
      attachment: { externalId: string; scopeKey: string };
      maxBytes: number;
    },
  ): Promise<AttachmentResult>;
}

type RepresentResult =
  | { ok: true; representation: Representation; truncated: boolean }
  | { ok: false; outcome: ReadOutcome };

/** Builds a document's representation from its bytes; throws only for unexpected failures. */
export type Represent = (
  bytes: Uint8Array,
  input: { format: DocumentFormat; filename: string },
) => Promise<RepresentResult>;

/** A fact as a model read it, before Luma finds its quote in the document. */
export interface ModelFact {
  value: FactValue;
  quote: string;
  page: number | null;
  sheet: string | null;
  row: number | null;
  column: number | null;
  confident: boolean;
}

type ExtractionResult =
  | {
      ok: true;
      facts: ModelFact[];
      /** Facts dropped because their values were not valid. */
      invalid: number;
      model: string;
    }
  | { ok: false; reason: string };

/**
 * Proposes facts from a document with a model. Implementations send the document only to a regional
 * zero-retention route and never log it. `available` is false without such a route.
 */
export interface FactExtractor {
  available: boolean;
  /** Why extraction is unavailable, for people; null when available. */
  reason: string | null;
  extract(
    context: TenantContext,
    input: { filename: string; representation: Representation },
  ): Promise<ExtractionResult>;
}

/**
 * Reads other owners' records for matching facts. Reads are system reads: callers decide
 * whether the reader may see a record before showing its label.
 */
export interface DocumentDirectory {
  /** Catalog SKU codes that exist among `codes` (trimmed, upper case). */
  skus(context: TenantContext, codes: string[]): Promise<Set<string>>;
  /** Suppliers whose lower-case name is one of `names`. */
  suppliers(
    context: TenantContext,
    names: string[],
  ): Promise<{ id: string; key: string }[]>;
}

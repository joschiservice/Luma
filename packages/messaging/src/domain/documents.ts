/**
 * Documents read from attachments: what Luma reads, how a read can end, and the limits that keep
 * one file from dominating a background pass.
 */

import { maxDocumentBytes } from './threads.js';

/** A document's readable content: text per page, or spreadsheet cells as text. */
export type Representation =
  | { kind: 'text'; pages: string[] }
  | { kind: 'sheets'; sheets: { name: string; rows: string[][] }[] };

export type DocumentFormat = 'pdf' | 'csv' | 'xlsx' | 'txt';

/**
 * Bounds on what is kept from one file. A 10 MB spreadsheet can hold millions of cells; people
 * review documents beside their facts, so the representation stays small enough to show.
 */
export const representationLimits = {
  pages: 300,
  /** Characters kept across all pages. */
  characters: 1_000_000,
  rows: 5000,
  columns: 100,
  /** Characters kept per cell. */
  cell: 1000,
  sheets: 20,
} as const;

/** Reads a document gets before it is marked failed. */
export const maxReadAttempts = 4;

/** Wait before a claimed or failed read is tried again: 5 minutes, doubling, at most an hour. */
export function readRetryMs(attempts: number) {
  return Math.min(3_600_000, 300_000 * 2 ** Math.max(attempts - 1, 0));
}

/** The format Luma reads a file as, from its type or extension; null when it is not read. */
export function documentFormat(input: {
  filename: string;
  mimeType: string;
}): DocumentFormat | null {
  const mime = input.mimeType.toLowerCase().split(';')[0]!.trim();
  const extension = /\.([a-z0-9]+)$/i.exec(input.filename)?.[1]?.toLowerCase();
  if (mime === 'application/pdf' || extension === 'pdf') return 'pdf';
  if (
    mime ===
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    extension === 'xlsx'
  )
    return 'xlsx';
  if (mime === 'text/csv' || mime === 'application/csv' || extension === 'csv')
    return 'csv';
  if (mime === 'text/plain' || extension === 'txt') return 'txt';

  return null;
}

/**
 * How a read ended when it produced no representation:
 * - `retry`: a temporary problem; the pass tries again with backoff, then marks it failed.
 * - `failed`: reading stopped; someone can read it again.
 * - `unreadable`: the content itself cannot be read; reading again gives the same result.
 * - `unsupported`: the content is outside what Luma reads.
 */
export type ReadOutcome =
  | { state: 'retry' | 'failed'; failure: DocumentFailure }
  | { state: 'unreadable'; failure: UnreadableReason }
  | { state: 'unsupported'; failure: 'too_large' | 'unsupported_type' };

export type UnreadableReason = 'encrypted' | 'no_text' | 'damaged' | 'empty';

export type DocumentFailure =
  | 'read_failed'
  | 'connection'
  | 'not_found'
  | 'read_rejected'
  | 'content_mismatch'
  | 'content_removed'
  | 'parse_failed';

/** Classifies a connector failure while fetching the attachment. */
export function fetchFailure(code: string): ReadOutcome {
  switch (code) {
    case 'authentication':
    case 'permission_denied':
    case 'unsupported_capability':
    case 'unsupported_version':
    case 'export_unavailable':
      return { state: 'failed', failure: 'connection' };
    case 'not_found':
      return { state: 'failed', failure: 'not_found' };
    case 'invalid_input':
    case 'conflict':
      return { state: 'failed', failure: 'read_rejected' };
    default:
      return { state: 'retry', failure: 'read_failed' };
  }
}

/** Checks fetched content before it is read: size, emptiness and the provider's digest. */
export function contentCheck(input: {
  size: number;
  sha256: string;
  reportedSha256: string | null;
}): ReadOutcome | null {
  if (input.reportedSha256 && input.reportedSha256 !== input.sha256)
    return { state: 'retry', failure: 'content_mismatch' };
  if (input.size > maxDocumentBytes)
    return { state: 'unsupported', failure: 'too_large' };
  if (input.size === 0) return { state: 'unreadable', failure: 'empty' };

  return null;
}

/** Whether a representation has any text worth reading. */
export function hasContent(representation: Representation) {
  return representation.kind === 'text'
    ? representation.pages.some((page) => page.trim().length > 0)
    : representation.sheets.some((sheet) =>
        sheet.rows.some((row) => row.some((cell) => cell.trim().length > 0)),
      );
}

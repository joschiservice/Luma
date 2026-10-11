/**
 * Facts read from documents: proposals people confirm, correct or reject. A fact cites its
 * source by locator and quote; it never authorizes an action.
 */

import type { Representation } from './documents.js';
import type { RecordKind } from './linking.js';

export interface Money {
  amount: string;
  currency: string;
}

export type FactValue =
  | {
      kind: 'party';
      role: 'supplier' | 'customer';
      name: string;
      email: string | null;
    }
  | {
      kind: 'reference';
      role: 'purchase_order' | 'order' | 'invoice' | 'delivery_note' | 'other';
      text: string;
    }
  | {
      kind: 'line';
      sku: string | null;
      description: string | null;
      quantity: string | null;
      unit: string | null;
      unitPrice: Money | null;
    }
  | {
      kind: 'date';
      role: 'delivery' | 'shipping' | 'order' | 'due' | 'other';
      date: string;
    }
  | { kind: 'amount'; role: 'total' | 'other'; money: Money };

export type FactKind = FactValue['kind'];

export type FactLocator =
  | { kind: 'text'; page: number | null; start: number; end: number }
  | {
      kind: 'cells';
      sheet: string;
      row: number;
      rowEnd: number;
      column: number;
      columnEnd: number;
    };

export interface FactRecord {
  kind: RecordKind;
  id: string;
}

export interface FactMatch {
  state: 'matched' | 'ambiguous' | 'unmatched' | 'not_applicable';
  /** Null when matched to something that is not a linkable record, such as a catalog SKU. */
  record: FactRecord | null;
  candidates: FactRecord[];
}

export type FactStatus =
  'proposed' | 'needs_correction' | 'confirmed' | 'rejected';

export type FactOrigin = 'model' | 'table' | 'manual';

export type FactChange = 'new' | 'changed' | 'unchanged';

export interface FactReview {
  outcome: 'confirmed' | 'corrected' | 'rejected';
  by: string;
  at: string;
  /** The value before a correction. */
  original: FactValue | null;
}

/** What is stored for a fact besides its status. */
export interface FactDocument {
  value: FactValue;
  locator: FactLocator;
  /** Source text the fact cites; empty after the document content was removed. */
  quote: string;
  confidence: 'high' | 'low';
  match: FactMatch;
  origin: FactOrigin;
  change: FactChange | null;
  review: FactReview | null;
}

/** A fact found in a document before matching and comparison. */
export interface ProposedFact {
  value: FactValue;
  locator: FactLocator;
  quote: string;
  confidence: 'high' | 'low';
  origin: FactOrigin;
}

const money = /^-?\d{1,14}(\.\d{1,6})?$/;
const quantity = /^\d{1,14}(\.\d{1,6})?$/;

/** Whether a calendar date in `YYYY-MM-DD` exists. */
export function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);

  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

const text = (value: string | null, max: number, min = 1) =>
  value === null || (value.trim().length >= min && value.length <= max);

/** Checks a value against the bounds the contract states; model output must pass it too. */
export function validValue(value: FactValue) {
  switch (value.kind) {
    case 'party':
      return (
        text(value.name, 200) &&
        (value.email === null || text(value.email, 320))
      );
    case 'reference':
      return text(value.text, 200);
    case 'line':
      return (
        (value.sku !== null || value.description !== null) &&
        text(value.sku, 200) &&
        text(value.description, 500, 0) &&
        (value.quantity === null || quantity.test(value.quantity)) &&
        text(value.unit, 40) &&
        (value.unitPrice === null ||
          (money.test(value.unitPrice.amount) &&
            /^[A-Z]{3}$/.test(value.unitPrice.currency)))
      );
    case 'date':
      return validDate(value.date);
    case 'amount':
      return (
        money.test(value.money.amount) &&
        /^[A-Z]{3}$/.test(value.money.currency)
      );
  }
}

/** A SKU as the catalog compares it: trimmed and upper case. */
export const codeKey = (value: string) => value.trim().toUpperCase();

/** What identifies a fact within a document, before occurrence numbering. */
function identity(value: FactValue) {
  switch (value.kind) {
    case 'line':
      return `line:${value.sku ? codeKey(value.sku) : (value.description ?? '').trim().toLowerCase()}`;
    case 'party':
    case 'reference':
    case 'date':
    case 'amount':
      return `${value.kind}:${value.role}`;
  }
}

/**
 * Keys facts for comparison between versions: lines by SKU (or description), other kinds by
 * role. Repeated keys are numbered in order, so a schedule's second line for a SKU compares with
 * the previous version's second line.
 */
export function comparisonKeys(values: readonly FactValue[]) {
  const seen = new Map<string, number>();

  return values.map((value) => {
    const key = identity(value);
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);

    return count === 1 ? key : `${key}#${count}`;
  });
}

/** A stable serialization of a value, for comparison and deduplication. */
export function valueKey(value: FactValue) {
  const sorted = (input: unknown): unknown =>
    input && typeof input === 'object'
      ? Object.fromEntries(
          Object.entries(input as Record<string, unknown>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, sorted(v)]),
        )
      : input;

  return JSON.stringify(sorted(value));
}

interface PriorFact {
  value: FactValue;
  status: FactStatus;
  review: FactReview | null;
}

/**
 * Compares a version's facts with the previous version's. An unchanged fact whose earlier
 * counterpart was confirmed or rejected carries that review, so an amended document asks only
 * about what changed.
 */
export function compareFacts<P extends PriorFact>(
  current: readonly { value: FactValue }[],
  previous: readonly P[] | null,
): {
  change: FactChange | null;
  carried: {
    status: 'confirmed' | 'rejected';
    review: FactReview;
    prior: P;
  } | null;
}[] {
  if (!previous) return current.map(() => ({ change: null, carried: null }));
  const before = new Map<string, P>();
  const keys = comparisonKeys(previous.map((fact) => fact.value));
  previous.forEach((fact, index) => before.set(keys[index]!, fact));

  return comparisonKeys(current.map((fact) => fact.value)).map((key, index) => {
    const prior = before.get(key);
    if (!prior) return { change: 'new', carried: null };
    if (valueKey(prior.value) !== valueKey(current[index]!.value))
      // A rejected fact was never a fact, so a different value is new rather than changed.
      return {
        change: prior.status === 'rejected' ? 'new' : 'changed',
        carried: null,
      };
    const carried =
      prior.review &&
      (prior.status === 'confirmed' || prior.status === 'rejected')
        ? {
            status: prior.status,
            review: {
              ...prior.review,
              outcome:
                prior.status === 'rejected'
                  ? ('rejected' as const)
                  : ('confirmed' as const),
              original: null,
            },
            prior,
          }
        : null;

    return { change: 'unchanged', carried };
  });
}

/** Facts of the previous version with no counterpart in the current one. */
export function removedFacts<
  T extends { value: FactValue; status: FactStatus },
>(current: readonly { value: FactValue }[], previous: readonly T[]) {
  const keys = new Set(comparisonKeys(current.map((fact) => fact.value)));
  const previousKeys = comparisonKeys(previous.map((fact) => fact.value));

  return previous.filter(
    (fact, index) =>
      fact.status !== 'rejected' && !keys.has(previousKeys[index]!),
  );
}

/** A new fact needs a correction when it is uncertain or matches several records. */
export function initialStatus(
  confidence: 'high' | 'low',
  match: FactMatch,
): 'proposed' | 'needs_correction' {
  return confidence === 'low' || match.state === 'ambiguous'
    ? 'needs_correction'
    : 'proposed';
}

/** The record kind a fact can refer to; null when it refers to none. */
export function recordKindFor(value: FactValue): RecordKind | null {
  if (value.kind === 'party') return value.role;
  if (value.kind === 'reference' && value.role === 'purchase_order')
    return 'purchase_order';
  if (value.kind === 'reference' && value.role === 'order') return 'order';

  return null;
}

export type ReviewInput =
  | { outcome: 'confirm' }
  | { outcome: 'reject' }
  | {
      outcome: 'correct';
      value: FactValue;
      /** The record a person chose, or the match of the corrected value. */
      match: FactMatch;
    };

export type ReviewRefusal =
  'already_reviewed' | 'needs_correction' | 'kind_changed' | 'invalid_value';

/**
 * Applies a review. Facts that need correction cannot be confirmed unchanged; a correction
 * keeps the fact's kind and records the original value. Reviewed facts are final.
 */
export function reviewFact(
  fact: { status: FactStatus; document: FactDocument },
  input: ReviewInput,
  by: string,
  at: string,
):
  | { ok: true; status: FactStatus; document: FactDocument }
  | { ok: false; refusal: ReviewRefusal } {
  if (fact.status === 'confirmed' || fact.status === 'rejected')
    return { ok: false, refusal: 'already_reviewed' };
  if (input.outcome === 'reject')
    return {
      ok: true,
      status: 'rejected',
      document: {
        ...fact.document,
        review: { outcome: 'rejected', by, at, original: null },
      },
    };
  if (input.outcome === 'confirm') {
    if (fact.status === 'needs_correction')
      return { ok: false, refusal: 'needs_correction' };

    return {
      ok: true,
      status: 'confirmed',
      document: {
        ...fact.document,
        review: { outcome: 'confirmed', by, at, original: null },
      },
    };
  }
  if (input.value.kind !== fact.document.value.kind)
    return { ok: false, refusal: 'kind_changed' };
  if (!validValue(input.value)) return { ok: false, refusal: 'invalid_value' };
  if (input.match.state === 'ambiguous')
    return { ok: false, refusal: 'needs_correction' };

  return {
    ok: true,
    status: 'confirmed',
    document: {
      ...fact.document,
      value: input.value,
      match: input.match,
      review: {
        outcome: 'corrected',
        by,
        at,
        original: fact.document.value,
      },
    },
  };
}

/** Text of a sheet range: cells joined by tabs, rows by line breaks. */
function cellText(
  rows: readonly (readonly string[])[],
  locator: Extract<FactLocator, { kind: 'cells' }>,
) {
  const lines: string[] = [];
  for (let row = locator.row; row <= locator.rowEnd; row++) {
    const cells: string[] = [];
    for (let column = locator.column; column <= locator.columnEnd; column++)
      cells.push(rows[row - 1]?.[column - 1] ?? '');
    lines.push(cells.join('\t'));
  }

  return lines.join('\n').trim();
}

/**
 * The source text a locator points to, or null when it is outside the document: a text span
 * within one page (pages are 1-based; null for single-page text), or cells within a sheet.
 */
export function quoteAt(
  representation: Representation,
  locator: FactLocator,
): string | null {
  if (locator.kind === 'text') {
    if (representation.kind !== 'text') return null;
    const index =
      locator.page === null
        ? representation.pages.length === 1
          ? 0
          : -1
        : locator.page - 1;
    const page = representation.pages[index];
    if (
      page === undefined ||
      locator.start >= locator.end ||
      locator.end > page.length
    )
      return null;
    const quote = page.slice(locator.start, locator.end);

    return quote.trim() ? quote : null;
  }
  if (representation.kind !== 'sheets') return null;
  const sheet = representation.sheets.find((s) => s.name === locator.sheet);
  if (
    !sheet ||
    locator.row > locator.rowEnd ||
    locator.column > locator.columnEnd ||
    locator.rowEnd > sheet.rows.length ||
    locator.columnEnd > Math.max(0, ...sheet.rows.map((row) => row.length))
  )
    return null;
  const quote = cellText(sheet.rows, locator);

  return quote ? quote : null;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Finds a quote in text exactly, or with any whitespace between its words. */
function find(text: string, quote: string) {
  const exact = text.indexOf(quote);
  if (exact >= 0) return { start: exact, end: exact + quote.length };
  const words = quote.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const match = new RegExp(words.map(escape).join('\\s+')).exec(text);

  return match
    ? { start: match.index, end: match.index + match[0].length }
    : null;
}

/**
 * Locates a quoted passage in a document, preferring the page or cell the reader named. Returns
 * null when the quote is not in the document, so facts without a source are dropped.
 */
export function locateQuote(
  representation: Representation,
  quote: string,
  hint: {
    page?: number | null;
    sheet?: string | null;
    row?: number | null;
    column?: number | null;
  } = {},
): { locator: FactLocator; quote: string } | null {
  if (!quote.trim()) return null;
  if (representation.kind === 'text') {
    const pages = representation.pages;
    const order = pages.map((_, index) => index);
    if (hint.page && hint.page <= pages.length)
      order.unshift(order.splice(hint.page - 1, 1)[0]!);
    for (const index of order) {
      const span = find(pages[index]!, quote);
      if (span)
        return {
          locator: {
            kind: 'text',
            page: pages.length === 1 ? null : index + 1,
            ...span,
          },
          quote: pages[index]!.slice(span.start, span.end),
        };
    }

    return null;
  }
  const wanted = quote.trim().toLowerCase();
  const contains = (cell: string) =>
    cell.trim() !== '' && cell.toLowerCase().includes(wanted);
  const sheets = [...representation.sheets].sort(
    (a, b) => Number(b.name === hint.sheet) - Number(a.name === hint.sheet),
  );
  for (const sheet of sheets) {
    if (sheet.name === hint.sheet && hint.row && hint.column) {
      const row = sheet.rows[hint.row - 1];
      // The named row may cite several cells; accept it when its text holds the quote.
      if (row && row.join('\t').toLowerCase().includes(wanted)) {
        const used = row
          .map((cell, index) => (cell.trim() ? index + 1 : 0))
          .filter(Boolean);
        const single = row.findIndex(contains);
        const column = single >= 0 ? single + 1 : Math.min(...used);
        const columnEnd = single >= 0 ? single + 1 : Math.max(...used);
        const locator: FactLocator = {
          kind: 'cells',
          sheet: sheet.name,
          row: hint.row,
          rowEnd: hint.row,
          column,
          columnEnd,
        };

        return { locator, quote: quoteAt(representation, locator)! };
      }
    }
    for (const [rowIndex, row] of sheet.rows.entries()) {
      const columnIndex = row.findIndex(contains);
      if (columnIndex < 0) continue;
      const locator: FactLocator = {
        kind: 'cells',
        sheet: sheet.name,
        row: rowIndex + 1,
        rowEnd: rowIndex + 1,
        column: columnIndex + 1,
        columnEnd: columnIndex + 1,
      };

      return { locator, quote: quoteAt(representation, locator)! };
    }
  }

  return null;
}

/** Deduplicates repeated reads: the same value at the same place is one fact. */
export function factKey(
  origin: FactOrigin,
  value: FactValue,
  locator: FactLocator,
  digest: (value: unknown) => string,
) {
  return `${origin}:${digest({ value: valueKey(value), locator })}`.slice(
    0,
    400,
  );
}

/** Orders facts as they appear in the document: by page and offset, or by sheet, row and column. */
export function byPosition(
  a: { locator: FactLocator },
  b: { locator: FactLocator },
) {
  const x = a.locator;
  const y = b.locator;
  if (x.kind !== y.kind) return x.kind === 'text' ? -1 : 1;
  if (x.kind === 'text' && y.kind === 'text')
    return (x.page ?? 0) - (y.page ?? 0) || x.start - y.start || x.end - y.end;
  if (x.kind === 'cells' && y.kind === 'cells')
    return (
      x.sheet.localeCompare(y.sheet) || x.row - y.row || x.column - y.column
    );

  return 0;
}

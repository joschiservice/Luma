/**
 * Matches document facts to records by exact evidence: SKUs to catalog codes, references to
 * order numbers and purchase-order references, parties to suppliers and customer profiles.
 * Several equal candidates make a fact ambiguous; recency or similarity never picks one.
 */

import type { FactMatch, FactRecord, FactValue } from './facts.js';
import { codeKey } from './facts.js';

/** What other owners hold for the keys a document's facts mention. */
export interface MatchLookups {
  /** Catalog SKU codes that exist, as `codeKey`. */
  skus: ReadonlySet<string>;
  /** Orders and purchase orders by upper-case reference. */
  references: readonly {
    kind: 'order' | 'purchase_order';
    id: string;
    key: string;
  }[];
  /** Customer profiles by lower-case email. */
  customers: readonly { email: string; id: string }[];
  /** Suppliers by lower-case name. */
  suppliers: readonly { id: string; key: string }[];
  /** Suppliers the thread is linked to because a mailbox rule matched its sender. */
  ruleSuppliers: readonly string[];
}

/** The keys to look up for a set of facts. */
export function lookupKeys(values: readonly FactValue[]) {
  const skus = new Set<string>();
  const references = new Set<string>();
  const emails = new Set<string>();
  const supplierNames = new Set<string>();
  for (const value of values) {
    if (value.kind === 'line' && value.sku) skus.add(codeKey(value.sku));
    if (
      value.kind === 'reference' &&
      (value.role === 'purchase_order' || value.role === 'order')
    )
      references.add(referenceKey(value.text));
    if (value.kind === 'party' && value.role === 'customer' && value.email)
      emails.add(value.email.trim().toLowerCase());
    if (value.kind === 'party' && value.role === 'supplier')
      supplierNames.add(value.name.trim().toLowerCase());
  }

  return {
    skus: [...skus],
    references: [...references],
    emails: [...emails],
    supplierNames: [...supplierNames],
  };
}

/** References compare as the record directory stores them: trimmed and upper case. */
const referenceKey = (text: string) => text.trim().toUpperCase();

const none: FactMatch = {
  state: 'not_applicable',
  record: null,
  candidates: [],
};

function fromCandidates(records: FactRecord[]): FactMatch {
  const unique = [
    ...new Map(records.map((r) => [`${r.kind}:${r.id}`, r])).values(),
  ];
  if (unique.length === 1)
    return { state: 'matched', record: unique[0]!, candidates: [] };
  if (unique.length > 1)
    return {
      state: 'ambiguous',
      record: null,
      candidates: unique.slice(0, 10),
    };

  return { state: 'unmatched', record: null, candidates: [] };
}

/**
 * Matches one fact. A line's SKU matches the catalog but names no linkable record. A supplier
 * party matches by exact name; when no name matches, the supplier a mailbox rule names for the
 * sender stands in, because the document came from that supplier.
 */
export function matchFact(value: FactValue, lookups: MatchLookups): FactMatch {
  switch (value.kind) {
    case 'line':
      if (!value.sku) return none;

      return lookups.skus.has(codeKey(value.sku))
        ? { state: 'matched', record: null, candidates: [] }
        : { state: 'unmatched', record: null, candidates: [] };
    case 'reference': {
      if (value.role !== 'purchase_order' && value.role !== 'order')
        return none;
      const key = referenceKey(value.text);

      return fromCandidates(
        lookups.references
          .filter((r) => r.kind === value.role && r.key === key)
          .map((r) => ({ kind: r.kind, id: r.id })),
      );
    }
    case 'party': {
      if (value.role === 'customer') {
        const email = value.email?.trim().toLowerCase();

        return fromCandidates(
          email
            ? lookups.customers
                .filter((c) => c.email === email)
                .map((c) => ({ kind: 'customer' as const, id: c.id }))
            : [],
        );
      }
      const named = lookups.suppliers
        .filter((s) => s.key === value.name.trim().toLowerCase())
        .map((s) => s.id);
      const ruled = new Set(lookups.ruleSuppliers);
      const preferred = named.filter((id) => ruled.has(id));
      const ids = named.length
        ? preferred.length === 1
          ? preferred
          : named
        : [...ruled];

      return fromCandidates(ids.map((id) => ({ kind: 'supplier', id })));
    }
    case 'date':
    case 'amount':
      return none;
  }
}

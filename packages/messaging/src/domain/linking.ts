/**
 * Deterministic thread links with evidence. A link is active only when its evidence names
 * exactly one record; anything that could mean several records is only suggested. A sender
 * address is evidence only when the mailbox provider authenticated it.
 */

import type { MailboxRule } from './mailbox.js';

export type RecordKind =
  'order' | 'customer' | 'supplier' | 'purchase_order' | 'case';

export type LinkMethod = 'rule' | 'address' | 'reference' | 'manual';

export type LinkState = 'active' | 'suggested' | 'removed';

interface Span {
  start: number;
  end: number;
}

export interface LinkEvidence {
  messageId: string | null;
  ruleId: string | null;
  /** Exact text that caused the link, such as an address or order number. */
  text: string | null;
  /** Position of `text` in the message text; null when it came from the subject or a rule. */
  span: Span | null;
  /**
   * The link came from a correspondent address the mailbox provider did not authenticate, so
   * it waits for a person instead of becoming active.
   */
  senderUnverified?: true;
}

export interface LinkProposal {
  kind: RecordKind;
  recordId: string;
  method: Exclude<LinkMethod, 'manual'>;
  state: 'active' | 'suggested';
  evidence: LinkEvidence;
}

export interface ReferenceToken {
  /** The text as written, without a leading `#`. */
  text: string;
  /** Upper-case comparison key. */
  key: string;
  span: Span | null;
}

const tokenPattern =
  /(?<=^|[\s([{"'“„«:,;])#?[A-Za-z0-9][A-Za-z0-9\-_/]{1,39}(?=$|[\s)\]}"'”“»:,;.!?])/g;

const tokenLimit = 50;

/**
 * Extracts reference-like tokens (order numbers, purchase-order references) from a subject and
 * message text. Tokens contain a digit; bare numbers need four digits unless written `#123`.
 * Spans point into `text`; subject tokens have no span.
 */
export function referenceTokens(subject: string, text: string) {
  const tokens = new Map<string, ReferenceToken>();
  const scan = (source: string, spans: boolean) => {
    for (const match of source.matchAll(tokenPattern)) {
      if (tokens.size >= tokenLimit) return;
      const raw = match[0];
      const hashed = raw.startsWith('#');
      const value = (hashed ? raw.slice(1) : raw).replace(/[-_/]+$/, '');
      if (value.length < (hashed ? 1 : 3) || !/\d/.test(value)) continue;
      if (!hashed && /^\d+$/.test(value) && value.length < 4) continue;
      const key = value.toUpperCase();
      if (tokens.has(key)) continue;
      const start = match.index + (hashed ? 1 : 0);
      tokens.set(key, {
        text: value,
        key,
        span: spans ? { start, end: start + value.length } : null,
      });
    }
  };
  scan(text, true);
  scan(subject, false);

  return [...tokens.values()];
}

/** Rule matches and directory lookups for one message, from which links are proposed. */
export interface LinkSignals {
  messageId: string;
  /**
   * The provider authenticated the sender (an inbound DMARC-aligned message) or the mailbox
   * sent the message itself. Otherwise the addresses are only claims.
   */
  senderVerified: boolean;
  rules: { rule: MailboxRule; address: string | null }[];
  /** Correspondent addresses with the customer profiles that have that email. */
  customers: { address: string; ids: string[] }[];
  /** Tokens with every record whose reference equals them exactly. */
  references: {
    token: ReferenceToken;
    records: { kind: RecordKind; id: string }[];
  }[];
}

/**
 * Proposes links from a message: supplier rules, customer addresses and exact references.
 * One matching record gives an active link; several give suggestions for each candidate.
 * Supplier rules and customer addresses match on addresses anyone can write into a message,
 * so from an unverified sender they are only suggested. References are text in the message
 * and follow the same rule whoever sent it.
 */
export function proposeLinks(signals: LinkSignals): LinkProposal[] {
  const proposals = new Map<string, LinkProposal>();
  const claimed = signals.senderVerified
    ? {}
    : { senderUnverified: true as const };
  const byAddress = (state: LinkProposal['state']) =>
    signals.senderVerified ? state : 'suggested';
  const add = (proposal: LinkProposal) => {
    const key = `${proposal.kind}:${proposal.recordId}`;
    const existing = proposals.get(key);
    if (
      !existing ||
      (existing.state === 'suggested' && proposal.state === 'active')
    )
      proposals.set(key, proposal);
  };
  for (const { rule, address } of signals.rules)
    if (rule.party.kind === 'supplier')
      add({
        kind: 'supplier',
        recordId: rule.party.supplierId,
        method: 'rule',
        state: byAddress('active'),
        evidence: {
          messageId: signals.messageId,
          ruleId: rule.id,
          text: address ?? rule.value,
          span: null,
          ...claimed,
        },
      });
  for (const { address, ids } of signals.customers)
    for (const id of new Set(ids))
      add({
        kind: 'customer',
        recordId: id,
        method: 'address',
        state: byAddress(new Set(ids).size === 1 ? 'active' : 'suggested'),
        evidence: {
          messageId: signals.messageId,
          ruleId: null,
          text: address,
          span: null,
          ...claimed,
        },
      });
  for (const { token, records } of signals.references) {
    const unique = [
      ...new Map(records.map((r) => [`${r.kind}:${r.id}`, r])).values(),
    ];
    for (const record of unique)
      add({
        kind: record.kind,
        recordId: record.id,
        method: 'reference',
        state: unique.length === 1 ? 'active' : 'suggested',
        evidence: {
          messageId: signals.messageId,
          ruleId: null,
          text: token.text,
          span: token.span,
        },
      });
  }

  return [...proposals.values()];
}

/**
 * How an automatic proposal changes a thread's existing link to the same record. A link
 * someone removed is never added again; a suggestion becomes active on unambiguous evidence.
 */
export function mergeLink(
  existing: { state: LinkState } | null,
  proposal: Pick<LinkProposal, 'state'>,
): 'insert' | 'activate' | 'keep' {
  if (!existing) return 'insert';
  if (existing.state === 'suggested' && proposal.state === 'active')
    return 'activate';

  return 'keep';
}

/**
 * The purchase order an inbound supplier message belongs to: the thread links exactly one
 * purchase order, and the sender matched a rule for its supplier or the thread links that
 * supplier. Otherwise null, and the message is not handed to procurement.
 */
export function handoffOrder(input: {
  links: readonly { kind: RecordKind; recordId: string; state: LinkState }[];
  supplierOf: ReadonlyMap<string, string>;
  senderSuppliers: ReadonlySet<string>;
}): string | null {
  const active = input.links.filter((link) => link.state === 'active');
  const orders = active.filter((link) => link.kind === 'purchase_order');
  if (orders.length !== 1) return null;
  const supplier = input.supplierOf.get(orders[0]!.recordId);
  if (!supplier) return null;
  const linked = active.some(
    (link) => link.kind === 'supplier' && link.recordId === supplier,
  );

  return input.senderSuppliers.has(supplier) || linked
    ? orders[0]!.recordId
    : null;
}

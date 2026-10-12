import type { ReturnAction, ReturnActionProof } from './return-actions.js';
import type { ReturnCase } from './return-cases.js';
import type { SourceRef } from './return-creations.js';
import type {
  ExchangeProof,
  ExchangeStep,
  ReturnExchange,
} from './return-exchanges.js';

interface ReadEvidence {
  observedAt: string;
  evidenceRefs: string[];
}

/** Exact Wawi order and native order-specific reservation, never an aggregate availability inference. */
interface ExchangeReservationEvidence extends ReadEvidence {
  complete: boolean;
  orders: {
    id: SourceRef;
    total: { amount: string; currency: string } | null;
    paid: boolean;
    cancelled: boolean;
    exactLines: boolean;
    quantity: string;
    reserved: string | null;
  }[];
}

/** Independent source records used by the final check. Missing reads stay null. */
export interface ExchangeConsistencyEvidence {
  shopify: ExchangeProof | null;
  price:
    | (ReadEvidence & { total: { amount: string; currency: string } | null })
    | null;
  returns:
    | (ReadEvidence & {
        complete: boolean;
        lines: {
          source: SourceRef | null;
          quantity: string;
          received: string | null;
          restocked: string | null;
        }[];
      })
    | null;
  wawi: ExchangeReservationEvidence | null;
  stock: { action: ReturnAction; proof: ReturnActionProof | null }[];
}

type ExchangeCheckId =
  | 'receipt'
  | 'inspection'
  | 'stock'
  | 'replacement'
  | 'reservation'
  | 'payment'
  | 'fulfillment';

/** An audited point-in-time verdict. Provider uncertainty always keeps an owned unresolved case. */
export interface ExchangeConsistencyReport {
  state: 'verified' | 'unresolved';
  checkedAt: string;
  ownerId: string;
  caseRevision: number;
  evidenceRefs: string[];
  checks: { id: ExchangeCheckId; verified: boolean; reason: string }[];
  replacementOrder: SourceRef | null;
  replacementTotal: { amount: string; currency: string } | null;
}
const equal = (a: SourceRef | null, b: SourceRef) =>
  a?.externalId === b.externalId && a.scopeKey === b.scopeKey;
const units = (s: string | null | undefined, n: number) =>
  s !== null && s !== undefined && Number(s) === n;
const decimal = (s: string) => {
  if (!/^\d{1,14}(?:\.\d{1,6})?$/.test(s)) return null;
  const [whole, fraction = ''] = s.split('.');

  return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
};

/** Requires complete fresh reads of both systems, exact quantities and actual settled money before closure. */
export function exchangeConsistency(
  value: ReturnCase,
  root: ReturnExchange,
  process: ExchangeStep | null,
  evidence: ExchangeConsistencyEvidence,
  now: Date,
): ExchangeConsistencyReport {
  const fresh = (e: ReadEvidence | null, since = root.startedAt) =>
    !!e &&
    e.evidenceRefs.length > 0 &&
    Number.isFinite(Date.parse(e.observedAt)) &&
    Date.parse(e.observedAt) >= Date.parse(since) &&
    Date.parse(e.observedAt) <= +now &&
    +now - Date.parse(e.observedAt) <= 300_000;
  const source = evidence.returns;
  const receipt =
    !!value.receipt &&
    value.lines.every(
      (l) =>
        value.receipt!.lines.find((r) => r.orderLineId === l.orderLineId)
          ?.received === l.quantity,
    );
  const inspection =
    receipt &&
    !!value.inspection &&
    value.lines.every((l) => {
      const i = value.inspection!.lines.find(
        (i) => i.orderLineId === l.orderLineId,
      );

      return !!i && i.resellable + i.damaged === l.quantity;
    });
  const nativeReceipt =
    fresh(source) &&
    !!source?.complete &&
    source.lines.length === root.request.lines.length &&
    root.request.lines.every((l) => {
      const matching = source!.lines.filter((s) => equal(s.source, l.source));

      return (
        matching.length === 1 &&
        units(matching[0]!.quantity, l.quantity) &&
        units(matching[0]!.received, l.quantity)
      );
    });
  // Neither an inspection note nor NOT_RESTOCKED proves disposal in the physical stock owner.
  const noWriteoff =
    inspection && value.inspection!.lines.every((l) => l.damaged === 0);
  const stock =
    nativeReceipt &&
    noWriteoff &&
    !!value.proposal &&
    value.proposal.lines.every((l) => {
      const inspected = value.inspection!.lines.find(
        (i) => i.orderLineId === l.orderLineId,
      );
      const requested = root.request.lines.find(
        (r) => r.orderLineId === l.orderLineId,
      );
      if (!inspected || !requested || l.restock !== inspected.resellable)
        return false;
      const native = source!.lines.find((s) =>
        equal(s.source, requested.source),
      );
      if (!native || !units(native.restocked, l.restock)) return false;
      if (l.restock === 0) return true;
      const records = evidence.stock.filter(
        (s) =>
          s.action.orderLineId === l.orderLineId &&
          s.action.sent &&
          s.action.kind === 'restock',
      );

      return (
        records.length === 1 &&
        records[0]!.action.connectionId ===
          root.request.replacement.wawiConnectionId &&
        records[0]!.action.plan.kind === 'restock' &&
        records[0]!.action.plan.quantity === l.restock &&
        fresh(records[0]!.proof, records[0]!.action.requestedAt) &&
        records[0]!.proof?.outcome === 'passed'
      );
    });
  const native = evidence.shopify,
    wawi = evidence.wawi;
  const shopFresh = fresh(native, process?.requestedAt ?? root.startedAt);
  const erpFresh = fresh(wawi) && !!wawi?.complete;
  const order = erpFresh && wawi!.orders.length === 1 ? wawi!.orders[0]! : null;
  const replacement =
    !!order &&
    !order.cancelled &&
    order.exactLines &&
    units(order.quantity, root.request.replacement.quantity) &&
    shopFresh &&
    native!.outcome === 'passed' &&
    !!native!.fulfillmentOrderId;
  const reservation =
    replacement && units(order!.reserved, root.request.replacement.quantity);
  const price = fresh(evidence.price, process?.requestedAt ?? root.startedAt)
    ? evidence.price?.total
    : null;
  const exactPrice =
    !!price &&
    !!order?.total &&
    price.currency === order.total.currency &&
    decimal(price.amount) !== null &&
    decimal(price.amount) === decimal(order.total.amount);
  const money =
    replacement &&
    exactPrice &&
    order!.paid &&
    (native!.payment === 'paid' ||
      (process?.plan.kind === 'process' &&
        process.plan.financial.kind === 'even' &&
        native!.payment === 'not_required'));
  const fulfillment =
    replacement && native!.fulfillmentReady && native!.paymentHoldId === null;
  const checks: ExchangeConsistencyReport['checks'] = [
    {
      id: 'receipt',
      verified: receipt && !!nativeReceipt,
      reason: !receipt
        ? 'missing_receipt'
        : !fresh(source)
          ? 'source_unavailable'
          : 'source_receipt_unverified',
    },
    { id: 'inspection', verified: inspection, reason: 'uninspected' },
    {
      id: 'stock',
      verified: !!stock,
      reason:
        !noWriteoff && inspection ? 'writeoff_unverified' : 'stock_unverified',
    },
    {
      id: 'replacement',
      verified: !!replacement,
      reason:
        !erpFresh || !shopFresh
          ? 'source_unavailable'
          : wawi!.orders.length > 1
            ? 'duplicate_replacement'
            : 'replacement_missing',
    },
    {
      id: 'reservation',
      verified: !!reservation,
      reason: 'reservation_missing',
    },
    {
      id: 'payment',
      verified: !!money,
      reason: !exactPrice ? 'price_mismatch' : 'money_unsettled',
    },
    {
      id: 'fulfillment',
      verified: !!fulfillment,
      reason: 'fulfillment_not_ready',
    },
  ];

  return {
    state: checks.every((c) => c.verified) ? 'verified' : 'unresolved',
    checkedAt: now.toISOString(),
    ownerId: value.assigneeId ?? value.openedBy,
    caseRevision: value.revision,
    checks,
    replacementOrder: order?.id ?? null,
    replacementTotal: price ?? null,
    evidenceRefs: [
      ...new Set([
        ...(native?.evidenceRefs ?? []),
        ...(source?.evidenceRefs ?? []),
        ...(evidence.price?.evidenceRefs ?? []),
        ...(wawi?.evidenceRefs ?? []),
        ...evidence.stock.flatMap((s) => s.proof?.evidenceRefs ?? []),
      ]),
    ],
  };
}

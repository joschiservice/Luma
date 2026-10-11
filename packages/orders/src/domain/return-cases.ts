import type { ReturnData } from './returns.js';

/** Why the customer sends units back, as the operator records it. */
export type ReturnCaseReason =
  | 'damaged'
  | 'defective'
  | 'wrong_item'
  | 'not_as_described'
  | 'size_or_fit'
  | 'no_longer_needed'
  | 'other';

/** What Luma proposes to settle a return with. A proposal never acts on its own. */
export type ResolutionKind =
  'refund' | 'exchange' | 'store_credit' | 'rejection';

/** What a decision rests on: a note, a link to a photo or document, or both. */
export interface DecisionEvidence {
  note: string | null;
  link: string | null;
}

/** Who decided and when. */
interface Decided {
  by: string;
  at: string;
  evidence: DecisionEvidence;
}

/** Units of one order line the customer sends back. A case has at most one line per order line. */
export interface ReturnCaseLine {
  orderLineId: string;
  /** Source title and SKU text when the case was opened; descriptive only. */
  title: string | null;
  sku: string | null;
  quantity: number;
  reason: ReturnCaseReason;
  note: string | null;
}

/** Units that physically arrived back, per case line. */
export interface Receipt extends Decided {
  lines: { orderLineId: string; received: number }[];
}

/** How the received units of each line were judged. Unreceived units are missing. */
export interface Inspection extends Decided {
  lines: { orderLineId: string; resellable: number; damaged: number }[];
}

/** The proposed settlement and how many resellable units of each line go back to stock. */
export interface Proposal extends Decided {
  kind: ResolutionKind;
  lines: { orderLineId: string; restock: number }[];
}

/**
 * Luma's own record of a return: the units requested back from one source's order lines and
 * the people's receipt, inspection and resolution decisions. Store return records stay
 * separate; `sourceReturnId` links the one this case works, if any.
 */
export interface ReturnCase {
  id: string;
  tenantId: string;
  orderId: string;
  /** The connection whose order lines the case returns. */
  connectionId: string;
  sourceReturnId: string | null;
  state: 'open' | 'cancelled';
  lines: ReturnCaseLine[];
  assigneeId: string | null;
  receipt: Receipt | null;
  inspection: Inspection | null;
  proposal: Proposal | null;
  openedBy: string;
  openedAt: string;
  cancellation: { by: string; at: string; reason: string } | null;
  revision: number;
  updatedAt: string;
}

/**
 * Where a case stands, from its decisions.
 * - `awaiting_receipt`: nothing recorded as arrived yet.
 * - `awaiting_inspection`: received units have not been judged.
 * - `awaiting_proposal`: inspected, without a proposed resolution.
 * - `proposed`: a resolution is proposed; acting on it is a separate, governed step.
 */
export type ReturnCaseStage =
  | 'awaiting_receipt'
  | 'awaiting_inspection'
  | 'awaiting_proposal'
  | 'proposed'
  | 'cancelled';

/** Derives a case's stage from its state and the decisions recorded so far. */
export function returnCaseStage(value: ReturnCase): ReturnCaseStage {
  if (value.state === 'cancelled') return 'cancelled';
  if (!value.receipt) return 'awaiting_receipt';
  if (!value.inspection) return 'awaiting_inspection';

  return value.proposal ? 'proposed' : 'awaiting_proposal';
}

/** Raised when a request breaks a return case rule; `code` maps to the HTTP status. */
export class ReturnCaseError extends Error {
  constructor(
    readonly code: 'invalid' | 'conflict' | 'not_found',
    message: string,
  ) {
    super(message);
    this.name = 'ReturnCaseError';
  }
}

const invalid = (message: string) => new ReturnCaseError('invalid', message);

const conflict = (message: string) => new ReturnCaseError('conflict', message);

/** One order line of one source, as the order snapshot reports it. */
export interface ReturnableLine {
  id: string;
  /** Originally ordered units as a decimal string. */
  quantity: string;
  cancelledQuantity: string | null;
}

/** A store return of the same order, from its current snapshot. */
export interface StoreReturn {
  entityId: string;
  connectionId: string;
  status: ReturnData['status'];
  lines: { orderLineId: string | null; quantity: string }[];
}

/** How many units of an order line are spoken for, and how many can still be returned. */
export interface LineAvailability {
  ordered: number;
  inCases: number;
  inStoreReturns: number;
  returnable: number;
}

const units = (value: string | null | undefined) => {
  const parsed = Number(value ?? '0');

  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

/**
 * Counts each unit of an order line once. Non-cancelled cases count their requested units.
 * A store return counts only while no open case links it, because the linking case already
 * counts those units; declined and cancelled store returns count nothing. Ordered units exclude
 * units the source cancelled before fulfillment.
 */
export function lineAvailability(
  lines: ReturnableLine[],
  cases: ReturnCase[],
  storeReturns: StoreReturn[],
  excludeCaseId?: string,
): Map<string, LineAvailability> {
  const counted = cases.filter(
    (c) => c.state !== 'cancelled' && c.id !== excludeCaseId,
  );
  const linked = new Set(counted.map((c) => c.sourceReturnId));
  const result = new Map<string, LineAvailability>();
  for (const line of lines) {
    const ordered = Math.max(
      0,
      units(line.quantity) - units(line.cancelledQuantity),
    );
    const inCases = counted
      .flatMap((c) => c.lines)
      .filter((l) => l.orderLineId === line.id)
      .reduce((sum, l) => sum + l.quantity, 0);
    const inStoreReturns = storeReturns
      .filter(
        (r) =>
          !linked.has(r.entityId) &&
          !['declined', 'cancelled'].includes(r.status),
      )
      .flatMap((r) => r.lines)
      .filter((l) => l.orderLineId === line.id)
      .reduce((sum, l) => sum + units(l.quantity), 0);
    result.set(line.id, {
      ordered,
      inCases,
      inStoreReturns,
      returnable: Math.max(0, ordered - inCases - inStoreReturns),
    });
  }

  return result;
}

const count = (value: number) => Number.isSafeInteger(value) && value >= 0;

/**
 * Checks the lines of a new case against what is still returnable. A linked store return's own
 * units are available to the case that links it, so `availability` must be computed without
 * that return. Each order line appears at most once, with whole units.
 */
export function checkOpenLines(
  lines: ReturnCaseLine[],
  availability: Map<string, LineAvailability>,
) {
  if (!lines.length) throw invalid('Choose at least one line to return.');
  if (new Set(lines.map((l) => l.orderLineId)).size !== lines.length)
    throw invalid('Each order line can appear only once.');
  for (const line of lines) {
    const available = availability.get(line.orderLineId);
    if (!available) throw invalid('A line is not part of this order.');
    if (!count(line.quantity) || line.quantity < 1)
      throw invalid('Return whole units, at least one per line.');
    if (line.quantity > available.returnable)
      throw conflict(
        `Only ${available.returnable} of ${available.ordered} units of a line can still be returned. Other returns already cover the rest.`,
      );
  }
}

function sameLines(
  value: ReturnCase,
  lines: { orderLineId: string }[],
): Map<string, ReturnCaseLine> {
  const byId = new Map(value.lines.map((l) => [l.orderLineId, l]));
  if (
    lines.length !== byId.size ||
    new Set(lines.map((l) => l.orderLineId)).size !== lines.length ||
    lines.some((l) => !byId.has(l.orderLineId))
  )
    throw invalid('Record every line of the case exactly once.');

  return byId;
}

function requireOpen(value: ReturnCase) {
  if (value.state !== 'open')
    throw conflict('This return case is cancelled. Open a new case instead.');
}

/**
 * Records what arrived. A new receipt replaces the earlier one and clears the inspection and
 * proposal that relied on it; the earlier decisions stay in the case history.
 */
export function recordReceipt(value: ReturnCase, receipt: Receipt): ReturnCase {
  requireOpen(value);
  const byId = sameLines(value, receipt.lines);
  for (const line of receipt.lines)
    if (
      !count(line.received) ||
      line.received > byId.get(line.orderLineId)!.quantity
    )
      throw invalid('Received units must be whole and no more than requested.');

  return { ...value, receipt, inspection: null, proposal: null };
}

/**
 * Splits each line's received units into resellable and damaged ones. Requested units that did
 * not arrive are missing and can't be judged. Clears an earlier proposal.
 */
export function recordInspection(
  value: ReturnCase,
  inspection: Inspection,
): ReturnCase {
  requireOpen(value);
  if (!value.receipt)
    throw conflict('Record what arrived before inspecting it.');
  sameLines(value, inspection.lines);
  const received = new Map(
    value.receipt.lines.map((l) => [l.orderLineId, l.received]),
  );
  for (const line of inspection.lines)
    if (
      !count(line.resellable) ||
      !count(line.damaged) ||
      line.resellable + line.damaged !== received.get(line.orderLineId)
    )
      throw invalid(
        'Judge every received unit as resellable or damaged, in whole units.',
      );

  return { ...value, inspection, proposal: null };
}

/**
 * Proposes how to settle the return. Only resellable units can be proposed for restock, so a
 * damaged or missing unit never becomes sellable stock through a proposal. A rejection sends
 * the items back to the customer and restocks nothing.
 */
export function proposeResolution(
  value: ReturnCase,
  proposal: Proposal,
): ReturnCase {
  requireOpen(value);
  if (!value.inspection)
    throw conflict('Inspect the received units before proposing a resolution.');
  sameLines(value, proposal.lines);
  const resellable = new Map(
    value.inspection.lines.map((l) => [l.orderLineId, l.resellable]),
  );
  for (const line of proposal.lines) {
    if (!count(line.restock)) throw invalid('Restock whole units only.');
    if (line.restock > resellable.get(line.orderLineId)!)
      throw conflict(
        'Only units inspected as resellable can be restocked. Damaged and missing units can’t.',
      );
    if (proposal.kind === 'rejection' && line.restock > 0)
      throw invalid(
        'A rejected return goes back to the customer and restocks nothing.',
      );
  }

  return { ...value, proposal };
}

/** Cancels the case; its units count as returnable again. */
export function cancelCase(
  value: ReturnCase,
  cancellation: NonNullable<ReturnCase['cancellation']>,
): ReturnCase {
  requireOpen(value);

  return { ...value, state: 'cancelled', cancellation };
}

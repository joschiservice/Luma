import type {
  Attention,
  Commitment,
  CommitmentKind,
  FollowUp,
} from './commitments.js';
import type { PurchaseOrder } from './procurement.js';

const hour = 3_600_000;

/** Furthest ahead, in days, a person may schedule the next check of a follow-up. */
const followUpHorizonDays = 60;

/**
 * Why a person's response to `attention` can't be recorded, or null when it can. Only changed
 * commitments, overdue confirmations or deliveries and receipt differences take a response here;
 * only changes and differences can be accepted, only differences credited or written off, and a
 * follow-up needs a check time after `now` (epoch ms) within the horizon.
 */
export function followUpResponseError(
  attention: Pick<Attention, 'kind'> | undefined,
  request: { response: FollowUp['response']; nextCheckAt: string | null },
  now: number,
): string | null {
  if (!attention) return 'This no longer needs a response. Refresh the order.';
  if (
    ![
      'commitment_changed',
      'confirmation_overdue',
      'delivery_overdue',
      'receipt_difference',
    ].includes(attention.kind)
  )
    return 'Respond to this from its own review.';
  if (
    request.response === 'accepted' &&
    !['commitment_changed', 'receipt_difference'].includes(attention.kind)
  )
    return 'Record a follow-up and when to check again.';
  if (
    ['credited', 'written_off'].includes(request.response) &&
    attention.kind !== 'receipt_difference'
  )
    return 'Only a received-goods difference can be credited or written off.';
  if (request.response === 'following_up') {
    const next = request.nextCheckAt ? Date.parse(request.nextCheckAt) : NaN;
    if (!(next > now) || next > now + followUpHorizonDays * 24 * hour)
      return 'Choose when to check again, within the next 60 days.';
  }

  return null;
}

/** The last confirmed commitment of `kind` on a line, in recorded order. */
export function lastConfirmed(
  commitments: Commitment[],
  lineId: string,
  kind: CommitmentKind,
) {
  return commitments
    .filter(
      (c) => c.lineId === lineId && c.kind === kind && c.status === 'confirmed',
    )
    .at(-1);
}

/** A manual receipt, shortage or damage count a person records against an order line. */
export interface ManualReceipt {
  lineId: string;
  kind: 'received' | 'shortage' | 'damaged';
  /** Cumulative quantity for the line. */
  quantity: number;
  /** The commitment of this kind the person saw last; null when there was none. */
  expectedCommitmentId: string | null;
  /** Damaged units recorded together with a receipt. */
  damagedQuantity?: number | undefined;
  /** The damaged count the person saw last, when recording damaged units with a receipt. */
  expectedDamagedCommitmentId?: string | null | undefined;
  receivedAt: string;
}

/**
 * Why a manual receipt can't be recorded, or null when it can. Only open Luma orders take manual
 * receipts, on an existing line and not in the future (`now`, epoch ms). Receipts of orders a
 * purchasing system owns are recorded there. The counts the person saw must still be current, and
 * damaged units can't exceed the receipt.
 */
export function manualReceiptError(input: {
  order: Pick<PurchaseOrder, 'authority' | 'status' | 'lines'>;
  request: ManualReceipt;
  now: number;
  /** The supplier is linked to a purchasing system or the order was sent through one. */
  purchasingSystemOwned: boolean;
  commitments: Commitment[];
}): string | null {
  const { order, request, commitments } = input;
  if (order.authority !== 'luma' || order.status !== 'open')
    return 'Only an open Luma purchase order can be reconciled.';
  if (!order.lines.some((line) => line.id === request.lineId))
    return 'That order line does not exist.';
  if (Date.parse(request.receivedAt) > input.now)
    return 'Receipt time cannot be in the future.';
  if (request.kind === 'received' && input.purchasingSystemOwned)
    return 'Record receipt in the purchasing system that owns this order.';
  const latest = lastConfirmed(commitments, request.lineId, request.kind);
  if ((latest?.id ?? null) !== request.expectedCommitmentId)
    return 'This quantity changed. Refresh the order before recording it.';
  const receipt = lastConfirmed(commitments, request.lineId, 'received');
  const damaged = lastConfirmed(commitments, request.lineId, 'damaged');
  if (
    request.kind === 'received' &&
    request.damagedQuantity !== undefined &&
    (damaged?.id ?? null) !== request.expectedDamagedCommitmentId
  )
    return 'Damaged quantities changed. Refresh the order before recording receipt.';
  if (request.kind === 'damaged' && request.quantity > (receipt?.quantity ?? 0))
    return 'Damaged units cannot exceed the recorded receipt.';
  if (
    request.kind === 'received' &&
    request.damagedQuantity !== undefined &&
    request.damagedQuantity > request.quantity
  )
    return 'Damaged units cannot exceed the receipt.';
  if (
    request.kind === 'received' &&
    request.quantity < (request.damagedQuantity ?? damaged?.quantity ?? 0)
  )
    return 'Receipt cannot be less than the recorded damaged units.';

  return null;
}

/**
 * Units still to source for one line after a supplier change or receipt difference: what a
 * lower confirmation leaves out, the short or damaged units, or otherwise what is outstanding.
 */
export function shortfallQuantity(
  fact: Pick<Commitment, 'kind' | 'quantity'> | undefined,
  line: { ordered: number; outstanding: number },
) {
  return fact?.kind === 'confirmed_quantity'
    ? Math.max(0, line.ordered - (fact.quantity ?? line.ordered))
    : fact?.kind === 'shortage' || fact?.kind === 'damaged'
      ? (fact.quantity ?? 0)
      : line.outstanding;
}

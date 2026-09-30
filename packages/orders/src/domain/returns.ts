export interface CanonicalMoney {
  amount: string;
  currency: string;
}

/** A return with canonical order line references. Receipt quantities are null when unreported. */
export interface ReturnData {
  type: 'return';
  orderId: string;
  name: string | null;
  status:
    'requested' | 'open' | 'closed' | 'declined' | 'cancelled' | 'unknown';
  requestedAt: string | null;
  approvedAt: string | null;
  closedAt: string | null;
  declineReason: 'return_period_ended' | 'final_sale' | 'other' | null;
  receivedAt: string | null;
  lines: {
    orderLineId: string | null;
    quantity: string;
    unit: string;
    reason: string | null;
    receivedQuantity: string | null;
    restockedQuantity: string | null;
    refundedQuantity: string | null;
    value: CanonicalMoney | null;
  }[];
}

/** A refund with its payment attempts; only successful transactions returned money. */
export interface RefundData {
  type: 'refund';
  orderId: string;
  returnId: string | null;
  createdAt: string | null;
  total: CanonicalMoney | null;
  lines: {
    orderLineId: string;
    quantity: string;
    unit: string;
    restock: 'return' | 'cancel' | 'no_restock' | 'unknown';
    restocked: boolean;
  }[];
  transactions: {
    status: 'success' | 'pending' | 'failed' | 'unknown';
    amount: CanonicalMoney;
    processedAt: string | null;
    gateway: string | null;
  }[];
}

/**
 * Where a return or a refund without a return stands.
 * - `requested`: the customer asked for a return; the merchant has not decided.
 * - `awaiting_items`: approved, but not every unit has been received back.
 * - `awaiting_refund`: units remain that the source has not refunded.
 * - `refund_pending`: a refund payment is still processing; the money has not arrived.
 * - `refund_failed`: refund payments failed and none succeeded or is still processing.
 * - `ready_to_close`: received and refunded, but the return is still open.
 * - `refunded`, `refund_recorded`: final states of a refund without a return; a recorded
 *   refund has no successful payment, for example a restock without money back.
 */
export type ReturnStage =
  | 'requested'
  | 'awaiting_items'
  | 'awaiting_refund'
  | 'refund_pending'
  | 'refund_failed'
  | 'ready_to_close'
  | 'closed'
  | 'declined'
  | 'cancelled'
  | 'refunded'
  | 'refund_recorded'
  | 'unknown';

/**
 * Refund state from payment evidence. `recorded` means the source recorded a refund without a
 * successful, pending or failed payment; it is never money returned.
 */
export type RefundState =
  'none' | 'recorded' | 'pending' | 'failed' | 'partial' | 'refunded';

/** Who the next step belongs to: a person, someone else (customer or payment provider), or nobody. */
export type StageGroup = 'action' | 'waiting' | 'done';

export const stageGroups: Record<ReturnStage, StageGroup> = {
  requested: 'action',
  awaiting_refund: 'action',
  refund_failed: 'action',
  ready_to_close: 'action',
  awaiting_items: 'waiting',
  refund_pending: 'waiting',
  unknown: 'waiting',
  closed: 'done',
  declined: 'done',
  cancelled: 'done',
  refunded: 'done',
  refund_recorded: 'done',
};

/** Money totals in one currency; amounts are null when the refunds use several currencies. */
export interface RefundTotals {
  currency: string | null;
  /** Sum of successful refund payments: money actually returned. */
  refunded: string | null;
  /** Sum of refund payments still processing. */
  pending: string | null;
  failedAttempts: number;
}

export interface ReturnProgress extends RefundTotals {
  stage: ReturnStage;
  group: StageGroup;
  refund: RefundState;
  /** Units requested for return; null for a refund without a return. */
  quantity: string | null;
  /** Units received back; null when the source does not report receipt. */
  received: string | null;
  /** Units the source reports as refunded; null when unreported. */
  refundedUnits: string | null;
  /** Value of the returned units; null when unreported or in several currencies. */
  value: CanonicalMoney | null;
}

const scale = 1_000_000n;

/** Parses a canonical decimal string into millionths. */
export function toUnits(value: string): bigint {
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace('-', '').split('.');
  const units = BigInt(whole!) * scale + BigInt(fraction.padEnd(6, '0'));

  return negative ? -units : units;
}

/** Formats millionths as the shortest canonical decimal string. */
export function fromUnits(units: bigint): string {
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const whole = absolute / scale;
  const fraction = (absolute % scale).toString().padStart(6, '0');
  const trimmed = fraction.replace(/0+$/, '');

  return `${negative ? '-' : ''}${whole}${trimmed ? `.${trimmed}` : ''}`;
}

function sum(values: (string | null)[]): string | null {
  if (values.some((value) => value === null)) return null;

  return fromUnits(
    values.reduce((total, value) => total + toUnits(value!), 0n),
  );
}

/** Adds amounts of one currency; returns null when currencies differ or nothing was given. */
function sumMoney(values: CanonicalMoney[]): CanonicalMoney | null {
  const currency = values[0]?.currency;
  if (!currency || values.some((value) => value.currency !== currency))
    return null;

  return {
    amount: fromUnits(
      values.reduce((total, value) => total + toUnits(value.amount), 0n),
    ),
    currency,
  };
}

/** Sums refund payments by outcome. Pending and failed payments never count as refunded. */
export function refundTotals(refunds: RefundData[]): RefundTotals {
  const transactions = refunds.flatMap((refund) => refund.transactions);
  const currencies = new Set(
    transactions.map((transaction) => transaction.amount.currency),
  );
  const failedAttempts = transactions.filter(
    (transaction) => transaction.status === 'failed',
  ).length;
  if (currencies.size > 1)
    return { currency: null, refunded: null, pending: null, failedAttempts };
  const total = (status: 'success' | 'pending') => {
    const selected = transactions.filter((t) => t.status === status);

    return selected.length
      ? fromUnits(
          selected.reduce((value, t) => value + toUnits(t.amount.amount), 0n),
        )
      : null;
  };

  return {
    currency: [...currencies][0] ?? null,
    refunded: total('success'),
    pending: total('pending'),
    failedAttempts,
  };
}

/**
 * Classifies refunds by payment evidence. Money counts as returned only through successful
 * payments; `fullyRefunded` decides between partial and complete refunds.
 */
function refundState(
  refunds: RefundData[],
  totals: RefundTotals,
  fullyRefunded: boolean,
): RefundState {
  if (!refunds.length) return 'none';
  const transactions = refunds.flatMap((refund) => refund.transactions);
  if (transactions.some((t) => t.status === 'pending')) return 'pending';
  if (transactions.some((t) => t.status === 'success'))
    return fullyRefunded || totals.currency === null ? 'refunded' : 'partial';
  if (totals.failedAttempts) return 'failed';

  return 'recorded';
}

/**
 * Derives a return's stage and refund state from its latest source snapshot and the refunds the
 * source links to it. A requested or recorded refund is never treated as money returned.
 */
export function returnProgress(
  value: ReturnData,
  refunds: RefundData[],
): ReturnProgress {
  const totals = refundTotals(refunds);
  const quantity = sum(value.lines.map((line) => line.quantity)) ?? '0';
  const received = sum(value.lines.map((line) => line.receivedQuantity));
  const refundedUnits = sum(value.lines.map((line) => line.refundedQuantity));
  const lineValues = value.lines.map((line) => line.value);
  const unitsRefunded =
    refundedUnits !== null && toUnits(refundedUnits) >= toUnits(quantity);
  const refund = refundState(
    refunds,
    totals,
    refundedUnits === null ? true : unitsRefunded,
  );
  const stage = ((): ReturnStage => {
    if (value.status !== 'open') return value.status;
    if (refund === 'failed') return 'refund_failed';
    if (refund === 'pending') return 'refund_pending';
    if (received !== null && toUnits(received) < toUnits(quantity))
      return 'awaiting_items';
    if (refundedUnits !== null)
      return unitsRefunded ? 'ready_to_close' : 'awaiting_refund';

    return refund === 'none' ? 'awaiting_refund' : 'ready_to_close';
  })();

  return {
    ...totals,
    stage,
    group: stageGroups[stage],
    refund,
    quantity,
    received,
    refundedUnits,
    value: lineValues.every((money) => money !== null)
      ? sumMoney(lineValues as CanonicalMoney[])
      : null,
  };
}

/** Derives the stage of a refund that no known return links to. */
export function refundProgress(value: RefundData): ReturnProgress {
  const totals = refundTotals([value]);
  const refund = refundState([value], totals, true);
  const stage: ReturnStage =
    refund === 'pending'
      ? 'refund_pending'
      : refund === 'refunded'
        ? 'refunded'
        : refund === 'failed'
          ? 'refund_failed'
          : 'refund_recorded';

  return {
    ...totals,
    stage,
    group: stageGroups[stage],
    refund,
    quantity: null,
    received: null,
    refundedUnits: value.lines.length
      ? sum(value.lines.map((line) => line.quantity))
      : null,
    value: null,
  };
}

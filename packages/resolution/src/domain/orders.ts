// Order progress follows `orderMetricDefinitions` v1 so the Orders workspace and the order
// metrics classify the same order the same way. Keep this file and the list SQL in step.

export type FulfillmentState =
  'unfulfilled' | 'partial' | 'fulfilled' | 'not_required' | 'no_lines';

export interface OrderLineFacts {
  id: string;
  skuId: string | null;
  quantity: string;
  cancelledQuantity: string | null;
}

export interface LineProgress {
  fulfilledQuantity: string;
  /** Null when the source does not report cancellations and the line is not fully fulfilled. */
  remainingQuantity: string | null;
}

const scale = 1_000_000n;

function units(value: string): bigint {
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace('-', '').split('.');
  const amount = BigInt(whole!) * scale + BigInt(fraction.padEnd(6, '0'));

  return negative ? -amount : amount;
}

function decimal(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const fraction = (absolute % scale).toString().padStart(6, '0');
  const trimmed = fraction.replace(/0+$/, '');

  return `${negative ? '-' : ''}${absolute / scale}${trimmed ? `.${trimmed}` : ''}`;
}

/** Adds decimal quantity strings without floating-point rounding. */
export function sumQuantities(values: string[]): string {
  return decimal(values.reduce((total, value) => total + units(value), 0n));
}

/**
 * Computes each line's fulfilled and remaining quantity from fulfilled quantities of the same
 * source. A line is done once fulfilled quantity reaches the ordered quantity.
 */
export function lineProgress(
  line: OrderLineFacts,
  fulfilled: string | undefined,
): LineProgress {
  const quantity = units(line.quantity);
  const done = units(fulfilled ?? '0');
  if (done >= quantity)
    return { fulfilledQuantity: decimal(done), remainingQuantity: '0' };
  if (line.cancelledQuantity === null)
    return { fulfilledQuantity: decimal(done), remainingQuantity: null };

  return {
    fulfilledQuantity: decimal(done),
    remainingQuantity: decimal(quantity - units(line.cancelledQuantity) - done),
  };
}

/** Summarizes fulfillment across lines; cancelled lines with nothing fulfilled need no work. */
export function fulfillmentState(progress: LineProgress[]): FulfillmentState {
  if (!progress.length) return 'no_lines';
  const outstanding = progress.some(
    (line) =>
      line.remainingQuantity === null || units(line.remainingQuantity) > 0n,
  );
  const fulfilled = progress.some((line) => units(line.fulfilledQuantity) > 0n);
  if (outstanding) return fulfilled ? 'partial' : 'unfulfilled';

  return fulfilled ? 'fulfilled' : 'not_required';
}

/**
 * Returns whether an order has remaining fulfillment work, or null when unknown. Completed,
 * cancelled and removed orders have none; other non-open statuses are unknown.
 */
export function orderOpen(
  order: { status: string; deleted: boolean },
  progress: LineProgress[],
): boolean | null {
  if (
    order.deleted ||
    order.status === 'completed' ||
    order.status === 'cancelled'
  )
    return false;
  if (order.status !== 'open' || !progress.length) return null;
  if (
    progress.some(
      (line) =>
        line.remainingQuantity !== null && units(line.remainingQuantity) > 0n,
    )
  )
    return true;

  return progress.some((line) => line.remainingQuantity === null)
    ? null
    : false;
}

/** Returns whether an open order is past its source deadline, or null when unknown. */
export function orderOverdue(
  open: boolean | null,
  dueAt: string | null,
  asOf: string,
): boolean | null {
  if (open === false) return false;
  if (open === null || dueAt === null) return null;

  return Date.parse(dueAt) < Date.parse(asOf);
}

export interface ComparableSource {
  connectionId: string;
  deleted: boolean;
  status: string;
  paymentStatus: string;
  total: { amount: string; currency: string } | null;
  lines: OrderLineFacts[];
}

export interface OrderDifference {
  field: 'status' | 'paymentStatus' | 'total' | 'lines';
  values: { connectionId: string; value: string | null }[];
}

/** Describes ordered quantity per mapped SKU; unmapped lines are grouped together. */
function lineSignature(lines: OrderLineFacts[]): string {
  const totals = new Map<string, string[]>();
  for (const line of lines) {
    const key = line.skuId ?? 'unmapped';
    totals.set(key, [...(totals.get(key) ?? []), line.quantity]);
  }

  return [...totals.entries()]
    .map(([key, values]) => `${key}:${sumQuantities(values)}`)
    .sort()
    .join(',');
}

/**
 * Lists fields whose known values disagree between current, non-removed sources. Unknown
 * values never count as a disagreement. Display numbers and dates are not compared because
 * systems number and timestamp the same order independently.
 */
export function orderDifferences(
  sources: ComparableSource[],
): OrderDifference[] {
  const active = sources.filter((source) => !source.deleted);
  if (active.length < 2) return [];
  const fields: {
    field: OrderDifference['field'];
    value: (source: ComparableSource) => string | null;
  }[] = [
    {
      field: 'status',
      value: (source) => (source.status === 'unknown' ? null : source.status),
    },
    {
      field: 'paymentStatus',
      value: (source) =>
        source.paymentStatus === 'unknown' ? null : source.paymentStatus,
    },
    {
      field: 'total',
      value: (source) =>
        source.total
          ? `${sumQuantities([source.total.amount])} ${source.total.currency}`
          : null,
    },
    { field: 'lines', value: (source) => lineSignature(source.lines) },
  ];

  return fields.flatMap(({ field, value }) => {
    const values = active.map((source) => ({
      connectionId: source.connectionId,
      value: value(source),
    }));
    const known = new Set(
      values.flatMap((entry) => (entry.value === null ? [] : [entry.value])),
    );

    return known.size > 1 ? [{ field, values }] : [];
  });
}

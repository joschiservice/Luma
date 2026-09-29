import type {
  OrderDetail,
  OrderListItem,
  OrderSort,
  OrderView,
} from '@luma/api-contract';

export const viewLabels: Record<OrderView, string> = {
  all: 'All orders',
  outstanding: 'Outstanding',
  overdue: 'Overdue',
  needs_you: 'Needs you',
  differs: 'Differs by source',
};

export const viewDescriptions: Record<OrderView, string> = {
  all: 'Every current order from your connected sources.',
  outstanding: 'Open orders with units still to fulfill.',
  overdue: 'Outstanding orders past their source deadline.',
  needs_you: 'Orders linked to an issue that needs a decision or review.',
  differs:
    'Orders whose status, payment, total or ordered items disagree between sources.',
};

export const statusLabels: Record<string, string> = {
  open: 'Open',
  completed: 'Completed',
  cancelled: 'Cancelled',
  unknown: 'Status unknown',
};

export const paymentLabels: Record<string, string> = {
  pending: 'Payment pending',
  authorized: 'Authorized',
  paid: 'Paid',
  partially_refunded: 'Partially refunded',
  refunded: 'Refunded',
  failed: 'Payment failed',
  unknown: 'Payment unknown',
};

export const fulfillmentLabels: Record<string, string> = {
  unfulfilled: 'Unfulfilled',
  partial: 'Partially fulfilled',
  fulfilled: 'Fulfilled',
  not_required: 'Nothing to fulfill',
  no_lines: 'No lines',
};

export const shipmentLabels: Record<string, string> = {
  pending: 'Pending',
  processing: 'Processing',
  completed: 'Completed',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  failed: 'Failed',
  unknown: 'Status unknown',
};

const statusPhrases: Record<string, string> = {
  open: 'open',
  completed: 'completed',
  cancelled: 'cancelled',
};

const paymentPhrases: Record<string, string> = {
  pending: 'payment is pending',
  authorized: 'payment is authorized',
  paid: 'it is paid',
  partially_refunded: 'it is partially refunded',
  refunded: 'it is refunded',
  failed: 'payment failed',
};

export const sortLabels: Record<OrderSort, string> = {
  updated: 'Last updated',
  placed: 'Placed date',
  number: 'Order number',
  due: 'Due date',
};

export const differenceLabels: Record<string, string> = {
  status: 'Status',
  paymentStatus: 'Payment',
  total: 'Total',
  lines: 'Ordered items',
};

/**
 * Labels fulfillment progress. Closed orders without reported fulfillment work say so instead
 * of reading as unfulfilled.
 */
export function fulfillmentLabel(
  order: Pick<OrderListItem, 'fulfillment' | 'open'>,
) {
  return order.open === false && order.fulfillment === 'unfulfilled'
    ? 'None reported'
    : (fulfillmentLabels[order.fulfillment] ?? order.fulfillment);
}

/** Names an order by its source number, falling back to a short Luma ID. */
export function orderLabel(order: Pick<OrderListItem, 'id' | 'displayNumber'>) {
  return order.displayNumber ?? `Order ${order.id.slice(0, 8)}`;
}

/** Formats a source amount in its currency without converting between currencies. */
export function formatMoney(
  money: { amount: string; currency: string } | null,
  locale?: string,
) {
  if (!money) return null;
  const amount = Number(money.amount);
  if (!Number.isFinite(amount)) return `${money.amount} ${money.currency}`;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: money.currency,
    }).format(amount);
  } catch {
    return `${money.amount} ${money.currency}`;
  }
}

/** Shows a quantity with its unit; the common "each" unit is implied. */
export function formatQuantity(quantity: string, unit: string) {
  return unit === 'each' ? quantity : `${quantity} ${unit}`;
}

function add(values: string[]) {
  return values.reduce((total, value) => total + Number(value), 0);
}

function plural(count: number, one: string, many = `${one}s`) {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

/**
 * Explains an order's current state and outstanding work in short sentences, using the source
 * shown in the list and naming disagreements between sources.
 */
export function orderSummary(
  detail: Pick<
    OrderDetail,
    'order' | 'sources' | 'differences' | 'fulfillments' | 'issues'
  >,
  date: (value: string) => string,
): string[] {
  const source =
    detail.sources.find((item) => item.selected) ?? detail.sources[0];
  if (!source) return [];
  const label = (connectionId: string) =>
    detail.sources.find((item) => item.connectionId === connectionId)?.label ??
    'A source';
  const lines: string[] = [];
  if (source.deleted) lines.push(`${source.label} removed this order.`);
  lines.push(
    `${source.label} reports the order as ${statusPhrases[source.status] ?? 'in an unknown status'}, and ${paymentPhrases[source.paymentStatus] ?? 'the payment status is unknown'}.`,
  );
  const remaining = source.lines.flatMap((line) =>
    line.remainingQuantity === null ? [] : [line.remainingQuantity],
  );
  const unknown = source.lines.filter(
    (line) => line.remainingQuantity === null,
  );
  const open = add(remaining.filter((value) => Number(value) > 0));
  if (detail.order.open === false) lines.push('No fulfillment work remains.');
  else if (open > 0)
    lines.push(
      `${plural(open, 'unit')} still to fulfill across ${plural(
        source.lines.filter((line) => Number(line.remainingQuantity) > 0)
          .length,
        'line',
      )}.`,
    );
  if (unknown.length && detail.order.open !== false)
    lines.push(
      `Remaining work is unknown for ${plural(unknown.length, 'line')} because ${source.label} does not report cancelled quantities. ${add(unknown.map((line) => line.fulfilledQuantity)).toLocaleString()} of ${add(unknown.map((line) => line.quantity)).toLocaleString()} units are fulfilled.`,
    );
  if (detail.order.overdue && detail.order.dueAt)
    lines.push(`Past its source deadline of ${date(detail.order.dueAt)}.`);
  for (const fulfillment of detail.fulfillments)
    if (!fulfillment.deleted && fulfillment.status === 'failed')
      lines.push(
        `A fulfillment in ${label(fulfillment.connectionId)} failed${fulfillment.failureCode ? ` (${fulfillment.failureCode})` : ''}.`,
      );
  const needsYou = detail.issues.filter((issue) => issue.needsYou).length;
  const openIssues = detail.issues.filter(
    (issue) => issue.state !== 'resolved',
  ).length;
  if (needsYou)
    lines.push(
      `${plural(needsYou, 'issue')} ${needsYou === 1 ? 'needs' : 'need'} you.`,
    );
  else if (openIssues)
    lines.push(
      `${plural(openIssues, 'linked issue')} ${openIssues === 1 ? 'is' : 'are'} still open.`,
    );
  for (const difference of detail.differences)
    lines.push(
      `${differenceLabels[difference.field] ?? difference.field} differs: ${[
        ...difference.values,
      ]
        .sort(
          (left, right) =>
            Number(right.connectionId === source.connectionId) -
            Number(left.connectionId === source.connectionId),
        )
        .map(
          (entry) =>
            `${label(entry.connectionId)} ${
              difference.field === 'status'
                ? (statusLabels[entry.value ?? ''] ?? 'unknown').toLowerCase()
                : difference.field === 'paymentStatus'
                  ? (
                      paymentLabels[entry.value ?? ''] ?? 'unknown'
                    ).toLowerCase()
                  : difference.field === 'lines'
                    ? 'reports different quantities'
                    : (entry.value ?? 'unknown')
            }`,
        )
        .join('; ')}.`,
    );

  return lines;
}

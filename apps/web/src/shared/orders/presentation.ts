import type {
  OrderDetail,
  OrderListItem,
  OrderSort,
  OrderView,
} from '@luma/api-contract';
import { formatCurrency, formatList, formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { isPieceUnit, quantityWithUnit } from '@luma/ui/lib/units';

/**
 * Builds a label map whose values are read from the message catalog on each access, so a map
 * defined at module scope still follows the active language. Missing keys stay undefined.
 */
export function localizedLabels<K extends string>(
  messages: Record<K, () => string>,
): Record<K, string> {
  const labels = {} as Record<K, string>;
  for (const [key, message] of Object.entries(messages) as [K, () => string][])
    Object.defineProperty(labels, key, { get: message, enumerable: true });

  return labels;
}

export const viewLabels: Record<OrderView, string> = localizedLabels({
  stuck: m.orders_view_stuck,
  all: m.orders_view_all,
  outstanding: m.orders_view_outstanding,
  overdue: m.orders_view_overdue,
  needs_you: m.orders_view_needs_you,
  differs: m.orders_view_differs,
});

export const viewDescriptions: Record<OrderView, string> = localizedLabels({
  stuck: m.orders_view_stuck_description,
  all: m.orders_view_all_description,
  outstanding: m.orders_view_outstanding_description,
  overdue: m.orders_view_overdue_description,
  needs_you: m.orders_view_needs_you_description,
  differs: m.orders_view_differs_description,
});

export const statusLabels: Record<string, string> = localizedLabels({
  open: m.orders_status_open,
  completed: m.orders_status_completed,
  cancelled: m.orders_status_cancelled,
  unknown: m.orders_status_unknown,
});

export const paymentLabels: Record<string, string> = localizedLabels({
  pending: m.orders_payment_pending,
  authorized: m.orders_payment_authorized,
  paid: m.orders_payment_paid,
  partially_refunded: m.orders_payment_partially_refunded,
  refunded: m.orders_payment_refunded,
  failed: m.orders_payment_failed,
  unknown: m.orders_payment_unknown,
});

export const fulfillmentLabels: Record<string, string> = localizedLabels({
  unfulfilled: m.orders_fulfillment_unfulfilled,
  partial: m.orders_fulfillment_partial,
  fulfilled: m.orders_fulfillment_fulfilled,
  not_required: m.orders_fulfillment_not_required,
  no_lines: m.orders_fulfillment_no_lines,
});

export const shipmentLabels: Record<string, string> = localizedLabels({
  pending: m.orders_shipment_pending,
  processing: m.orders_shipment_processing,
  completed: m.orders_shipment_completed,
  shipped: m.orders_shipment_shipped,
  delivered: m.orders_shipment_delivered,
  cancelled: m.orders_shipment_cancelled,
  failed: m.orders_shipment_failed,
  unknown: m.orders_shipment_unknown,
});

/** Return states as sources report them in order history. */
export const returnLabels: Record<string, string> = localizedLabels({
  requested: m.orders_return_requested,
  open: m.orders_return_open,
  closed: m.orders_return_closed,
  declined: m.orders_return_declined,
  cancelled: m.orders_return_cancelled,
  unknown: m.orders_return_unknown,
});

/** Purchase order states shown beside SKUs and stock positions. */
export const purchaseOrderLabels: Record<string, string> = localizedLabels({
  draft: m.orders_purchase_order_draft,
  open: m.orders_purchase_order_open,
  closed: m.orders_purchase_order_closed,
  cancelled: m.orders_purchase_order_cancelled,
});

const connectionLabels: Record<string, string> = localizedLabels({
  pending: m.orders_connection_pending,
  active: m.orders_connection_active,
  degraded: m.orders_connection_degraded,
  disconnected: m.orders_connection_disconnected,
  revoked: m.orders_connection_revoked,
  unknown: m.orders_connection_unknown,
});

const issueStateLabels: Record<string, string> = localizedLabels({
  detected: m.orders_issue_state_detected,
  diagnosed: m.orders_issue_state_diagnosed,
  proposed: m.orders_issue_state_proposed,
  awaiting_approval: m.orders_issue_state_awaiting_approval,
  allowed: m.orders_issue_state_allowed,
  executing: m.orders_issue_state_executing,
  verifying: m.orders_issue_state_verifying,
  resolved: m.orders_issue_state_resolved,
  failed: m.orders_issue_state_failed,
  escalated: m.orders_issue_state_escalated,
});

const runStateLabels: Record<string, string> = localizedLabels({
  recorded: m.orders_run_state_recorded,
  scheduled: m.orders_run_state_scheduled,
  running: m.orders_run_state_running,
  waiting: m.orders_run_state_waiting,
  awaiting_decision: m.orders_run_state_awaiting_decision,
  awaiting_approval: m.orders_run_state_awaiting_approval,
  awaiting_admission: m.orders_run_state_awaiting_admission,
  completed: m.orders_run_state_completed,
  passed: m.orders_run_state_passed,
  verified: m.orders_run_state_verified,
  ended: m.orders_run_state_ended,
  denied: m.orders_run_state_denied,
  failed: m.orders_run_state_failed,
  not_executed: m.issues_observe_only_title,
  failed_verification: m.orders_run_state_failed_verification,
  inconclusive: m.orders_run_state_inconclusive,
  inconclusive_verification: m.orders_run_state_inconclusive_verification,
  escalated: m.orders_run_state_escalated,
  cancelled: m.orders_run_state_cancelled,
  skipped: m.orders_run_state_skipped,
});

const readable = (value: string) => value.replaceAll('_', ' ');

/** Labels a connection's health as reported with its records; unknown values pass through. */
export function connectionStatusLabel(status: string) {
  return connectionLabels[status] ?? readable(status);
}

/** Labels where an issue stands in its lifecycle; unknown states pass through readably. */
export function issueStateLabel(state: string) {
  return issueStateLabels[state] ?? readable(state);
}

/** Labels a workflow run's latest recorded state; unknown states pass through readably. */
export function runStateLabel(state: string) {
  return runStateLabels[state] ?? readable(state);
}

export const sortLabels: Record<OrderSort, string> = localizedLabels({
  updated: m.orders_sort_updated,
  placed: m.orders_sort_placed,
  number: m.orders_sort_number,
  due: m.orders_sort_due,
});

/**
 * Labels fulfillment progress. Closed orders without reported fulfillment work say so instead
 * of reading as unfulfilled.
 */
export function fulfillmentLabel(
  order: Pick<OrderListItem, 'fulfillment' | 'open'>,
) {
  return order.open === false && order.fulfillment === 'unfulfilled'
    ? m.orders_fulfillment_none_reported()
    : (fulfillmentLabels[order.fulfillment] ?? order.fulfillment);
}

/** Names an order by its source number, falling back to a short Luma ID. */
export function orderLabel(order: Pick<OrderListItem, 'id' | 'displayNumber'>) {
  return (
    order.displayNumber ??
    m.orders_order_fallback_label({ id: order.id.slice(0, 8) })
  );
}

/**
 * Formats a source amount in its currency without converting between currencies. Uses the
 * active interface language unless `locale` is given; unparseable amounts show as reported.
 */
export function formatMoney(
  money: { amount: string; currency: string } | null,
  locale?: string,
) {
  if (!money) return null;
  const amount = Number(money.amount);
  if (!Number.isFinite(amount)) return `${money.amount} ${money.currency}`;
  try {
    return locale
      ? new Intl.NumberFormat(locale, {
          style: 'currency',
          currency: money.currency,
        }).format(amount)
      : formatCurrency(amount, money.currency);
  } catch {
    return `${money.amount} ${money.currency}`;
  }
}

/**
 * Formats a decimal quantity a source reported with the active language's separators, without
 * rounding. Values that are not numbers show as reported.
 */
export function formatSourceNumber(value: string) {
  const number = Number(value);

  return value.trim() && Number.isFinite(number)
    ? formatNumber(number, { maximumFractionDigits: 20 })
    : value;
}

/** Shows a quantity with its unit; piece units such as `each` are implied. */
export function formatQuantity(quantity: string, unit: string) {
  const formatted = formatSourceNumber(quantity);

  return isPieceUnit(unit)
    ? formatted
    : quantityWithUnit(formatted, unit, quantity);
}

function add(values: string[]) {
  return values.reduce((total, value) => total + Number(value), 0);
}

const statusSentences: Record<string, (inputs: { source: string }) => string> =
  {
    open: m.orders_summary_status_open,
    completed: m.orders_summary_status_completed,
    cancelled: m.orders_summary_status_cancelled,
  };

const paymentSentences: Record<string, () => string> = {
  pending: m.orders_summary_payment_pending,
  authorized: m.orders_summary_payment_authorized,
  paid: m.orders_summary_payment_paid,
  partially_refunded: m.orders_summary_payment_partially_refunded,
  refunded: m.orders_summary_payment_refunded,
  failed: m.orders_summary_payment_failed,
};

const differenceSentences: Record<
  'status' | 'paymentStatus' | 'total',
  (inputs: { values: string }) => string
> = {
  status: m.orders_summary_differs_status,
  paymentStatus: m.orders_summary_differs_payment,
  total: m.orders_summary_differs_total,
};

/** What a summary sentence is about, so it can be shown with a matching icon and tone. */
export type SummaryKind =
  | 'state'
  | 'removed'
  | 'closed'
  | 'remaining'
  | 'unknown'
  | 'overdue'
  | 'failed'
  | 'issues'
  | 'differs';

export type SummaryLine = { kind: SummaryKind; text: string };

/**
 * Explains an order's current state and outstanding work in short sentences, using the source
 * shown in the list and naming disagreements between sources. The source's status and payment
 * are only spelled out when several sources report the order, or when nothing else needs saying.
 * `date` formats the due date as a workspace calendar date.
 */
export function orderSummary(
  detail: Pick<
    OrderDetail,
    'order' | 'sources' | 'differences' | 'fulfillments' | 'issues'
  >,
  date: (value: string) => string,
): SummaryLine[] {
  const source =
    detail.sources.find((item) => item.selected) ?? detail.sources[0];
  if (!source) return [];
  const label = (connectionId: string) =>
    detail.sources.find((item) => item.connectionId === connectionId)?.label ??
    m.orders_source_fallback();
  const lines: SummaryLine[] = [];
  const say = (kind: SummaryKind, text: string) => lines.push({ kind, text });
  if (source.deleted)
    say('removed', m.orders_summary_removed({ source: source.label }));
  const state = `${(statusSentences[source.status] ?? m.orders_summary_status_unknown)({ source: source.label })} ${(paymentSentences[source.paymentStatus] ?? m.orders_summary_payment_unknown)()}`;
  // The header already shows one source's status and payment; with several, name whose they are.
  if (detail.sources.length > 1) say('state', state);
  const remaining = source.lines.flatMap((line) =>
    line.remainingQuantity === null ? [] : [line.remainingQuantity],
  );
  const unknown = source.lines.filter(
    (line) => line.remainingQuantity === null,
  );
  const open = add(remaining.filter((value) => Number(value) > 0));
  if (detail.order.open === false) say('closed', m.orders_summary_closed());
  else if (open > 0)
    say(
      'remaining',
      m.orders_summary_remaining({
        units: open,
        lines: source.lines.filter((line) => Number(line.remainingQuantity) > 0)
          .length,
      }),
    );
  if (unknown.length && detail.order.open !== false)
    say(
      'unknown',
      m.orders_summary_remaining_unknown({
        lines: unknown.length,
        source: source.label,
        fulfilled: add(unknown.map((line) => line.fulfilledQuantity)),
        ordered: add(unknown.map((line) => line.quantity)),
      }),
    );
  if (detail.order.overdue && detail.order.dueAt)
    say(
      'overdue',
      m.orders_summary_overdue({ date: date(detail.order.dueAt) }),
    );
  for (const fulfillment of detail.fulfillments)
    if (!fulfillment.deleted && fulfillment.status === 'failed')
      say(
        'failed',
        fulfillment.failureCode
          ? m.orders_summary_fulfillment_failed_code({
              source: label(fulfillment.connectionId),
              code: fulfillment.failureCode,
            })
          : m.orders_summary_fulfillment_failed({
              source: label(fulfillment.connectionId),
            }),
      );
  const needsYou = detail.issues.filter((issue) => issue.needsYou).length;
  const openIssues = detail.issues.filter(
    (issue) => issue.state !== 'resolved',
  ).length;
  if (needsYou) say('issues', m.orders_summary_needs_you({ count: needsYou }));
  else if (openIssues)
    say('issues', m.orders_summary_open_issues({ count: openIssues }));
  if (detail.order.comparisonState === 'pending')
    say('differs', m.orders_comparison_pending_description());
  if (detail.order.comparisonState === 'inconclusive')
    say('unknown', m.orders_comparison_inconclusive_description());
  let lineDifferenceShown = false;
  for (const difference of detail.order.comparisonState === 'confirmed'
    ? detail.differences
    : []) {
    if (difference.field === 'overfulfillment') {
      for (const entry of difference.values)
        if (entry.value !== null)
          say(
            'differs',
            m.orders_summary_overfulfillment({
              value: formatSourceNumber(entry.value),
              source: label(entry.connectionId),
            }),
          );
      continue;
    }
    const values = [...difference.values].sort(
      (left, right) =>
        Number(right.connectionId === source.connectionId) -
        Number(left.connectionId === source.connectionId),
    );
    if (
      difference.field !== 'status' &&
      difference.field !== 'paymentStatus' &&
      difference.field !== 'total'
    ) {
      if (lineDifferenceShown) continue;
      lineDifferenceShown = true;
      say(
        'differs',
        m.orders_summary_differs_lines({
          sources: formatList(values.map((entry) => label(entry.connectionId))),
        }),
      );
      continue;
    }
    const field = difference.field;
    const value = (entry: string | null) =>
      entry === null
        ? m.common_unknown()
        : field === 'total'
          ? entry
          : ((field === 'status' ? statusLabels : paymentLabels)[entry] ??
            m.common_unknown());
    say(
      'differs',
      differenceSentences[field]({
        values: formatList(
          values.map((entry) =>
            m.orders_summary_difference_value({
              source: label(entry.connectionId),
              value: value(entry.value),
            }),
          ),
        ),
      }),
    );
  }

  if (!lines.length) say('state', state);

  return lines;
}

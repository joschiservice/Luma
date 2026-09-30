import type {
  RefundState,
  ReturnDetail,
  ReturnListItem,
  ReturnSource,
  ReturnStage,
  ReturnView,
} from '@luma/api-contract';
import type { OperationalState } from '@luma/ui/components/primitives/state';

import { formatMoney } from '../orders/presentation';
import { systemName } from '../products/presentation';

export const viewLabels: Record<ReturnView, string> = {
  action: 'Needs action',
  waiting: 'Waiting',
  done: 'Done',
  all: 'All',
};

export const viewDescriptions: Record<ReturnView, string> = {
  action:
    'Requests to review, returns ready to refund or close, and refunds whose payment failed.',
  waiting:
    'Returns waiting for the customer’s items or for a refund payment to finish processing.',
  done: 'Closed, declined and cancelled returns, and completed refunds.',
  all: 'Every imported return, and refunds that no return settles.',
};

export const stageLabels: Record<ReturnStage, string> = {
  requested: 'To review',
  awaiting_items: 'Waiting for items',
  awaiting_refund: 'Ready to refund',
  refund_pending: 'Refund processing',
  refund_failed: 'Refund failed',
  ready_to_close: 'Ready to close',
  closed: 'Closed',
  declined: 'Declined',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
  refund_recorded: 'No money refunded',
  unknown: 'Status not recognized',
};

export const stageDescriptions: Record<ReturnStage, string> = {
  requested:
    'Customers asked to return these items. Approve or decline each request in your store.',
  awaiting_items: 'Approved returns whose items have not all arrived back yet.',
  awaiting_refund:
    'Units are back, or were never expected back, and have not been refunded.',
  refund_pending:
    'A refund payment is processing. The customer has not received the money yet.',
  refund_failed:
    'Every refund payment attempt failed. Retry the refund in your store.',
  ready_to_close: 'Received and refunded returns that are still open.',
  closed: 'Returns the source closed.',
  declined: 'Return requests the merchant declined.',
  cancelled: 'Returns cancelled at the source.',
  refunded: 'Refunds without a return whose payment succeeded.',
  refund_recorded:
    'Refunds recorded without a payment, for example a restock without money back.',
  unknown: 'Returns with a status Luma does not recognize.',
};

export const stageStates: Record<ReturnStage, OperationalState> = {
  requested: 'approval',
  awaiting_items: 'waiting',
  awaiting_refund: 'attention',
  refund_pending: 'running',
  refund_failed: 'error',
  ready_to_close: 'attention',
  closed: 'idle',
  declined: 'idle',
  cancelled: 'idle',
  refunded: 'idle',
  refund_recorded: 'idle',
  unknown: 'waiting',
};

/** Stages shown as pending work, in the order a return usually moves through them. */
export const workStages: ReturnStage[] = [
  'requested',
  'awaiting_items',
  'awaiting_refund',
  'refund_pending',
  'refund_failed',
  'ready_to_close',
];

export const refundLabels: Record<RefundState, string> = {
  none: 'Not refunded',
  recorded: 'Recorded without payment',
  pending: 'Payment processing',
  failed: 'Payment failed',
  partial: 'Partly refunded',
  refunded: 'Refunded',
};

const declineLabels = {
  return_period_ended: 'the return period ended',
  final_sale: 'the item was a final sale',
  other: 'the merchant declined it',
} as const;

const number = (value: string | null) =>
  value === null ? null : Number(value);

/** Formats a decimal unit count; fractional counts keep their precision. */
export const units = (value: string | null) =>
  value === null ? '—' : Number(value).toLocaleString();

function plural(count: number, one: string, many = `${one}s`) {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

/** Formats an amount in the refund currency, or null when there is none. */
export function refundMoney(amount: string | null, currency: string | null) {
  return amount !== null && currency ? formatMoney({ amount, currency }) : null;
}

/** Names a return by its source name, and a refund without a return by its order. */
export function returnLabel(
  item: Pick<ReturnListItem, 'id' | 'kind' | 'name' | 'order'>,
) {
  const order = item.order.displayNumber ?? item.order.id.slice(0, 8);

  return (
    item.name ??
    (item.kind === 'refund' ? `Refund on ${order}` : `Return on ${order}`)
  );
}

// These stages already name the refund state, so a separate refund label would repeat it.
const refundStages = new Set<ReturnStage>([
  'refund_pending',
  'refund_failed',
  'refunded',
  'refund_recorded',
]);

/** Whether a separate refund label adds information to the stage label. */
export const showsRefundState = (
  item: Pick<ReturnListItem, 'stage' | 'refund'>,
) => item.refund.state !== 'none' && !refundStages.has(item.stage);

/**
 * Summarizes refund payments without calling pending, failed or recorded refunds money
 * returned. Amounts are shown only from payment outcomes.
 */
export function refundSummary(item: Pick<ReturnListItem, 'refund'>) {
  const { refund } = item;
  const refunded = refundMoney(refund.refunded, refund.currency);
  const pending = refundMoney(refund.pending, refund.currency);
  const parts = [
    refunded ? `${refunded} refunded` : null,
    pending ? `${pending} processing` : null,
  ].filter(Boolean);
  if (parts.length) return parts.join(' · ');
  if (refund.state === 'failed')
    return `${plural(refund.failedAttempts, 'payment')} failed`;
  if (refund.currency === null && refund.state !== 'none')
    return `${refundLabels[refund.state]} · several currencies`;

  return refundLabels[refund.state];
}

/** A short statement of the next step and who owns it. */
export function nextStep(
  item: Pick<
    ReturnListItem,
    'stage' | 'quantity' | 'received' | 'refundedUnits' | 'refund'
  >,
  system: string | null,
) {
  const source = system ? systemName(system) : 'the source';
  const store = source === 'Connected source' ? 'the source' : source;
  const quantity = number(item.quantity) ?? 0;
  const received = number(item.received);
  const refunded = number(item.refundedUnits);
  const pending = refundMoney(item.refund.pending, item.refund.currency);
  switch (item.stage) {
    case 'requested':
      return `Review the request and approve or decline it in ${store}.`;
    case 'awaiting_items':
      return received === null
        ? 'Waiting for the customer to send the items back.'
        : `Waiting for ${plural(quantity - received, 'unit')} to arrive back (${received.toLocaleString()} of ${quantity.toLocaleString()} received).`;
    case 'awaiting_refund':
      return refunded !== null && refunded > 0
        ? `Refund the remaining ${plural(quantity - refunded, 'unit')} in ${store}.`
        : `The items are back. Issue the refund in ${store}.`;
    case 'refund_pending':
      return `${pending ?? 'A refund'} is processing with the payment provider. The customer has not received it yet.`;
    case 'refund_failed':
      return `The refund payment failed. Retry the refund in ${store}.`;
    case 'ready_to_close':
      return `Items are back and refunded. Close the return in ${store}.`;
    case 'closed':
      return 'Closed at the source. Nothing is pending.';
    case 'declined':
      return 'Declined at the source. No items or money are expected.';
    case 'cancelled':
      return 'Cancelled at the source. Nothing is pending.';
    case 'refunded':
      return 'The refund payment succeeded.';
    case 'refund_recorded':
      return `${store} recorded this refund without a payment, so no money was returned.`;
    case 'unknown':
      return `${store} reported a return status Luma does not recognize. Check the return in ${store}.`;
  }
}

/** Describes whether a connection shares returns with Luma and what to do about it. */
export function accessMessage(source: ReturnSource) {
  if (source.access === 'granted') return null;
  if (source.access === 'not_granted')
    return `${source.label} has not granted access to returns. Reconnect it to allow reading returns and refunds.`;

  return source.system === 'shopify'
    ? `${source.label} was connected before returns were available. Reconnect it to share returns and refunds with Luma.`
    : `${source.label} does not share returns with Luma. Returns handled in ${systemName(source.system)} are not shown here.`;
}

export type StepState =
  'done' | 'current' | 'upcoming' | 'failed' | 'skipped' | 'unreported';

export interface ReturnStep {
  key: 'requested' | 'approved' | 'received' | 'refunded' | 'closed';
  label: string;
  state: StepState;
  detail: string;
  at: string | null;
}

/**
 * The stages of one return from request to close, from source times and quantities. A stage the
 * source does not report is `unreported` rather than assumed done.
 */
export function returnSteps(
  detail: Pick<ReturnDetail, 'item' | 'timeline' | 'refunds'>,
): ReturnStep[] {
  const { item, timeline } = detail;
  const status = item.status;
  const quantity = number(item.quantity) ?? 0;
  const received = number(item.received);
  const stopped = status === 'declined' || status === 'cancelled';
  const approved =
    timeline.approvedAt !== null || status === 'open' || status === 'closed';
  const refundedAt =
    detail.refunds
      .flatMap((refund) =>
        refund.transactions
          .filter((t) => t.status === 'success')
          .map((t) => t.processedAt ?? refund.createdAt),
      )
      .filter((value): value is string => !!value)
      .sort()
      .at(-1) ?? null;
  const refunded = refundMoney(item.refund.refunded, item.refund.currency);
  const pending = refundMoney(item.refund.pending, item.refund.currency);

  return [
    {
      key: 'requested',
      label: 'Requested',
      state: 'done',
      detail: `${plural(quantity, 'unit')} to return`,
      at: timeline.requestedAt,
    },
    {
      key: 'approved',
      label: stopped
        ? status === 'declined'
          ? 'Declined'
          : 'Cancelled'
        : 'Approved',
      state: stopped
        ? 'failed'
        : approved
          ? 'done'
          : status === 'requested'
            ? 'current'
            : 'unreported',
      detail:
        status === 'declined'
          ? `Declined because ${declineLabels[timeline.declineReason ?? 'other']}`
          : status === 'cancelled'
            ? 'The return was cancelled'
            : timeline.approvedAt
              ? 'Approved at the source'
              : approved
                ? 'Opened at the source'
                : status === 'requested'
                  ? 'Waiting for your decision'
                  : 'Approval not reported',
      at: stopped ? timeline.closedAt : timeline.approvedAt,
    },
    {
      key: 'received',
      label: 'Items received',
      state: stopped
        ? 'skipped'
        : received === null
          ? 'unreported'
          : received >= quantity
            ? 'done'
            : approved && status !== 'closed'
              ? 'current'
              : 'upcoming',
      detail:
        received === null
          ? 'The source does not report returned items'
          : `${received.toLocaleString()} of ${plural(quantity, 'unit')} received`,
      at: received !== null && received > 0 ? timeline.receivedAt : null,
    },
    {
      key: 'refunded',
      label: 'Refunded',
      state: stopped
        ? 'skipped'
        : item.refund.state === 'refunded'
          ? 'done'
          : item.refund.state === 'failed'
            ? 'failed'
            : ['pending', 'partial', 'recorded'].includes(item.refund.state) ||
                item.stage === 'awaiting_refund'
              ? 'current'
              : 'upcoming',
      detail:
        item.refund.state === 'failed'
          ? 'The refund payment failed'
          : item.refund.state === 'recorded'
            ? 'Refund recorded without a payment'
            : [
                refunded && `${refunded} refunded`,
                pending && `${pending} processing`,
              ]
                .filter(Boolean)
                .join(' · ') || 'No refund yet',
      at: refundedAt,
    },
    {
      key: 'closed',
      label: 'Closed',
      state: stopped
        ? 'skipped'
        : status === 'closed'
          ? 'done'
          : item.stage === 'ready_to_close'
            ? 'current'
            : 'upcoming',
      detail: status === 'closed' ? 'Closed at the source' : 'Still open',
      at: status === 'closed' ? timeline.closedAt : null,
    },
  ];
}

export const transactionLabels = {
  success: 'Refunded',
  pending: 'Processing',
  failed: 'Failed',
  unknown: 'Outcome unknown',
} as const;

/** The overall outcome of one refund's payment attempts; a pending attempt means not finished. */
export function refundOutcome(
  transactions: ReturnDetail['refunds'][number]['transactions'],
): keyof typeof transactionLabels {
  if (transactions.some((t) => t.status === 'pending')) return 'pending';
  if (transactions.some((t) => t.status === 'success')) return 'success';
  if (transactions.some((t) => t.status === 'failed')) return 'failed';

  return 'unknown';
}

export const transactionTones = {
  success: 'success',
  pending: 'info',
  failed: 'danger',
  unknown: 'neutral',
} as const;

export const restockLabels = {
  return: 'Restock from return',
  cancel: 'Restock from cancellation',
  no_restock: 'Not restocked',
  unknown: 'Restock not reported',
} as const;

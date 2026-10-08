import type {
  RefundState,
  ReturnDetail,
  ReturnListItem,
  ReturnSource,
  ReturnStage,
  ReturnView,
} from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import type { OperationalState } from '@luma/ui/components/primitives/state';

import { formatMoney } from '../orders/presentation';

/** The system a return comes from, for messages that name it. */
export type ReturnSystem = 'shopify' | 'jtl' | 'other';

/** Maps a source system ID to the name messages use for it. */
export function returnSystem(system: string | null): ReturnSystem {
  if (system === 'shopify') return 'shopify';
  if (system?.startsWith('jtl')) return 'jtl';

  return 'other';
}

const stageLabelMessages = {
  requested: m.returns_stage_requested,
  awaiting_items: m.returns_stage_awaiting_items,
  awaiting_refund: m.returns_stage_awaiting_refund,
  refund_pending: m.returns_stage_refund_pending,
  refund_failed: m.returns_stage_refund_failed,
  ready_to_close: m.returns_stage_ready_to_close,
  closed: m.returns_stage_closed,
  declined: m.returns_stage_declined,
  cancelled: m.returns_stage_cancelled,
  refunded: m.returns_stage_refunded,
  refund_recorded: m.returns_stage_refund_recorded,
  unknown: m.returns_stage_unknown,
} satisfies Record<ReturnStage, () => string>;

const stageDescriptionMessages = {
  requested: m.returns_stage_requested_description,
  awaiting_items: m.returns_stage_awaiting_items_description,
  awaiting_refund: m.returns_stage_awaiting_refund_description,
  refund_pending: m.returns_stage_refund_pending_description,
  refund_failed: m.returns_stage_refund_failed_description,
  ready_to_close: m.returns_stage_ready_to_close_description,
  closed: m.returns_stage_closed_description,
  declined: m.returns_stage_declined_description,
  cancelled: m.returns_stage_cancelled_description,
  refunded: m.returns_stage_refunded_description,
  refund_recorded: m.returns_stage_refund_recorded_description,
  unknown: m.returns_stage_unknown_description,
} satisfies Record<ReturnStage, () => string>;

/** Reads each message when accessed, so labels follow the active language. */
function localized<K extends string>(
  messages: Record<K, () => string>,
): Record<K, string> {
  const labels = {} as Record<K, string>;
  for (const key of Object.keys(messages) as K[])
    Object.defineProperty(labels, key, {
      enumerable: true,
      get: () => messages[key](),
    });

  return labels;
}

export const stageLabels = localized(stageLabelMessages);

export const stageDescriptions = localized(stageDescriptionMessages);

export const viewLabels = localized({
  action: m.returns_view_action,
  waiting: m.returns_view_waiting,
  done: m.returns_view_done,
  all: m.returns_view_all,
} satisfies Record<ReturnView, () => string>);

export const viewDescriptions = localized({
  action: m.returns_view_action_description,
  waiting: m.returns_view_waiting_description,
  done: m.returns_view_done_description,
  all: m.returns_view_all_description,
} satisfies Record<ReturnView, () => string>);

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

export const refundLabels = localized({
  none: m.returns_refund_none,
  recorded: m.returns_refund_recorded,
  pending: m.returns_refund_pending,
  failed: m.returns_refund_failed,
  partial: m.returns_refund_partial,
  refunded: m.returns_refund_refunded,
} satisfies Record<RefundState, () => string>);

const declineDetails = {
  return_period_ended: m.returns_step_declined_return_period_ended,
  final_sale: m.returns_step_declined_final_sale,
  other: m.returns_step_declined_other,
} as const;

const number = (value: string | null) =>
  value === null ? null : Number(value);

/** Formats a decimal unit count; fractional counts keep their precision. */
export const units = (value: string | null) =>
  value === null ? m.common_empty_value() : formatNumber(Number(value));

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
    (item.kind === 'refund'
      ? m.returns_label_refund({ order })
      : m.returns_label_return({ order }))
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

/** Describes refunded and processing amounts together, or null when there are none. */
function amounts(refunded: string | null, pending: string | null) {
  if (refunded && pending)
    return m.returns_refund_amount_refunded_processing({ refunded, pending });
  if (refunded) return m.returns_refund_amount_refunded({ amount: refunded });
  if (pending) return m.returns_refund_amount_processing({ amount: pending });

  return null;
}

/**
 * Summarizes refund payments without calling pending, failed or recorded refunds money
 * returned. Amounts are shown only from payment outcomes.
 */
export function refundSummary(item: Pick<ReturnListItem, 'refund'>) {
  const { refund } = item;
  const money = amounts(
    refundMoney(refund.refunded, refund.currency),
    refundMoney(refund.pending, refund.currency),
  );
  if (money) return money;
  if (refund.state === 'failed')
    return m.returns_refund_payments_failed({ count: refund.failedAttempts });
  if (refund.currency === null && refund.state !== 'none')
    return m.returns_refund_several_currencies({
      state: refundLabels[refund.state],
    });

  return refundLabels[refund.state];
}

/** A short statement of the next step and who owns it. */
export function nextStep(
  item: Pick<
    ReturnListItem,
    'stage' | 'quantity' | 'received' | 'refundedUnits' | 'refund'
  >,
  source: string | null,
) {
  const system = returnSystem(source);
  const quantity = number(item.quantity) ?? 0;
  const received = number(item.received);
  const refunded = number(item.refundedUnits);
  const pending = refundMoney(item.refund.pending, item.refund.currency);
  switch (item.stage) {
    case 'requested':
      return m.returns_next_requested({ system });
    case 'awaiting_items':
      return received === null
        ? m.returns_next_awaiting_items_unreported()
        : m.returns_next_awaiting_items({
            remaining: quantity - received,
            received,
            quantity,
          });
    case 'awaiting_refund':
      return refunded !== null && refunded > 0
        ? m.returns_next_refund_remaining({
            remaining: quantity - refunded,
            system,
          })
        : m.returns_next_issue_refund({ system });
    case 'refund_pending':
      return pending
        ? m.returns_next_refund_pending_amount({ amount: pending })
        : m.returns_next_refund_pending();
    case 'refund_failed':
      return m.returns_next_refund_failed({ system });
    case 'ready_to_close':
      return m.returns_next_ready_to_close({ system });
    case 'closed':
      return m.returns_next_closed();
    case 'declined':
      return m.returns_next_declined();
    case 'cancelled':
      return m.returns_next_cancelled();
    case 'refunded':
      return m.returns_next_refunded();
    case 'refund_recorded':
      return m.returns_next_refund_recorded({ system });
    case 'unknown':
      return m.returns_next_unknown({ system });
  }
}

/** Describes whether a connection shares returns with Luma and what to do about it. */
export function accessMessage(source: ReturnSource) {
  if (source.access === 'granted') return null;
  if (source.access === 'not_granted')
    return m.returns_access_not_granted({ connection: source.label });

  return source.system === 'shopify'
    ? m.returns_access_reconnect_shopify({ connection: source.label })
    : m.returns_access_not_shared({
        connection: source.label,
        system: returnSystem(source.system),
      });
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
  const money = amounts(
    refundMoney(item.refund.refunded, item.refund.currency),
    refundMoney(item.refund.pending, item.refund.currency),
  );

  return [
    {
      key: 'requested',
      label: m.returns_step_requested(),
      state: 'done',
      detail: m.returns_step_units_to_return({ count: quantity }),
      at: timeline.requestedAt,
    },
    {
      key: 'approved',
      label: stopped
        ? status === 'declined'
          ? m.returns_step_declined()
          : m.returns_step_cancelled()
        : m.returns_step_approved(),
      state: stopped
        ? 'failed'
        : approved
          ? 'done'
          : status === 'requested'
            ? 'current'
            : 'unreported',
      detail:
        status === 'declined'
          ? declineDetails[timeline.declineReason ?? 'other']()
          : status === 'cancelled'
            ? m.returns_step_cancelled_detail()
            : timeline.approvedAt
              ? m.returns_step_approved_detail()
              : approved
                ? m.returns_step_opened_detail()
                : status === 'requested'
                  ? m.returns_step_waiting_decision()
                  : m.returns_step_approval_unreported(),
      at: stopped ? timeline.closedAt : timeline.approvedAt,
    },
    {
      key: 'received',
      label: m.returns_step_received(),
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
          ? m.returns_step_received_unreported()
          : m.returns_step_received_detail({ received, quantity }),
      at: received !== null && received > 0 ? timeline.receivedAt : null,
    },
    {
      key: 'refunded',
      label: m.returns_step_refunded(),
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
          ? m.returns_step_refund_failed()
          : item.refund.state === 'recorded'
            ? m.returns_step_refund_recorded()
            : (money ?? m.returns_step_no_refund()),
      at: refundedAt,
    },
    {
      key: 'closed',
      label: m.returns_step_closed(),
      state: stopped
        ? 'skipped'
        : status === 'closed'
          ? 'done'
          : item.stage === 'ready_to_close'
            ? 'current'
            : 'upcoming',
      detail:
        status === 'closed'
          ? m.returns_step_closed_detail()
          : m.returns_step_still_open(),
      at: status === 'closed' ? timeline.closedAt : null,
    },
  ];
}

type RefundOutcome = 'success' | 'pending' | 'failed' | 'unknown';

export const transactionLabels = localized({
  success: m.returns_transaction_success,
  pending: m.returns_transaction_pending,
  failed: m.returns_transaction_failed,
  unknown: m.returns_transaction_unknown,
} satisfies Record<RefundOutcome, () => string>);

/** The overall outcome of one refund's payment attempts; a pending attempt means not finished. */
export function refundOutcome(
  transactions: ReturnDetail['refunds'][number]['transactions'],
): RefundOutcome {
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

export const restockLabels = localized({
  return: m.returns_restock_return,
  cancel: m.returns_restock_cancel,
  no_restock: m.returns_restock_no_restock,
  unknown: m.returns_restock_unknown,
});

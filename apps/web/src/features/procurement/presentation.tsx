import type {
  Commitment,
  OrderProgress,
  OrderStage,
  PurchaseOrderStatus,
} from '@luma/api-contract';
import { formatCalendarDate, formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import {
  type OperationalState,
  StatePill,
} from '@luma/ui/components/primitives/state';
import { quantityWithUnit } from '@luma/ui/lib/units';

export const statusLabels = {
  draft: m.procurement_status_draft,
  open: m.procurement_status_open,
  closed: m.procurement_status_closed,
  cancelled: m.procurement_status_cancelled,
} satisfies Record<PurchaseOrderStatus, () => string>;

function stage(label: () => string, state: OperationalState) {
  return {
    get label() {
      return label();
    },
    state,
  };
}

/**
 * Stage wording and state. A draft or sent order is never shown as received. `label` reads the
 * active language each time it is accessed.
 */
export const stages: Record<
  OrderStage,
  { readonly label: string; state: OperationalState }
> = {
  draft: stage(m.procurement_stage_draft, 'idle'),
  awaiting_approval: stage(m.procurement_stage_awaiting_approval, 'approval'),
  sending: stage(m.procurement_stage_sending, 'running'),
  send_failed: stage(m.procurement_stage_send_failed, 'error'),
  awaiting_confirmation: stage(
    m.procurement_stage_awaiting_confirmation,
    'waiting',
  ),
  confirmed: stage(m.procurement_stage_confirmed, 'waiting'),
  changed: stage(m.procurement_stage_changed, 'attention'),
  partially_received: stage(m.procurement_stage_partially_received, 'running'),
  received: stage(m.procurement_stage_received, 'verified'),
  closed: stage(m.procurement_stage_closed, 'idle'),
  cancelled: stage(m.procurement_stage_cancelled, 'idle'),
};

/** Shows an order's stage as a state pill. */
export function StagePill({ stage }: { stage: OrderStage }) {
  return (
    <StatePill state={stages[stage].state}>{stages[stage].label}</StatePill>
  );
}

export const milestoneLabels = {
  drafted: m.procurement_milestone_drafted,
  submitted: m.procurement_milestone_submitted,
  confirmed: m.procurement_milestone_confirmed,
  received: m.procurement_milestone_received,
} satisfies Record<OrderProgress['milestones'][number]['key'], () => string>;

export const milestoneStates = {
  complete: {
    state: 'verified',
    label: m.procurement_milestone_state_complete,
  },
  partial: { state: 'running', label: m.procurement_milestone_state_partial },
  in_progress: {
    state: 'running',
    label: m.procurement_milestone_state_in_progress,
  },
  attention: {
    state: 'attention',
    label: m.procurement_milestone_state_attention,
  },
  pending: { state: 'waiting', label: m.procurement_milestone_state_pending },
  not_started: {
    state: 'idle',
    label: m.procurement_milestone_state_not_started,
  },
  stopped: { state: 'idle', label: m.procurement_milestone_state_stopped },
} satisfies Record<
  OrderProgress['milestones'][number]['state'],
  { state: OperationalState; label: () => string }
>;

export const ownerLabels = {
  buyer: m.procurement_owner_buyer,
  approver: m.procurement_owner_approver,
  supplier: m.procurement_owner_supplier,
  warehouse: m.procurement_owner_warehouse,
  luma: m.procurement_owner_luma,
  none: m.procurement_owner_none,
} satisfies Record<OrderProgress['next']['owner'], () => string>;

export const lineStages = {
  not_submitted: {
    label: m.procurement_line_stage_not_submitted,
    state: 'idle',
  },
  awaiting_confirmation: {
    label: m.procurement_line_stage_awaiting_confirmation,
    state: 'waiting',
  },
  confirmed: { label: m.procurement_line_stage_confirmed, state: 'waiting' },
  changed: { label: m.procurement_line_stage_changed, state: 'attention' },
  partially_received: {
    label: m.procurement_line_stage_partially_received,
    state: 'running',
  },
  received: { label: m.procurement_line_stage_received, state: 'verified' },
  cancelled: { label: m.procurement_line_stage_cancelled, state: 'idle' },
} satisfies Record<
  OrderProgress['lines'][number]['stage'],
  { label: () => string; state: OperationalState }
>;

export const commitmentKinds = {
  confirmed_quantity: m.procurement_commitment_kind_confirmed_quantity,
  promised_date: m.procurement_commitment_kind_promised_date,
  shipped: m.procurement_commitment_kind_shipped,
  received: m.procurement_commitment_kind_received,
  condition: m.procurement_commitment_kind_condition,
  shortage: m.procurement_commitment_kind_shortage,
  damaged: m.procurement_commitment_kind_damaged,
} satisfies Record<Commitment['kind'], () => string>;

export const reviewReasonLabels = {
  low_confidence: m.procurement_review_reason_low_confidence,
  quantity_changed: m.procurement_review_reason_quantity_changed,
  date_later: m.procurement_review_reason_date_later,
  unmatched_line: m.procurement_review_reason_unmatched_line,
  supplier_condition: m.procurement_review_reason_supplier_condition,
  sender_unverified: m.procurement_review_reason_sender_unverified,
} satisfies Record<Commitment['reviewReasons'][number], () => string>;

/** Formats a quantity in the active language without float noise. */
export function quantity(value: number) {
  return formatNumber(Number(value.toFixed(6)), { maximumFractionDigits: 6 });
}

/** Says what a commitment states, with its unit. */
export function commitmentValue(commitment: Commitment, unit?: string) {
  if (
    commitment.kind === 'confirmed_quantity' ||
    commitment.kind === 'received' ||
    commitment.kind === 'shortage' ||
    commitment.kind === 'damaged'
  )
    return unit
      ? quantityWithUnit(
          quantity(commitment.quantity ?? 0),
          unit,
          commitment.quantity ?? 0,
        )
      : quantity(commitment.quantity ?? 0);
  if (commitment.kind === 'condition')
    return commitment.text ?? m.procurement_commitment_kind_condition();

  return commitment.date
    ? calendarDate(commitment.date)
    : m.procurement_commitment_no_date();
}

/** Names where a commitment came from. */
export function commitmentSource(
  commitment: Commitment,
  purchasingLabel: string | null,
) {
  const source = commitment.source;
  if (source.kind === 'purchasing_system')
    return purchasingLabel
      ? m.procurement_commitment_source_system({ system: purchasingLabel })
      : m.procurement_commitment_source_system_generic();
  if (source.kind === 'manual_receipt') return m.procurement_receipt_source();
  if (source.kind === 'correction')
    return m.procurement_commitment_source_correction();

  return source.extraction
    ? m.procurement_commitment_source_read()
    : m.procurement_commitment_source_recorded();
}

/** Adds days to a calendar date. */
export function addDays(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** Today's calendar date in the reader's time zone. */
export function today() {
  const now = new Date();

  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10);
}

/** Formats a calendar date for reading in the active language, without shifting it across time zones. */
export function calendarDate(date: string) {
  return formatCalendarDate(date);
}

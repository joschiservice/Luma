import type {
  Commitment,
  OrderProgress,
  OrderStage,
  PurchaseOrderStatus,
} from '@luma/api-contract';
import { Badge } from '@luma/ui/components/primitives/badge';
import {
  type OperationalState,
  StatePill,
} from '@luma/ui/components/primitives/state';

export const statusLabels: Record<PurchaseOrderStatus, string> = {
  draft: 'Draft',
  open: 'Open',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

/** Presents order state with a readable label and semantic color. */
export function OrderStatus({ status }: { status: PurchaseOrderStatus }) {
  return (
    <Badge
      tone={
        status === 'open' ? 'info' : status === 'closed' ? 'success' : 'neutral'
      }
    >
      <span className="procurement-status-dot" />
      {statusLabels[status]}
    </Badge>
  );
}

/** Stage wording and state. A draft or sent order is never shown as received. */
export const stages: Record<
  OrderStage,
  { label: string; state: OperationalState }
> = {
  draft: { label: 'Draft · not sent', state: 'idle' },
  awaiting_approval: { label: 'Waiting for approval', state: 'approval' },
  sending: { label: 'Sending', state: 'running' },
  send_failed: { label: 'Not sent', state: 'error' },
  awaiting_confirmation: {
    label: 'Sent · awaiting confirmation',
    state: 'waiting',
  },
  confirmed: { label: 'Confirmed by supplier', state: 'waiting' },
  changed: { label: 'Confirmed with changes', state: 'attention' },
  partially_received: { label: 'Partly received', state: 'running' },
  received: { label: 'Received', state: 'verified' },
  closed: { label: 'Closed', state: 'idle' },
  cancelled: { label: 'Cancelled', state: 'idle' },
};

/** Shows an order's stage as a state pill. */
export function StagePill({ stage }: { stage: OrderStage }) {
  return (
    <StatePill state={stages[stage].state}>{stages[stage].label}</StatePill>
  );
}

export const milestoneLabels: Record<
  OrderProgress['milestones'][number]['key'],
  string
> = {
  drafted: 'Drafted',
  submitted: 'Sent to supplier',
  confirmed: 'Supplier confirmed',
  received: 'Goods received',
};

export const milestoneStates: Record<
  OrderProgress['milestones'][number]['state'],
  { state: OperationalState; label: string }
> = {
  complete: { state: 'verified', label: 'Done' },
  partial: { state: 'running', label: 'Partly' },
  in_progress: { state: 'running', label: 'In progress' },
  attention: { state: 'attention', label: 'Needs attention' },
  pending: { state: 'waiting', label: 'Waiting' },
  not_started: { state: 'idle', label: 'Not started' },
  stopped: { state: 'idle', label: 'Stopped' },
};

export const ownerLabels: Record<OrderProgress['next']['owner'], string> = {
  buyer: 'Buyer',
  approver: 'Second approver',
  supplier: 'Supplier',
  warehouse: 'Warehouse',
  luma: 'Luma',
  none: 'No one',
};

export const lineStages: Record<
  OrderProgress['lines'][number]['stage'],
  { label: string; state: OperationalState }
> = {
  not_submitted: { label: 'Not sent', state: 'idle' },
  awaiting_confirmation: { label: 'Awaiting confirmation', state: 'waiting' },
  confirmed: { label: 'Confirmed', state: 'waiting' },
  changed: { label: 'Changed', state: 'attention' },
  partially_received: { label: 'Partly received', state: 'running' },
  received: { label: 'Received', state: 'verified' },
  cancelled: { label: 'Cancelled', state: 'idle' },
};

export const commitmentKinds: Record<Commitment['kind'], string> = {
  confirmed_quantity: 'Confirmed quantity',
  promised_date: 'Promised delivery',
  shipped: 'Shipped',
  received: 'Booked as received',
  condition: 'Condition',
};

export const reviewReasonLabels: Record<
  Commitment['reviewReasons'][number],
  string
> = {
  low_confidence: 'Ambiguous wording',
  quantity_changed: 'Quantity differs from the order',
  date_later: 'Later than requested',
  unmatched_line: 'No matching order line',
  supplier_condition: 'Supplier condition',
};

/** Formats a quantity without float noise. */
export function quantity(value: number) {
  return Number(value.toFixed(6)).toLocaleString(undefined, {
    maximumFractionDigits: 6,
  });
}

/** Says what a commitment states, with its unit. */
export function commitmentValue(commitment: Commitment, unit?: string) {
  if (
    commitment.kind === 'confirmed_quantity' ||
    commitment.kind === 'received'
  )
    return `${quantity(commitment.quantity ?? 0)}${unit ? ` ${unit}` : ''}`;
  if (commitment.kind === 'condition') return commitment.text ?? 'Condition';

  return commitment.date ?? 'Date not stated';
}

/** Names where a commitment came from. */
export function commitmentSource(
  commitment: Commitment,
  purchasingLabel: string | null,
) {
  const source = commitment.source;
  if (source.kind === 'purchasing_system')
    return `Read from ${purchasingLabel ?? 'the purchasing system'}`;
  if (source.kind === 'correction') return 'Correction by a person';

  return source.extraction
    ? 'Read from a supplier message'
    : 'Recorded from a supplier message';
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

/** Formats a calendar date for reading, without shifting it across time zones. */
export function calendarDate(date: string) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

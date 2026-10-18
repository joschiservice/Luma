import type {
  Citation,
  DocumentState,
  Fact,
  FactMoney,
  FactValue,
  LinkedRecordKind,
  LinkMethod,
  Mailbox,
  MailboxRuleKind,
  MailboxSyncState,
  MessageAddress,
  Outbound,
  OutboundState,
  RuleParty,
  ThreadEvent,
  ThreadStatus,
  ThreadSummary,
  ThreadView,
} from '@luma/api-contract';
import {
  formatCalendarDate,
  formatCurrency,
  formatNumber,
} from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import type { Domain } from '@luma/ui/components/primitives/domain-icon';
import { columnName } from '@luma/ui/components/primitives/source-view';
import type { OperationalState } from '@luma/ui/components/primitives/state';

export {
  outboundStateLabels,
  outboundStates,
} from '../../shared/messaging/outbound-state';

type Text = () => string;

/** Inbox views in tab order. */
export const threadViews: readonly ThreadView[] = [
  'open',
  'mine',
  'unassigned',
  'overdue',
  'review',
  'closed',
  'all',
];

export const viewLabels: Record<ThreadView, Text> = {
  open: m.messaging_view_open,
  mine: m.messaging_view_mine,
  unassigned: m.messaging_view_unassigned,
  overdue: m.messaging_view_overdue,
  review: m.messaging_view_review,
  closed: m.messaging_view_closed,
  all: m.messaging_view_all,
};

export const viewDescriptions: Record<ThreadView, Text> = {
  open: m.messaging_view_open_description,
  mine: m.messaging_view_mine_description,
  unassigned: m.messaging_view_unassigned_description,
  overdue: m.messaging_view_overdue_description,
  review: m.messaging_view_review_description,
  closed: m.messaging_view_closed_description,
  all: m.messaging_view_all_description,
};

/** Explains an empty view without implying that nothing else needs attention. */
export function emptyCopy(view: ThreadView, filtered: boolean) {
  if (filtered)
    return {
      title: m.messaging_empty_filtered_title(),
      text: m.messaging_empty_filtered_text(),
    };

  return { title: viewEmptyTitles[view](), text: m.messaging_empty_text() };
}

const viewEmptyTitles: Record<ThreadView, Text> = {
  open: m.messaging_empty_open,
  mine: m.messaging_empty_mine,
  unassigned: m.messaging_empty_unassigned,
  overdue: m.messaging_empty_overdue,
  review: m.messaging_empty_review,
  closed: m.messaging_empty_closed,
  all: m.messaging_empty_all,
};

export const statusLabels: Record<ThreadStatus, Text> = {
  open: m.messaging_status_open,
  waiting: m.messaging_status_waiting,
  closed: m.messaging_status_closed,
};

export const statusStates: Record<ThreadStatus, OperationalState> = {
  open: 'attention',
  waiting: 'waiting',
  closed: 'idle',
};

export const syncStateLabels: Record<MailboxSyncState, Text> = {
  needs_rules: m.messaging_sync_needs_rules,
  syncing: m.messaging_sync_syncing,
  current: m.messaging_sync_current,
  paused: m.messaging_sync_paused,
  retrying: m.messaging_sync_retrying,
  blocked: m.messaging_sync_blocked,
};

export const syncStates: Record<MailboxSyncState, OperationalState> = {
  needs_rules: 'attention',
  syncing: 'running',
  current: 'verified',
  paused: 'idle',
  retrying: 'attention',
  blocked: 'error',
};

export const connectionLabels: Record<Mailbox['connectionStatus'], Text> = {
  pending: m.messaging_connection_pending,
  active: m.messaging_connection_active,
  degraded: m.messaging_connection_degraded,
  disconnected: m.messaging_connection_disconnected,
  revoked: m.messaging_connection_revoked,
};

export const ruleKinds: readonly MailboxRuleKind[] = [
  'sender_domain',
  'sender_address',
  'recipient_address',
  'label',
];

export const ruleKindLabels: Record<MailboxRuleKind, Text> = {
  sender_domain: m.messaging_rule_kind_sender_domain,
  sender_address: m.messaging_rule_kind_sender_address,
  recipient_address: m.messaging_rule_kind_recipient_address,
  label: m.messaging_rule_kind_label,
};

export const ruleKindHints: Record<MailboxRuleKind, Text> = {
  sender_domain: m.messaging_rule_hint_sender_domain,
  sender_address: m.messaging_rule_hint_sender_address,
  recipient_address: m.messaging_rule_hint_recipient_address,
  label: m.messaging_rule_hint_label,
};

export const partyKinds: readonly RuleParty['kind'][] = [
  'supplier',
  'customer',
  'other',
];

export const partyLabels: Record<RuleParty['kind'], Text> = {
  supplier: m.messaging_party_supplier,
  customer: m.messaging_party_customer,
  other: m.messaging_party_other,
};

export const recordKinds: readonly LinkedRecordKind[] = [
  'order',
  'customer',
  'supplier',
  'purchase_order',
  'case',
];

export const recordKindLabels: Record<LinkedRecordKind, Text> = {
  order: m.messaging_record_order,
  customer: m.messaging_record_customer,
  supplier: m.messaging_record_supplier,
  purchase_order: m.messaging_record_purchase_order,
  case: m.messaging_record_case,
};

/** The landmark shown beside a linked record. */
export const recordDomains: Record<LinkedRecordKind, Domain> = {
  order: 'orders',
  customer: 'customers',
  supplier: 'suppliers',
  purchase_order: 'procurement',
  case: 'issues',
};

export const linkMethodLabels: Record<LinkMethod, Text> = {
  rule: m.messaging_link_method_rule,
  address: m.messaging_link_method_address,
  reference: m.messaging_link_method_reference,
  manual: m.messaging_link_method_manual,
};

export const documentStateLabels: Record<DocumentState, Text> = {
  pending: m.messaging_document_state_pending,
  reading: m.messaging_document_state_reading,
  ready: m.messaging_document_state_ready,
  failed: m.messaging_document_state_failed,
  unsupported: m.messaging_document_state_unsupported,
  unreadable: m.messaging_document_state_unreadable,
  duplicate: m.messaging_document_state_duplicate,
};

export const documentStateText: Record<DocumentState, Text> = {
  pending: m.messaging_document_text_pending,
  reading: m.messaging_document_text_reading,
  ready: m.messaging_document_text_ready,
  failed: m.messaging_document_text_failed,
  unsupported: m.messaging_document_text_unsupported,
  unreadable: m.messaging_document_text_unreadable,
  duplicate: m.messaging_document_text_duplicate,
};

export const documentStates: Record<DocumentState, OperationalState> = {
  pending: 'waiting',
  reading: 'running',
  ready: 'idle',
  failed: 'error',
  unsupported: 'idle',
  unreadable: 'error',
  duplicate: 'idle',
};

export const factKinds: readonly FactValue['kind'][] = [
  'party',
  'reference',
  'line',
  'date',
  'amount',
];

export const factKindLabels: Record<FactValue['kind'], Text> = {
  party: m.messaging_fact_kind_party,
  reference: m.messaging_fact_kind_reference,
  line: m.messaging_fact_kind_line,
  date: m.messaging_fact_kind_date,
  amount: m.messaging_fact_kind_amount,
};

export const partyRoleLabels: Record<
  Extract<FactValue, { kind: 'party' }>['role'],
  Text
> = {
  supplier: m.messaging_party_supplier,
  customer: m.messaging_party_customer,
};

export const referenceRoleLabels: Record<
  Extract<FactValue, { kind: 'reference' }>['role'],
  Text
> = {
  purchase_order: m.messaging_record_purchase_order,
  order: m.messaging_record_order,
  invoice: m.messaging_fact_reference_invoice,
  delivery_note: m.messaging_fact_reference_delivery_note,
  other: m.messaging_fact_role_other,
};

export const dateRoleLabels: Record<
  Extract<FactValue, { kind: 'date' }>['role'],
  Text
> = {
  delivery: m.messaging_fact_date_delivery,
  shipping: m.messaging_fact_date_shipping,
  order: m.messaging_fact_date_order,
  due: m.messaging_fact_date_due,
  other: m.messaging_fact_role_other,
};

export const amountRoleLabels: Record<
  Extract<FactValue, { kind: 'amount' }>['role'],
  Text
> = {
  total: m.messaging_fact_amount_total,
  other: m.messaging_fact_role_other,
};

export const factStatusLabels: Record<Fact['status'], Text> = {
  proposed: m.messaging_fact_status_proposed,
  needs_correction: m.messaging_fact_status_needs_correction,
  confirmed: m.messaging_fact_status_confirmed,
  rejected: m.messaging_fact_status_rejected,
};

export const factStatusStates: Record<Fact['status'], OperationalState> = {
  proposed: 'approval',
  needs_correction: 'attention',
  confirmed: 'verified',
  rejected: 'idle',
};

export const changeLabels: Record<NonNullable<Fact['change']>, Text> = {
  new: m.messaging_fact_change_new,
  changed: m.messaging_fact_change_changed,
  unchanged: m.messaging_fact_change_unchanged,
};

export const confidenceLabels: Record<Fact['confidence'], Text> = {
  high: m.messaging_fact_confidence_high,
  low: m.messaging_fact_confidence_low,
};

export const originLabels: Record<Fact['origin'], Text> = {
  model: m.messaging_fact_origin_model,
  table: m.messaging_fact_origin_table,
  manual: m.messaging_fact_origin_manual,
};

export const matchLabels: Record<Fact['match']['state'], Text> = {
  matched: m.messaging_fact_match_matched,
  ambiguous: m.messaging_fact_match_ambiguous,
  unmatched: m.messaging_fact_match_unmatched,
  not_applicable: m.messaging_fact_match_not_applicable,
};

/** What each reply state means for the reader, stated without overclaiming. */
export const outboundStateText: Record<OutboundState, Text> = {
  draft: m.messaging_reply_text_draft,
  approval_required: m.messaging_reply_text_approval_required,
  approved: m.messaging_reply_text_approved,
  rejected: m.messaging_reply_text_rejected,
  expired: m.messaging_reply_text_expired,
  sending: m.messaging_reply_text_sending,
  uncertain: m.messaging_reply_text_uncertain,
  sent: m.messaging_reply_text_sent,
  failed: m.messaging_reply_text_failed,
  withheld: m.messaging_reply_text_withheld,
  discarded: m.messaging_reply_text_discarded,
};

/** Replies that are finished and no longer need a control. */
export const settledReply = (reply: Pick<Outbound, 'state'>) =>
  ['sent', 'discarded', 'rejected', 'expired', 'failed', 'withheld'].includes(
    reply.state,
  );

export const consequentialLabels: Record<
  Outbound['consequential'][number],
  Text
> = {
  date: m.messaging_reply_reason_date,
  quantity: m.messaging_reply_reason_quantity,
  money: m.messaging_reply_reason_money,
  workspace_policy: m.messaging_reply_reason_workspace_policy,
};

export const freshnessLabels: Record<Citation['freshness'], Text> = {
  fresh: m.messaging_citation_fresh,
  stale: m.messaging_citation_stale,
  missing: m.messaging_citation_missing,
};

export const freshnessStates: Record<Citation['freshness'], OperationalState> =
  {
    fresh: 'verified',
    stale: 'attention',
    missing: 'error',
  };

/** Names an address as "Name <address>", just the address, or an erased contact. */
export function addressLabel(address: MessageAddress) {
  // Customer erasure leaves an empty address in place of the person.
  if (!address.address) return m.messaging_address_erased();

  return address.name
    ? m.messaging_address_named({
        name: address.name,
        address: address.address,
      })
    : address.address;
}

/** Names the correspondent of a thread for a list row. */
export function correspondentLabel(
  thread: Pick<ThreadSummary, 'correspondent'>,
) {
  if (!thread.correspondent) return m.messaging_correspondent_unknown();

  return (
    thread.correspondent.name ||
    thread.correspondent.address ||
    m.messaging_address_erased()
  );
}

/**
 * Describes a thread's reply deadline with a text label, so overdue is never shown by color
 * alone. `none` when no reply is due.
 */
export function dueState(
  thread: Pick<ThreadSummary, 'replyDueAt' | 'overdue' | 'status'>,
): 'overdue' | 'due' | 'none' {
  if (thread.status === 'closed' || !thread.replyDueAt) return 'none';

  return thread.overdue ? 'overdue' : 'due';
}

/** Formats a fact amount in its currency without losing the stated precision in the label. */
function money(value: FactMoney) {
  const amount = Number(value.amount);

  return Number.isFinite(amount)
    ? formatCurrency(amount, value.currency, { maximumFractionDigits: 6 })
    : `${value.amount} ${value.currency}`;
}

/** A one-line reading of a fact's value, such as "12 × SKU-1 at €4.50". */
export function factText(value: FactValue): string {
  switch (value.kind) {
    case 'party':
      if (!value.name && !value.email) return m.messaging_address_erased();

      return value.email
        ? m.messaging_address_named({ name: value.name, address: value.email })
        : value.name;
    case 'reference':
      return value.text;
    case 'line': {
      const item =
        value.sku ?? value.description ?? m.messaging_fact_line_unnamed();
      const quantity = !value.quantity
        ? item
        : value.unit
          ? m.messaging_fact_line_quantity({
              quantity: formatNumber(Number(value.quantity)),
              unit: value.unit,
              item,
            })
          : m.messaging_fact_line_quantity_plain({
              quantity: formatNumber(Number(value.quantity)),
              item,
            });

      return value.unitPrice
        ? m.messaging_fact_line_price({
            line: quantity,
            price: money(value.unitPrice),
          })
        : quantity;
    }
    case 'date':
      return formatCalendarDate(value.date);
    case 'amount':
      return money(value.money);
  }
}

/** The role label of a fact, such as "Delivery date" or "Invoice". */
export function factRole(value: FactValue): string {
  switch (value.kind) {
    case 'party':
      return partyRoleLabels[value.role]();
    case 'reference':
      return referenceRoleLabels[value.role]();
    case 'line':
      return factKindLabels.line();
    case 'date':
      return dateRoleLabels[value.role]();
    case 'amount':
      return amountRoleLabels[value.role]();
  }
}

/** Groups facts by kind in a fixed order, leaving out empty groups. */
export function groupFacts(facts: readonly Fact[]) {
  return factKinds
    .map((kind) => ({
      kind,
      facts: facts.filter((fact) => fact.value.kind === kind),
    }))
    .filter((group) => group.facts.length > 0);
}

/**
 * Whether a fact can be confirmed as it stands. Facts that need correction can only be confirmed
 * with a correction; settled facts take no further review.
 */
export function confirmBlock(fact: Pick<Fact, 'status'>) {
  if (fact.status === 'needs_correction')
    return m.messaging_fact_confirm_blocked();
  if (fact.status !== 'proposed') return m.messaging_fact_confirm_settled();

  return undefined;
}

/** Names who did something on the timeline: Luma or a member. */
export function actorName(
  actor: ThreadEvent['actor'],
  name: (id: string) => string,
) {
  return actor.kind === 'luma' ? m.messaging_actor_luma() : name(actor.id);
}

const knownStatus = (value: string | undefined): ThreadStatus | undefined =>
  value === 'open' || value === 'waiting' || value === 'closed'
    ? value
    : undefined;

/**
 * Describes a timeline event. Details are read defensively: `ownerId`, `replyDueAt`, `status`,
 * `record` and `reason` refine the sentence when present, and the event still reads correctly
 * without them.
 */
export function eventText(
  event: ThreadEvent,
  helpers: {
    name: (id: string) => string;
    date: (value: string) => string;
  },
): string {
  const details = event.details;
  switch (event.type) {
    case 'received':
      return m.messaging_event_received();
    case 'sent':
      return m.messaging_event_sent();
    case 'assigned':
      return details.ownerId
        ? m.messaging_event_assigned({ name: helpers.name(details.ownerId) })
        : m.messaging_event_unassigned();
    case 'deadline_set':
      return details.replyDueAt
        ? m.messaging_event_deadline({ date: helpers.date(details.replyDueAt) })
        : m.messaging_event_deadline_automatic();
    case 'status_changed': {
      const status = knownStatus(details.status);

      return status
        ? m.messaging_event_status({ status: statusLabels[status]() })
        : m.messaging_event_status_changed();
    }
    case 'linked':
      return details.record
        ? m.messaging_event_linked({ record: details.record })
        : m.messaging_event_linked_generic();
    case 'unlinked':
      return details.record
        ? m.messaging_event_unlinked({ record: details.record })
        : m.messaging_event_unlinked_generic();
    case 'note_added':
      return m.messaging_event_note();
    case 'handed_off':
      if (details.outcome === 'forbidden')
        return m.messaging_event_handed_off_forbidden();
      if (details.outcome === 'empty')
        return m.messaging_event_handed_off_empty();
      if (details.outcome === 'truncated')
        return m.messaging_event_handed_off_truncated();

      return details.record
        ? m.messaging_event_handed_off({ record: details.record })
        : m.messaging_event_handed_off_generic();
    case 'fact_reviewed':
      return details.outcome === 'rejected'
        ? m.messaging_event_fact_rejected()
        : details.outcome === 'corrected'
          ? m.messaging_event_fact_corrected()
          : m.messaging_event_fact_confirmed();
    case 'reply_requested':
      return m.messaging_event_reply_requested();
    case 'reply_approved':
      return m.messaging_event_reply_approved();
    case 'reply_rejected':
      return m.messaging_event_reply_rejected();
    case 'reply_withheld':
      return details.reason
        ? m.messaging_event_reply_withheld_reason({ reason: details.reason })
        : m.messaging_event_reply_withheld();
    case 'delivery_resolved':
      if (details.source === 'reply')
        return m.messaging_event_delivery_confirmed_by_reply();

      return details.outcome === 'not_delivered'
        ? m.messaging_event_delivery_marked_not_delivered()
        : m.messaging_event_delivery_marked_delivered();
    case 'text_removed':
      return m.messaging_event_text_removed();
  }
}

/** Formats a byte size such as "240 KB". */
export function fileSize(bytes: number) {
  if (bytes < 1024)
    return m.messaging_size_bytes({ size: formatNumber(bytes) });
  if (bytes < 1024 * 1024)
    return m.messaging_size_kb({
      size: formatNumber(bytes / 1024, { maximumFractionDigits: 0 }),
    });

  return m.messaging_size_mb({
    size: formatNumber(bytes / (1024 * 1024), { maximumFractionDigits: 1 }),
  });
}

/** A cell reference such as "B4" or the range "B4:D6", for people. */
export function cellRange(locator: {
  sheet: string;
  row: number;
  rowEnd: number;
  column: number;
  columnEnd: number;
}) {
  const start = `${columnName(locator.column)}${locator.row}`;
  const end = `${columnName(locator.columnEnd)}${locator.rowEnd}`;

  return start === end ? start : `${start}:${end}`;
}

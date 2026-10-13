import type {
  DecisionDomain,
  DecisionItem,
  DecisionKind,
  DecisionReason,
  DecisionView,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import type { Domain } from '@luma/ui/components/primitives/domain-icon';
import type { PersonOption } from '@luma/ui/components/primitives/person-picker';
import type { OperationalState } from '@luma/ui/components/primitives/state';

import { caseStageLabels } from '../returns/case-presentation';

export const viewLabels: Record<DecisionView, () => string> = {
  all: m.decisions_view_all,
  mine: m.decisions_view_mine,
  unassigned: m.decisions_view_unassigned,
};

export const domainLabels: Record<DecisionDomain, () => string> = {
  orders: m.decisions_domain_orders,
  fulfillment: m.decisions_domain_fulfillment,
  inventory: m.decisions_domain_inventory,
  procurement: m.decisions_domain_procurement,
  operations: m.decisions_domain_operations,
};

export const reasonLabels: Record<DecisionReason, () => string> = {
  approval: m.decisions_reason_approval,
  run: m.decisions_reason_run,
  recovery: m.decisions_reason_recovery,
  manual_intervention: m.decisions_reason_manual,
  uncertainty: m.decisions_reason_uncertainty,
};

export const kindLabels: Record<DecisionKind, () => string> = {
  case: m.decisions_kind_case,
  custom_field: m.adaptive_field_change,
  return_case: m.returns_case_title_fallback,
  replenishment: m.decisions_kind_replenishment,
  fulfillment_recovery: m.decisions_kind_fulfillment_recovery,
  inventory_correction: m.decisions_kind_inventory_correction,
  order_edit: m.decisions_kind_order_edit,
  shipment_publication: m.decisions_kind_shipment_publication,
  supplier_commitment: m.decisions_kind_supplier_commitment,
  human_task: m.authoring_coordination_human_label,
  workflow_handover: m.decisions_kind_workflow_handover,
  message_reply: m.decisions_kind_message_reply,
};

/** The landmark shown for a decision's operational area. */
export const domainIcons: Record<DecisionDomain, Domain> = {
  orders: 'orders',
  fulfillment: 'fulfillment',
  inventory: 'inventory',
  procurement: 'procurement',
  operations: 'issues',
};

export const impactLabels: Record<
  DecisionItem['impact']['level'],
  () => string
> = {
  high: m.decisions_impact_high,
  medium: m.decisions_impact_medium,
  low: m.decisions_impact_low,
  unknown: m.decisions_impact_unknown,
};

export const evidenceLabels: Record<
  DecisionItem['evidence']['state'],
  () => string
> = {
  fresh: m.decisions_evidence_fresh,
  stale: m.decisions_evidence_stale,
  unknown: m.decisions_evidence_unknown,
};

/**
 * Says where a decision stands for this reader. Only `decide`, `run`, `check` and `investigate`
 * ask the reader to act; the others explain who the decision waits for.
 */
export function decisionStatus(
  item: Pick<DecisionItem, 'reason' | 'response'> &
    Partial<Pick<DecisionItem, 'kind'>>,
): {
  state: OperationalState;
  label: string;
} {
  switch (item.response) {
    case 'decide':
      return { state: 'approval', label: m.decisions_status_decide() };
    case 'run':
      return { state: 'attention', label: m.decisions_status_run() };
    case 'check':
      return { state: 'attention', label: m.decisions_status_check() };
    case 'awaiting_other':
      return { state: 'waiting', label: m.decisions_status_awaiting_other() };
    case 'investigate':
      return item.reason === 'manual_intervention'
        ? { state: 'attention', label: m.decisions_status_manual() }
        : item.reason === 'approval'
          ? { state: 'attention', label: m.decisions_status_expired() }
          : { state: 'attention', label: m.decisions_status_review() };
    case 'view_only':
      if (item.kind === 'return_case')
        return { state: 'idle', label: m.authoring_editor_view_only() };

      return item.reason === 'run'
        ? { state: 'waiting', label: m.decisions_status_waiting_requester() }
        : item.reason === 'recovery'
          ? { state: 'attention', label: m.decisions_status_unconfirmed() }
          : { state: 'waiting', label: m.decisions_status_waiting_approver() };
  }
}

/** Whether the reader is the one who can move this decision forward now. */
export const actionable = (item: Pick<DecisionItem, 'response'>) =>
  ['decide', 'run', 'check', 'investigate'].includes(item.response);

/** Describes the time left before a proposal loses its authority, such as `4m left`. */
export function timeLeft(deadline: string, now: number) {
  const ms = Date.parse(deadline) - now;
  if (ms <= 0) return m.decisions_time_expired();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return m.decisions_time_under_minute();
  if (minutes < 60) return m.decisions_time_minutes({ minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return m.decisions_time_hours({ hours });

  return m.decisions_time_days({ days: Math.floor(hours / 24) });
}

/**
 * Groups items with the same cause while keeping the queue's ranking: groups appear in the
 * order of their most urgent item.
 */
export function groupDecisions(items: readonly DecisionItem[]) {
  const groups = new Map<
    string,
    { key: string; label: string; items: DecisionItem[] }
  >();
  for (const item of items) {
    const group = groups.get(item.group.key) ?? {
      ...item.group,
      items: [],
    };
    group.items.push(item);
    groups.set(item.group.key, group);
  }

  return [...groups.values()];
}

/** Explains an empty queue for this view without implying operations are healthy. */
export function emptyCopy(view: DecisionView, filtered: boolean) {
  if (filtered)
    return {
      title: m.decisions_empty_filtered_title(),
      text: m.decisions_empty_filtered_text(),
    };
  if (view === 'mine')
    return {
      title: m.decisions_empty_mine_title(),
      text: m.decisions_empty_mine_text(),
    };
  if (view === 'unassigned')
    return {
      title: m.decisions_empty_unassigned_title(),
      text: m.decisions_empty_unassigned_text(),
    };

  return {
    title: m.decisions_empty_all_title(),
    text: m.decisions_empty_all_text(),
  };
}

/** Names a workspace member for display, falling back to a short ID for former members. */
export function memberName(
  id: string | null | undefined,
  members: readonly {
    userId: string;
    name?: string | undefined;
    email?: string | undefined;
  }[],
  self: string | undefined,
) {
  if (!id) return null;
  if (id === self) return m.decisions_member_you();
  const member = members.find((entry) => entry.userId === id);

  return member?.name || member?.email || m.decisions_member_former();
}

/**
 * Lists the people a decision can be handed to, leaving out its current holder. The reader comes
 * first as "You", with their own name and email underneath so a search for either finds them.
 */
export function assigneeOptions(
  members: readonly {
    userId: string;
    name?: string | undefined;
    email?: string | undefined;
  }[],
  holder: string | null,
  self: string | undefined,
): PersonOption[] {
  const people = members
    .filter((member) => member.userId !== holder)
    .map((member) =>
      member.userId === self
        ? {
            id: member.userId,
            name: m.decisions_member_you(),
            detail:
              [member.name, member.email].filter(Boolean).join(' · ') ||
              undefined,
          }
        : {
            id: member.userId,
            name: member.name || member.email || m.decisions_member_fallback(),
            detail: member.name ? member.email : undefined,
          },
    );

  return people.sort((a, b) => Number(b.id === self) - Number(a.id === self));
}

/** Localizes owned return work without changing its authority or evidence. */
export function localizeReturnDecision(item: DecisionItem): DecisionItem {
  if (item.owner.kind === 'workflow_run' && item.owner.followUpProposalId)
    return {
      ...item,
      title: m.decisions_follow_up_title(),
      why:
        item.reason === 'recovery'
          ? m.decisions_follow_up_stale()
          : m.decisions_follow_up_why(),
      consequences: [
        {
          response: m.issues_decision_approve(),
          text: m.decisions_follow_up_approve_text(),
        },
        {
          response: m.issues_decision_reject(),
          text: m.decisions_follow_up_reject_text(),
        },
      ],
      subject: { ...item.subject, label: m.decisions_follow_up_group() },
      group: { ...item.group, label: m.decisions_follow_up_group() },
    };
  if (item.kind !== 'return_case') return item;
  const stage = item.change.find((fact) => fact.label === 'Stage')?.value;

  return {
    ...item,
    why:
      item.reason === 'approval'
        ? m.returns_service_queue_approval()
        : item.reason === 'uncertainty'
          ? m.returns_service_queue_uncertain()
          : item.change.some(
                (fact) =>
                  fact.label === 'Exchange completion' &&
                  fact.value === 'unresolved',
              )
            ? m.returns_exchange_complete_unresolved()
            : m.returns_service_queue_manual(),
    consequences: [
      {
        response: m.returns_service_open_case(),
        text: m.returns_service_queue_consequence(),
      },
    ],
    change: item.change.map((fact) =>
      fact.label === 'Units'
        ? { label: m.returns_case_open_units(), value: fact.value }
        : fact.label === 'Stage'
          ? {
              label: m.returns_column_stage(),
              value:
                Object.entries(caseStageLabels).find(
                  ([key]) => key === stage,
                )?.[1] ?? m.common_not_reported(),
            }
          : fact.label === 'Exchange completion'
            ? {
                label: m.returns_exchange_consistency_title(),
                value: m.returns_exchange_complete_unresolved(),
              }
            : fact,
    ),
    group: { ...item.group, label: m.returns_service_cases() },
  };
}

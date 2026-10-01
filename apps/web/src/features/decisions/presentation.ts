import type {
  DecisionDomain,
  DecisionItem,
  DecisionKind,
  DecisionReason,
  DecisionView,
} from '@luma/api-contract';
import type { Domain } from '@luma/ui/components/primitives/domain-icon';
import type { OperationalState } from '@luma/ui/components/primitives/state';

export const viewLabels: Record<DecisionView, string> = {
  all: 'All',
  mine: 'Assigned to me',
  unassigned: 'Unassigned',
};

export const domainLabels: Record<DecisionDomain, string> = {
  orders: 'Orders',
  fulfillment: 'Fulfillment',
  inventory: 'Inventory',
  procurement: 'Procurement',
  operations: 'Other operations',
};

export const reasonLabels: Record<DecisionReason, string> = {
  approval: 'Approvals',
  run: 'Ready to run',
  recovery: 'Outcome checks',
  manual_intervention: 'Manual steps',
  uncertainty: 'Reviews',
};

export const kindLabels: Record<DecisionKind, string> = {
  case: 'Issue',
  replenishment: 'Replenishment',
  fulfillment_recovery: 'Fulfillment recovery',
  inventory_correction: 'Stock correction',
  supplier_commitment: 'Supplier order',
};

/** The landmark shown for a decision's operational area. */
export const domainIcons: Record<DecisionDomain, Domain> = {
  orders: 'orders',
  fulfillment: 'fulfillment',
  inventory: 'inventory',
  procurement: 'procurement',
  operations: 'issues',
};

export const impactLabels: Record<DecisionItem['impact']['level'], string> = {
  high: 'High impact',
  medium: 'Medium impact',
  low: 'Low impact',
  unknown: 'Impact not assessed',
};

export const evidenceLabels: Record<DecisionItem['evidence']['state'], string> =
  {
    fresh: 'Current evidence',
    stale: 'Evidence expired',
    unknown: 'Evidence age unknown',
  };

/**
 * Says where a decision stands for this reader. Only `decide`, `run`, `check` and `investigate`
 * ask the reader to act; the others explain who the decision waits for.
 */
export function decisionStatus(
  item: Pick<DecisionItem, 'reason' | 'response'>,
): {
  state: OperationalState;
  label: string;
} {
  switch (item.response) {
    case 'decide':
      return { state: 'approval', label: 'Needs your approval' };
    case 'run':
      return { state: 'attention', label: 'Ready for you to run' };
    case 'check':
      return { state: 'attention', label: 'Check the outcome' };
    case 'awaiting_other':
      return { state: 'waiting', label: 'Needs another approver' };
    case 'investigate':
      return item.reason === 'manual_intervention'
        ? { state: 'attention', label: 'Needs a manual step' }
        : item.reason === 'approval'
          ? { state: 'attention', label: 'Proposal expired' }
          : { state: 'attention', label: 'Needs review' };
    case 'view_only':
      return item.reason === 'run'
        ? { state: 'waiting', label: 'Waiting for the requester' }
        : item.reason === 'recovery'
          ? { state: 'attention', label: 'Outcome unconfirmed' }
          : { state: 'waiting', label: 'Waiting for an approver' };
  }
}

/** Whether the reader is the one who can move this decision forward now. */
export const actionable = (item: Pick<DecisionItem, 'response'>) =>
  ['decide', 'run', 'check', 'investigate'].includes(item.response);

/** Describes the time left before a proposal loses its authority, such as `4 min left`. */
export function timeLeft(deadline: string, now: number) {
  const ms = Date.parse(deadline) - now;
  if (ms <= 0) return 'Expired';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'Under a minute left';
  if (minutes < 60) return `${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h left`;

  return `${Math.floor(hours / 24)} days left`;
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
      title: 'No matching decisions',
      text: 'Clear the filters to see everything that needs a person.',
    };
  if (view === 'mine')
    return {
      title: 'Nothing is assigned to you',
      text: 'Take a decision from All or Unassigned to look after it.',
    };
  if (view === 'unassigned')
    return {
      title: 'Every decision has an owner',
      text: 'Check All to see who is looking after each one.',
    };

  return {
    title: 'Nothing needs a person right now',
    text: 'Luma lists approvals, manual steps and outcome checks here as soon as it needs someone. Connection health is shown on Home.',
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
  if (id === self) return 'You';
  const member = members.find((m) => m.userId === id);

  return member?.name || member?.email || 'Former member';
}

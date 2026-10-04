import type { StockMetricItem } from './metrics.js';

export type StockReason = NonNullable<StockMetricItem['reason']>;

/** Explains why stock can't support a replenishment decision, in operator language. */
export function stockReasonMessage(reason: StockReason): string {
  switch (reason) {
    case 'missing':
      return 'Luma has no stock read from the configured source. Check that the inventory connection still has access.';
    case 'deleted':
      return 'The source no longer lists this stock position. Check its mapping at the source.';
    case 'nonnumeric':
      return 'The source reported a quantity Luma can’t read as a number.';
    case 'future':
    case 'invalid_time':
      return 'The latest stock read has an invalid time. Refresh the source.';
    case 'expired':
      return 'The latest stock read is older than five minutes, so Luma won’t propose an order. Check that the source is syncing.';
  }
}

/** Whether one rule's stock can support a decision now. Revoked rules never run. */
export interface RuleState {
  state: 'ready' | 'blocked' | 'revoked';
  code: 'ready' | 'revoked' | StockReason;
  message: string;
}

/** Derives a rule's state from the shared stock rule used by Insights and the run itself. */
export function ruleState(
  active: boolean,
  reason: StockMetricItem['reason'],
): RuleState {
  if (!active)
    return {
      state: 'revoked',
      code: 'revoked',
      message: 'This rule was revoked. Luma no longer checks this position.',
    };
  if (reason)
    return {
      state: 'blocked',
      code: reason,
      message: stockReasonMessage(reason),
    };

  return {
    state: 'ready',
    code: 'ready',
    message: 'Stock is fresh. Luma checks it against the minimum.',
  };
}

/** Describes a process run state as a replenishment result. */
export function replenishmentOutcome(state: string | undefined): string {
  switch (state) {
    case 'verified':
      return 'The purchase-order draft was independently verified.';
    case 'failed_verification':
      return 'The purchase order differs from the proposal.';
    case 'inconclusive_verification':
      return 'The purchase-order result couldn’t be confirmed.';
    case 'escalated':
      return 'The run stopped and handed over to a person.';
    case 'denied':
      return 'The proposal was rejected or wasn’t allowed.';
    case 'ended':
      return 'No order was needed, or an existing order already covers the SKU.';
    case 'awaiting_decision':
      return 'The proposal is waiting for approval.';
    default:
      return 'The run is in progress.';
  }
}

/** Business descriptions of the built-in steps, keyed by step ID. */
export const replenishmentStepCopy: Record<
  string,
  { title: string; description: string }
> = {
  inventory: {
    title: 'Read current stock',
    description:
      'Reads the available quantity, SKU and unit for the configured stock position.',
  },
  'fresh-stock': {
    title: 'Stop on old stock',
    description:
      'Hands the run to a person when stock is older than five minutes or unreadable. Nothing is ordered.',
  },
  proposal: {
    title: 'Work out the order',
    description:
      'Calculates the quantity that brings stock back to the target and looks for draft or open purchase orders for the same SKU.',
  },
  'needs-order': {
    title: 'Skip when already covered',
    description:
      'Finishes without ordering when stock is at or above the minimum or another order already covers the SKU.',
  },
  'create-order': {
    title: 'Create a purchase-order draft',
    description:
      'After a different owner or admin approves, records a draft for the rule’s supplier. Nothing is sent to the supplier.',
  },
  'verify-order': {
    title: 'Check the draft independently',
    description:
      'Reads the purchase order back to confirm its supplier, SKU, quantity and draft status.',
  },
  complete: {
    title: 'Done',
    description: 'The purchase-order draft exists and is verified.',
  },
};

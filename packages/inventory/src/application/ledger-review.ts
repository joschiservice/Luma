import {
  hasPermission,
  type Permission,
  type TenantContext,
} from '@luma/identity';

import type { LedgerReview } from './ledger.js';

/**
 * Permissions a reviewer of a prepared stock change needs: reading and approving stock, and
 * managing procurement when the change books a purchase receipt.
 */
export function ledgerReviewPermissions(
  review: Pick<LedgerReview, 'command'>,
): Permission[] {
  return [
    'inventory.read',
    'inventory.approve',
    ...(review.command.purchaseReceipt
      ? (['procurement.manage'] as const)
      : []),
  ];
}

/**
 * Four-eyes rule for prepared stock changes: another member than the one who prepared it, with
 * every permission in `ledgerReviewPermissions`, may approve or reject it.
 */
export function canReviewLedgerChange(
  context: TenantContext,
  review: Pick<LedgerReview, 'command' | 'preparedBy'>,
) {
  return (
    review.preparedBy !== context.actor.id &&
    ledgerReviewPermissions(review).every((permission) =>
      hasPermission(context, permission),
    )
  );
}

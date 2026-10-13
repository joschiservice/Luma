import type { FollowUp } from './commitments.js';

/** Immutable internal note text; it claims only a future check, never a supplier send or resolution. */
export function supplierFollowUpNote(nextCheckAt: string): string {
  return `Luma’s supplier follow-up checks this order again at ${nextCheckAt.slice(11, 16)} UTC.`;
}

/** Independently observed receipt must match the exact bound note and responsible member. */
export function followUpReceiptMatches(
  expected: {
    tenantId: string;
    orderId: string;
    followUpId: string;
    key: string;
    nextCheckAt: string;
    requestedBy: string;
  },
  receipt: FollowUp | undefined,
): boolean {
  return (
    !!receipt &&
    receipt.tenantId === expected.tenantId &&
    receipt.purchaseOrderId === expected.orderId &&
    receipt.id === expected.followUpId &&
    receipt.key === expected.key &&
    receipt.response === 'following_up' &&
    receipt.nextCheckAt === expected.nextCheckAt &&
    receipt.respondedBy === expected.requestedBy &&
    receipt.note === supplierFollowUpNote(expected.nextCheckAt)
  );
}

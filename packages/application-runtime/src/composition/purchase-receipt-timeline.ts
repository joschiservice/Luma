import { hasPermission, type TenantContext } from '@luma/identity';
import type { LedgerService } from '@luma/inventory';
import { ServiceError } from '@luma/platform';
import type { PurchasingTimelineEntry } from '@luma/procurement';

/** Adds Inventory's reviewed receipts and independent current readback without posting stock. */
export function createPurchaseReceiptTimeline(ledger: () => LedgerService) {
  return async (
    context: TenantContext,
    orderId: string,
  ): Promise<PurchasingTimelineEntry[]> => {
    if (!hasPermission(context, 'inventory.read')) return [];
    const { items } = await ledger().purchaseReceiptReviews(context, orderId, {
      includeHistory: true,
    });
    const entries: PurchasingTimelineEntry[] = [];
    for (const review of items) {
      const receipt = review.command.purchaseReceipt;
      if (!receipt) continue;
      entries.push({
        id: `native-receipt:${review.id}:review`,
        kind: 'stock_booking',
        stage:
          review.state === 'approved'
            ? 'approved'
            : review.state === 'rejected'
              ? 'rejected'
              : 'approval_required',
        at: review.reviewedAt ?? review.createdAt,
        actorId: review.reviewedBy ?? review.preparedBy,
        reason: review.command.reason,
        evidenceRefs: [
          review.id,
          receipt.commitmentId,
          ...(receipt.damagedCommitmentId ? [receipt.damagedCommitmentId] : []),
        ],
        quantity: Number(receipt.cumulativeGood),
        unit:
          review.command.postings.find((p) => p.account.state === 'available')
            ?.account.unit ?? null,
        revision: null,
        detail: null,
        source: 'inventory',
      });
      if (review.state !== 'approved') continue;
      try {
        const proof = await ledger().verifyPurchaseReceipt(context, review.id);
        if (!proof.receipt) continue;
        entries.push({
          id: `native-receipt:${review.id}:proof`,
          kind: 'stock_booking',
          stage: proof.outcome === 'verified' ? 'verified' : 'uncertain',
          at: proof.observedAt,
          actorId: null,
          reason: null,
          evidenceRefs: proof.evidenceRefs,
          quantity: Number(receipt.cumulativeGood),
          unit:
            review.command.postings.find((p) => p.account.state === 'available')
              ?.account.unit ?? null,
          revision: null,
          detail: null,
          source: 'inventory',
        });
      } catch (error) {
        if (error instanceof ServiceError && error.statusCode === 404) continue;
        throw error;
      }
    }

    return entries;
  };
}

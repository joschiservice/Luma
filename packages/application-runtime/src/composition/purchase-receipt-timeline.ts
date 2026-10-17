import { hasPermission, type TenantContext } from '@luma/identity';
import type { LedgerService, PurchaseReceiptStage } from '@luma/inventory';
import { ServiceError } from '@luma/platform';
import {
  nativeReceiptEntryId,
  nativeReceiptProofStage,
  nativeReceiptReviewStage,
  type PurchasingTimelineEntry,
  restrictedNativeReceiptBookings,
} from '@luma/procurement';

/**
 * Adds Inventory's reviewed receipts and independent current readback without posting stock.
 * Inventory readers get each review with what it books; other procurement readers get the
 * restricted stages Inventory reports without them.
 */
export function createPurchaseReceiptTimeline(
  ledger: () => Pick<
    LedgerService,
    'purchaseReceiptReviews' | 'verifyPurchaseReceipt'
  >,
  stages: (
    context: TenantContext,
    orderId: string,
  ) => Promise<PurchaseReceiptStage[]>,
) {
  return async (
    context: TenantContext,
    orderId: string,
  ): Promise<PurchasingTimelineEntry[]> => {
    if (!hasPermission(context, 'inventory.read'))
      return restrictedNativeReceiptBookings(await stages(context, orderId));
    const { items } = await ledger().purchaseReceiptReviews(context, orderId, {
      includeHistory: true,
    });
    const entries: PurchasingTimelineEntry[] = [];
    for (const review of items) {
      const receipt = review.command.purchaseReceipt;
      if (!receipt) continue;
      entries.push({
        id: nativeReceiptEntryId(review.id, 'review'),
        kind: 'stock_booking',
        stage: nativeReceiptReviewStage(review.state),
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
          id: nativeReceiptEntryId(review.id, 'proof'),
          kind: 'stock_booking',
          stage: nativeReceiptProofStage(proof.outcome),
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

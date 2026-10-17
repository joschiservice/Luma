import type { TenantContext } from '@luma/identity';

import type { PurchasingPlan } from '../domain/purchasing.js';
import type { SupplierCommitments } from './commitments.js';

/**
 * Accepts the source order's shortfall once a reorder covering its remainder is verified, so the
 * shortfall leaves the supplier follow-up queue. Expects a plan made from a shortfall: it names
 * the source order and its attention key.
 */
export function createShortfallAcknowledgement(
  commitments: () => Pick<SupplierCommitments, 'respond'>,
) {
  return async (context: TenantContext, plan: PurchasingPlan) => {
    await commitments().respond(context, plan.request.sourceOrderId!, {
      id: plan.id,
      key: plan.request.attentionKey!,
      response: 'accepted',
      note: `Remainder covered by verified draft ${plan.order.reference}`,
      nextCheckAt: null,
    });
  };
}

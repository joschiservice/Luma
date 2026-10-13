import type { TenantContext } from '@luma/identity';

import type { DecisionProvider } from '../../application/decisions.js';

export interface ProcurementActionDecision {
  id: string;
  kind: 'plan' | 'revision' | 'native_receipt';
  orderId: string | null;
  reference: string;
  state: 'approval_required' | 'approved' | 'uncertain';
  requestedBy: string;
  requestedAt: string;
  expiresAt: string | null;
  canApprove: boolean;
  quantity: number | null;
}

/** Presents persisted purchasing actions without reading providers or granting execution authority. */
export function procurementActionDecisionProvider(
  pending: (context: TenantContext) => Promise<ProcurementActionDecision[]>,
): DecisionProvider {
  return {
    id: 'purchasing-actions',
    label: 'Purchasing actions',
    permission: 'procurement.read',
    pending: async (context) =>
      (await pending(context)).map((item) => ({
        id: `purchasing:${item.kind}:${item.id}`,
        ...(item.kind !== 'native_receipt'
          ? {
              actionReference: {
                runId: item.id,
                stepId: item.kind === 'plan' ? 'create-order' : 'revise-order',
              },
            }
          : {}),
        kind: 'supplier_commitment',
        domain: item.kind === 'native_receipt' ? 'inventory' : 'procurement',
        reason:
          item.state === 'uncertain'
            ? 'uncertainty'
            : item.state === 'approved'
              ? 'run'
              : 'approval',
        title:
          item.kind === 'plan'
            ? 'Review supplier purchase-order draft'
            : item.kind === 'revision'
              ? 'Review supplier order revision'
              : 'Review received native stock',
        why:
          item.state === 'uncertain'
            ? 'An independent read must settle this action before any new write.'
            : item.state === 'approved'
              ? 'This approved action still needs its requester to complete it.'
              : 'Review the exact quantities and evidence before approving.',
        consequences: [
          {
            response: 'Review',
            text: 'Opens the owner’s current approval and verification controls.',
          },
        ],
        change:
          item.quantity === null
            ? []
            : [{ label: 'Quantity', value: String(item.quantity) }],
        impact: { level: 'unknown', text: null },
        requestedAt: item.requestedAt,
        deadline: item.expiresAt,
        requesterId: item.requestedBy,
        evidence: { observedAt: item.requestedAt, validUntil: item.expiresAt },
        response:
          item.state === 'uncertain'
            ? 'check'
            : item.state === 'approved'
              ? context.actor.id === item.requestedBy
                ? 'run'
                : 'awaiting_other'
              : item.canApprove
                ? 'decide'
                : 'awaiting_other',
        subject: { label: item.reference, detail: null },
        record: null,
        owner: item.orderId
          ? { kind: 'purchase_order', purchaseOrderId: item.orderId }
          : { kind: 'purchasing_plan', planId: item.id },
        group: {
          key: `purchasing:${item.kind}`,
          label:
            item.kind === 'native_receipt' ? 'Received stock' : 'Purchasing',
        },
      })),
  };
}

import { isAppPermission, type TenantContext } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
import { sqlUuid } from '@luma/platform';
import type { Approval, ProposedAction } from '@luma/policies';

import type { PurchaseOrder } from '../domain/procurement.js';
import { replenishmentApprovalCoversSend } from '../domain/replenishment-approval.js';

/** Reads a prior human grant only for an unchanged, verified replenishment draft and its reviewed supplier destination. */
export function createReplenishmentApprovalCoverage(
  db: TenantDatabase,
  refreshApprover: (
    userId: string,
    tenantId: string,
    requestId: string,
  ) => Promise<TenantContext>,
) {
  return async (
    context: TenantContext,
    action: ProposedAction,
    policyVersion: string,
    permission: string,
  ): Promise<Approval | null> => {
    if (
      action.capability !== 'purchase-orders.submit' ||
      typeof action.parameters.purchaseOrderId !== 'string'
    )
      return null;
    const row = await db.transaction(
      context.tenantId,
      async (tx) =>
        (
          await tx.query<{
            order: PurchaseOrder;
            draft: ProposedAction;
            approval: Approval;
            link: {
              connectionId: string;
              externalId: string;
              scopeKey: string;
            } | null;
            rule: {
              separateSend: boolean;
              threshold: { amount: string; currency: string } | null;
            };
          }>(
            `SELECT p.document AS "order",a.document->'action' AS draft,g.document AS approval,
       s.document->'link' AS link,COALESCE(ws.replenishment_approval,'{"separateSend":false,"threshold":null}'::jsonb) AS rule
       FROM procurement_purchase_orders p
       JOIN LATERAL (SELECT step.tenant_id,step.proposal_id,step.document FROM action_admission_steps step WHERE step.tenant_id=p.tenant_id AND step.proposal_id=${sqlUuid("p.document->'origin'->>'actionId'")} LIMIT 1) a ON true
       JOIN policy_approvals g ON g.tenant_id=a.tenant_id AND g.proposal_id=a.proposal_id AND g.action_hash=a.document->>'actionHash'
       JOIN executed_actions x ON x.tenant_id=a.tenant_id AND x.proposal_id=a.proposal_id AND x.action_hash=g.action_hash
       JOIN LATERAL (SELECT supplier.document FROM procurement_suppliers supplier WHERE supplier.tenant_id=p.tenant_id AND supplier.id=${sqlUuid("p.document->>'supplierId'")} LIMIT 1) s ON true
       LEFT JOIN workspace_settings ws ON ws.tenant_id=p.tenant_id
       WHERE p.tenant_id=$1 AND p.id=${sqlUuid('$2::text')} AND g.document->>'policyVersion'=$3
        AND g.document->>'outcome'='approved' AND x.document->>'state'='succeeded'
        AND x.document->'attempt'->'verification'->>'outcome'='passed'
       ORDER BY g.created_at DESC LIMIT 1`,
            [
              context.tenantId,
              action.parameters.purchaseOrderId,
              policyVersion,
            ],
          )
        ).rows[0],
    );
    if (
      !row ||
      !replenishmentApprovalCoversSend({
        order: row.order,
        draft: row.draft,
        grant: row.approval,
        destination: row.link,
        actorId: context.actor.id,
        connectionId: action.connectionId,
        supplierId: action.parameters.supplierId,
        supplierScope: action.parameters.supplierScope,
        rule: row.rule,
        now: Date.now(),
      })
    )
      return null;
    try {
      const approver = await refreshApprover(
        row.approval.approverId,
        context.tenantId,
        context.requestId,
      );
      if (
        !approver.permissions.has('decisions.respond') ||
        (isAppPermission(permission) && !approver.permissions.has(permission))
      )
        return null;
    } catch {
      return null;
    }

    return row.approval;
  };
}

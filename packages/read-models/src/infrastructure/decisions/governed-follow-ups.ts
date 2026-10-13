import type { TenantContext } from '@luma/identity';
import { hasPermission } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import type { DecisionProvider } from '../../application/decisions.js';

interface PendingFollowUp {
  id: string;
  orderId: string;
  workflowRunId: string;
  observedAt: string;
  expiresAt: string;
  createdAt: string;
  requestedBy: string;
  review: {
    stale: boolean;
    outcome: 'allowed' | 'denied' | 'approval_required' | null;
  };
}

/** Adds immutable internal notes to the same review queue, retaining original workflow links. */
export function governedFollowUpDecisionProvider(
  database: TenantDatabase,
  pending: (context: TenantContext) => Promise<PendingFollowUp[]>,
): DecisionProvider {
  return {
    id: 'governed-supplier-follow-ups',
    label: 'Supplier follow-up notes',
    permission: 'procurement.manage',
    async pending(context) {
      const plans = (await pending(context)).slice(0, 100);
      if (!plans.length) return [];
      const definitions = await database.transaction(
        context.tenantId,
        async (tx) =>
          new Map(
            (
              await tx.query<{ id: string; definition_id: string }>(
                'SELECT id,definition_id FROM workflow_trigger_runs WHERE tenant_id=$1 AND id=ANY($2::uuid[])',
                [context.tenantId, plans.map((plan) => plan.workflowRunId)],
              )
            ).rows.map((run) => [run.id, run.definition_id]),
          ),
      );

      return plans.flatMap((plan) => {
        const definitionId = definitions.get(plan.workflowRunId);
        if (!definitionId) return [];
        const independent = plan.requestedBy !== context.actor.id;

        return [
          {
            id: `governed-follow-up:${plan.id}`,
            actionReference: { proposalId: plan.id },
            kind: 'supplier_commitment' as const,
            reason: plan.review.stale
              ? ('recovery' as const)
              : ('approval' as const),
            domain: 'procurement' as const,
            title: 'Review supplier follow-up note',
            why: plan.review.stale
              ? 'The order or policy changed. The workflow requester must prepare a new proposal.'
              : 'The workflow proposes an internal follow-up note. It does not contact the supplier.',
            consequences: [
              {
                response: 'Approve',
                text: 'Allow this exact internal note after current permissions, policy and evidence are checked again.',
              },
              {
                response: 'Reject',
                text: 'Prevent this proposed note from being recorded.',
              },
            ],
            change: [],
            impact: { level: 'low' as const, text: null },
            requestedAt: plan.createdAt,
            deadline: plan.expiresAt,
            requesterId: plan.requestedBy,
            evidence: {
              observedAt: plan.observedAt,
              validUntil: plan.expiresAt,
            },
            response: plan.review.stale
              ? !independent
                ? ('investigate' as const)
                : ('view_only' as const)
              : plan.review.outcome === 'approval_required'
                ? independent && hasPermission(context, 'decisions.respond')
                  ? ('decide' as const)
                  : ('awaiting_other' as const)
                : ('view_only' as const),
            subject: { label: 'Supplier follow-up', detail: null },
            record: null,
            owner: {
              kind: 'workflow_run' as const,
              definitionId,
              runId: plan.workflowRunId,
              followUpProposalId: plan.id,
            },
            group: {
              key: `supplier-follow-up:${definitionId}`,
              label: 'Supplier follow-up notes',
            },
          },
        ];
      });
    },
  };
}

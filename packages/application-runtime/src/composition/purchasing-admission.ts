import type { PurchasingPlan } from '@luma/api-contract';
import type { EffectRegistry } from '@luma/connections';
import { AdmissionRejected } from '@luma/execution';
import { parseAction } from '@luma/execution/composition';
import type { ProposedAction } from '@luma/policies';
import type { PurchasingAdmission } from '@luma/procurement/composition';

import type { createSafetyServices } from './services.js';

/** Derives the exact persisted plan action, with stable effect and draft identities. */
function actionFor(plan: PurchasingPlan): ProposedAction {
  return {
    schemaVersion: 1,
    id: plan.actionId,
    tenantId: plan.tenantId,
    capability: 'procurement.purchase-order.create',
    capabilityVersion: '1',
    connectionId: plan.tenantId,
    target: { kind: 'purchase_order', id: plan.order.id },
    parameters: {
      supplierId: plan.order.supplierId,
      reference: plan.order.reference,
      lines: JSON.stringify(plan.order.lines),
      actionId: plan.actionId,
      outcomeId: plan.id,
      ...(plan.request.sourceOrderId
        ? {
            sourcePurchaseOrderId: plan.request.sourceOrderId,
            sourceAttentionKey: plan.request.attentionKey!,
          }
        : {}),
    },
    expectedPostcondition: { status: 'draft' },
    preconditions: {
      evidenceRefs: plan.suggestions.flatMap((s) => s.evidenceRefs),
      validUntil: plan.expiresAt,
    },
    risk: 'medium',
    proposedBy: { kind: 'user', id: plan.requestedBy },
    expiresAt: plan.expiresAt,
  };
}

/** Reuses policy, Action Admission and idempotent execution for a reviewed supplier plan. */
export function createPurchasingAdmission(
  safety: ReturnType<typeof createSafetyServices>,
  effects: EffectRegistry,
): PurchasingAdmission {
  return {
    async prepare(context, plan) {
      const action = actionFor(plan);
      const artifact = await safety.provisioning.activate(context, {
        id: 'purchasing-plan',
        version: '1',
        generation: { kind: 'manual', reference: 'purchasing-plan/1' },
        steps: {
          'create-order': {
            capability: action.capability,
            capabilityVersion: '1',
            targetKind: 'purchase_order',
            minimumRisk: 'medium',
          },
        },
      });
      await safety.provisioning.bind(context, {
        runId: plan.id,
        stepId: 'create-order',
        tenantId: context.tenantId,
        principalId: plan.requestedBy,
        artifactId: artifact.id,
        artifactVersion: artifact.version,
        artifactDigest: artifact.digest,
        subject: { kind: 'purchasing_plan', id: plan.id },
        eligibilityValidUntil: plan.expiresAt,
        action,
      });
      const effect = await effects.resolve(context, action);
      const decision = await safety.policies.evaluate(
        context,
        action,
        parseAction(action).hash,
        {
          available: !!effect && (await effect.checkPreconditions(action)),
          minimumRisk: 'medium',
          permission: 'procurement.manage',
        },
      );

      return {
        decisionId: decision.id,
        allowed: decision.outcome !== 'denied',
        reason: decision.outcome === 'denied' ? decision.reason : null,
      };
    },
    async decision(context, plan) {
      const decision = plan.decisionId
        ? await safety.policies.decision(context, plan.decisionId)
        : null;

      return decision
        ? {
            requireIndependentApproval: decision.requireIndependentApproval,
            approved: decision.approval?.outcome === 'approved',
            rejected: decision.approval?.outcome === 'rejected',
          }
        : null;
    },
    async respond(context, plan, outcome) {
      await safety.policies.respond(
        context,
        plan.decisionId!,
        outcome,
        plan.expiresAt,
      );
    },
    async execute(context, plan, reconcile) {
      try {
        const prior = await safety.execution.get(context, plan.actionId);
        const result = reconcile
          ? prior
            ? await safety.execution.reconcile(context, plan.actionId)
            : null
          : prior
            ? prior
            : await safety.execution.execute(context, {
                runId: plan.id,
                stepId: 'create-order',
              });
        if (!result)
          return {
            state: 'approval_required',
            failure: 'No creation attempt has been recorded.',
          };
        if (!('record' in result))
          return {
            state:
              result.state === 'approval_required'
                ? 'approval_required'
                : 'withheld',
            failure:
              'The current approval or policy does not allow draft creation.',
          };
        if (result.record.attempt.businessOutcome === 'satisfied')
          return { state: 'verified', failure: null };
        if (result.record.attempt.businessOutcome === 'violated')
          return {
            state: 'failed',
            failure: 'The saved order does not match this plan.',
          };
        if (result.record.attempt.dispatch === 'not_dispatched')
          return {
            state: 'withheld',
            failure: 'Inputs changed before creation. Review a fresh plan.',
          };

        return {
          state: 'uncertain',
          failure:
            'Draft creation has not been independently verified. Check the saved order before retrying.',
        };
      } catch (error) {
        if (error instanceof AdmissionRejected)
          return {
            state: 'withheld',
            failure:
              'The plan, evidence or approval changed. Review a fresh plan.',
          };
        throw error;
      }
    },
  };
}

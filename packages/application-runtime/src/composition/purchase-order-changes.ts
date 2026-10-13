import type { EffectRegistry } from '@luma/connections';
import type { InstalledPurchaseOrderRuntime } from '@luma/connections/composition';
import type { ExecutionResult } from '@luma/execution';
import { AdmissionRejected } from '@luma/execution';
import { parseAction } from '@luma/execution/composition';
import type {
  PurchaseOrderChangeAdmission,
  PurchaseOrderChanges,
} from '@luma/procurement';
import type { SubmissionExecution } from '@luma/procurement/composition';

import type { createSafetyServices } from './services.js';

function execution(result: ExecutionResult | null): SubmissionExecution {
  if (!result) return { state: 'not_started' };
  if (result.state === 'not_executed')
    return { state: 'not_executed', reason: 'observe_only' };
  if (!('record' in result))
    return {
      state: 'withheld',
      reason:
        'The approval or source eligibility changed. No new operation was dispatched.',
    };
  const { attempt } = result.record;
  if (attempt.dispatch === 'not_dispatched')
    return {
      state: 'withheld',
      reason:
        'The purchasing-system order changed before dispatch. Review it again.',
    };
  if (attempt.businessOutcome === 'satisfied') return { state: 'verified' };
  if (attempt.businessOutcome === 'violated')
    return {
      state: 'failed',
      reason:
        'The independent read did not establish the requested order revision.',
    };

  return attempt.effectEvidenceRefs?.length
    ? { state: 'accepted' }
    : { state: 'uncertain' };
}

/** Supplies source operations through installed connections and the procurement owner's verifier. */
export function createPurchaseOrderChangeEffects(
  runtime: InstalledPurchaseOrderRuntime,
  service: () => PurchaseOrderChanges,
): EffectRegistry {
  return runtime.revisionEffects({
    map: async (context, intent) =>
      (await service().forAction(context, intent))?.input ?? null,
    checkPreconditions: async (context, intent) =>
      service().eligible(context, {
        subject: { kind: 'purchase_order_change', id: intent.target.id },
        action: intent,
      }),
    verify: async (context, intent) =>
      service().verify(context, intent.target.id),
  });
}

/** Binds immutable high-risk source revisions to Action Admission and current approval rules. */
export function createPurchaseOrderChangeAdmission(
  safety: ReturnType<typeof createSafetyServices>,
  effects: EffectRegistry,
): PurchaseOrderChangeAdmission {
  const step = 'revise-order';

  return {
    async prepare(context, change, action) {
      const artifact = await safety.provisioning.activate(context, {
        id: 'procurement-order-change',
        version: '1',
        generation: { kind: 'manual', reference: 'procurement-order-change/1' },
        steps: {
          [step]: {
            capability: 'purchase-orders.revise',
            capabilityVersion: '0',
            targetKind: 'purchase_order_change',
            minimumRisk: 'high',
          },
        },
      });
      await safety.provisioning.bind(context, {
        runId: change.id,
        stepId: step,
        tenantId: context.tenantId,
        principalId: change.requestedBy,
        artifactId: artifact.id,
        artifactVersion: artifact.version,
        artifactDigest: artifact.digest,
        subject: { kind: 'purchase_order_change', id: change.id },
        eligibilityValidUntil: change.expiresAt,
        action,
      });
      const effect = await effects.resolve(context, action);

      return safety.policies.evaluate(
        context,
        action,
        parseAction(action).hash,
        {
          available: !!effect && (await effect.checkPreconditions(action)),
          minimumRisk: 'high',
          permission: effect?.permission ?? 'actions.propose',
        },
      );
    },
    async decision(context, id) {
      const decision = await safety.policies.decision(context, id);
      if (!decision) return null;
      const { approval, ...rest } = decision;

      return approval
        ? {
            ...rest,
            approval: {
              outcome: approval.outcome,
              approverId: approval.approverId,
            },
          }
        : rest;
    },
    async respond(context, id, outcome, expiresAt) {
      await safety.policies.respond(context, id, outcome, expiresAt);
    },
    async execute(context, change) {
      try {
        return execution(
          await safety.execution.execute(context, {
            runId: change.id,
            stepId: step,
          }),
        );
      } catch (error) {
        if (error instanceof AdmissionRejected)
          return {
            state: 'withheld',
            reason:
              'The order revision or supplier link changed after approval.',
          };
        throw error;
      }
    },
    async reconcile(context, change) {
      const current = await safety.execution.get(context, change.actionId);
      if (!current) return { state: 'not_started' };
      if (current.state === 'succeeded' || current.state === 'failed')
        return execution(current);

      return execution(
        await safety.execution.reconcile(context, change.actionId),
      );
    },
  };
}

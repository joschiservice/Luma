import type { EffectRegistry } from '@luma/connections';
import type { InstalledReturnRuntime } from '@luma/connections/composition';
import { AdmissionRejected } from '@luma/execution';
import { parseAction } from '@luma/execution/composition';
import type {
  ReturnActions,
  ReturnSettlementAdmission,
  ReturnSettlementSystem,
} from '@luma/orders/composition';
import { canonicalJson } from '@luma/platform';

import type { createSafetyServices } from './services.js';

/** Routes settlement reads through the current installation and records independent source evidence. */
export function createReturnSettlementSystem(
  runtime: InstalledReturnRuntime,
): ReturnSettlementSystem {
  return {
    async warehouses(context, connectionId) {
      const result = await runtime.read(context, {
        connectionId,
        capability: 'returns.options.read',
        version: '0',
        input: { limit: 100 },
      });
      if (
        !result.ok ||
        result.value.completeness !== 'complete' ||
        result.value.nextCursor
      )
        throw new Error('Warehouse choices unavailable');

      return result.value.items
        .filter((o) => o.kind === 'snapshot' && o.data.kind === 'warehouse')
        .map((o) => ({ ...o.source, name: o.data.name }));
    },
    async quote(context, connectionId, input) {
      const result = await runtime.read(context, {
        connectionId,
        capability: 'returns.settlement.quote.read',
        version: '0',
        input,
      });
      if (!result.ok) throw new Error('Settlement quote unavailable');

      return result.value;
    },
    async proof(context, value) {
      const result = await runtime.read(context, {
        connectionId: value.connectionId,
        capability: 'returns.settlement.proof.read',
        version: '0',
        input: { operationId: value.id, plan: value.plan },
      });
      if (!result.ok) throw new Error('Settlement verification unavailable');

      return result.value;
    },
  };
}

/** Resolves only the exact frozen orders-owned settlement; the provider capability is fixed by its kind. */
export function createReturnSettlementEffects(
  runtime: InstalledReturnRuntime,
  actions: () => ReturnActions,
): EffectRegistry {
  return {
    async resolve(context, intent) {
      if (
        intent.target.kind !== 'return_case_settlement' ||
        !['returns.refund', 'returns.restock'].includes(intent.capability)
      )
        return null;
      const bound = await actions().forAction(context, intent.target.id);
      if (!bound || canonicalJson(bound.action) !== canonicalJson(intent))
        return null;

      return runtime
        .settlementEffects(
          bound.value.kind === 'refund' ? 'returns.refund' : 'returns.restock',
          {
            map: async () => ({
              operationId: bound.value.id,
              plan: bound.value.plan,
            }),
            checkPreconditions: async (current, action) =>
              canonicalJson(action) === canonicalJson(intent) &&
              actions().eligible(current, {
                subject: { kind: 'return_case_settlement', id: bound.value.id },
                action: bound.action,
              }),
            verify: async (current) => ({
              ...(await actions().verify(current, bound.value.id)),
              observedAt: new Date().toISOString(),
              evaluatorVersion: 'return-settlement/1',
            }),
          },
        )
        .resolve(context, intent);
    },
  };
}

/** Binds each settlement to the same independently approved, idempotent execution gateway as other writes. */
export function createReturnSettlementAdmission(
  safety: ReturnType<typeof createSafetyServices>,
  effects: EffectRegistry,
): ReturnSettlementAdmission {
  const stepId = 'settle';

  return {
    writeMode: safety.execution.writeMode,
    async prepare(context, value, action) {
      const artifact = await safety.provisioning.activate(context, {
        id: `return-settlement-${value.kind}`,
        version: '1',
        generation: { kind: 'manual', reference: 'return-settlement/1' },
        steps: {
          [stepId]: {
            capability: action.capability,
            capabilityVersion: '0',
            targetKind: 'return_case_settlement',
            minimumRisk: 'high',
          },
        },
      });
      await safety.provisioning.bind(context, {
        runId: value.id,
        stepId,
        tenantId: context.tenantId,
        principalId: value.requestedBy,
        artifactId: artifact.id,
        artifactVersion: artifact.version,
        artifactDigest: artifact.digest,
        subject: { kind: 'return_case_settlement', id: value.id },
        eligibilityValidUntil: value.expiresAt,
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
      const value = await safety.policies.decision(context, id);
      if (!value) return null;
      const { approval, ...rest } = value;

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
    async execute(context, value) {
      try {
        const result = await safety.execution.execute(context, {
          runId: value.id,
          stepId,
        });
        if (result.state === 'not_executed') return { state: 'not_executed' };
        if (
          'record' in result &&
          result.record.attempt.dispatch === 'not_dispatched'
        )
          return { state: 'withheld', failure: 'not_sent' };

        return { state: 'uncertain' };
      } catch (error) {
        if (error instanceof AdmissionRejected) {
          // Another sender may have reserved this identity after admission's first read.
          const result = await safety.execution.get(context, value.actionId);
          if (result?.state === 'not_executed')
            return { state: 'not_executed' };
          if (result && 'record' in result)
            return result.record.attempt.dispatch === 'not_dispatched'
              ? { state: 'withheld', failure: 'not_sent' }
              : { state: 'uncertain' };

          return { state: 'not_started' };
        }
        throw error;
      }
    },
    async reconcile(context, value) {
      await safety.execution.reconcile(context, value.actionId);

      return { state: 'uncertain' };
    },
  };
}

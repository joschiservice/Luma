import type { EffectRegistry } from '@luma/connections';
import type { InstalledReturnRuntime } from '@luma/connections/composition';
import { AdmissionRejected } from '@luma/execution';
import { parseAction } from '@luma/execution/composition';
import type {
  ReturnExchangeAdmission,
  ReturnExchanges,
  ReturnExchangeSystem,
} from '@luma/orders/composition';
import { canonicalJson } from '@luma/platform';

import type { createSafetyServices } from './services.js';

/** Reads both installed systems without interpreting reported availability as a reservation. */
export function createReturnExchangeSystem(
  runtime: InstalledReturnRuntime,
): ReturnExchangeSystem {
  return {
    async choices(context, connectionId, items) {
      const result = await runtime.read(context, {
        connectionId,
        capability: 'returns.exchange.options.read',
        version: '0',
        input: {
          inventoryItems: [
            ...new Map(
              items.map((i) => [
                canonicalJson(i.inventoryItem),
                i.inventoryItem,
              ]),
            ).values(),
          ],
        },
      });
      if (!result.ok || !result.value.complete)
        throw new Error('Replacement choices unavailable');

      return {
        items: items.map((item) => {
          const choice = result.value.choices.find(
            (c) =>
              canonicalJson(c.inventoryItem) ===
              canonicalJson(item.inventoryItem),
          );
          if (!choice) throw new Error('Replacement missing');

          return {
            ...item,
            label: choice.name ?? item.label,
            variantId: choice.variantId,
            available: choice.available,
          };
        }),
        observedAt: result.value.observedAt,
        evidenceRefs: result.value.evidenceRefs,
      };
    },
    async availability(context, replacement) {
      const result = await runtime.read(context, {
        connectionId: replacement.wawiConnectionId,
        capability: 'inventory.read',
        version: '0',
        input: { limit: 100, sku: replacement.item },
      });
      if (
        !result.ok ||
        result.value.completeness !== 'complete' ||
        result.value.nextCursor
      )
        throw new Error('Wawi availability unavailable');
      const rows = result.value.items.filter(
        (o) =>
          o.kind === 'snapshot' &&
          canonicalJson(o.data.sku) === canonicalJson(replacement.item) &&
          o.data.availabilityBasis === 'provider_reported' &&
          o.data.available !== null,
      );
      if (rows.length !== 1)
        throw new Error('Exact reported Wawi availability required');
      const row = rows[0]!;
      if (
        row.kind !== 'snapshot' ||
        row.data.available === null ||
        row.data.unit !== 'each'
      )
        throw new Error('Unknown availability');
      const quantity = Number(row.data.available);
      if (!Number.isSafeInteger(quantity) || quantity < 0)
        throw new Error('Unknown available quantity');

      return {
        available: quantity >= replacement.quantity,
        observedAt: row.observedAt,
        evidenceRefs: [row.id],
      };
    },
    async quote(context, connectionId, input) {
      const result = await runtime.read(context, {
        connectionId,
        capability: 'returns.exchange.quote.read',
        version: '0',
        input,
      });
      if (!result.ok) throw new Error('Exchange quote unavailable');

      return result.value;
    },
    async proof(context, value) {
      const result = await runtime.read(context, {
        connectionId: value.connectionId,
        capability: 'returns.exchange.proof.read',
        version: '0',
        input: { operationId: value.operationId, plan: value.plan },
      });
      if (!result.ok) throw new Error('Exchange proof unavailable');

      return result.value;
    },
  };
}

/** Resolves only the exact frozen orders-owned settlement; the provider capability is fixed by its kind. */
export function createReturnExchangeEffects(
  runtime: InstalledReturnRuntime,
  actions: () => ReturnExchanges,
): EffectRegistry {
  return {
    async resolve(context, intent) {
      if (
        intent.target.kind !== 'return_case_exchange' ||
        ![
          'returns.exchange.request',
          'returns.exchange.process',
          'returns.exchange.cancel',
          'returns.exchange.release',
        ].includes(intent.capability)
      )
        return null;
      const bound = await actions().forAction(context, intent.target.id);
      if (!bound || canonicalJson(bound.action) !== canonicalJson(intent))
        return null;

      return runtime
        .exchangeEffects(`returns.exchange.${bound.value.plan.kind}`, {
          map: async () => ({
            operationId: bound.value.operationId,
            plan: bound.value.plan,
          }),
          checkPreconditions: async (current, action) =>
            canonicalJson(action) === canonicalJson(intent) &&
            actions().eligible(current, {
              subject: { kind: 'return_case_exchange', id: bound.value.id },
              action: bound.action,
            }),
          verify: async (current) => ({
            ...(await actions().verify(current, bound.value.id)),
            observedAt: new Date().toISOString(),
            evaluatorVersion: 'return-exchange/1',
          }),
        })
        .resolve(context, intent);
    },
  };
}

/** Binds each settlement to the same independently approved, idempotent execution gateway as other writes. */
export function createReturnExchangeAdmission(
  safety: ReturnType<typeof createSafetyServices>,
  effects: EffectRegistry,
): ReturnExchangeAdmission {
  const stepId = 'exchange';

  return {
    writeMode: safety.execution.writeMode,
    async prepare(context, value, action) {
      const artifact = await safety.provisioning.activate(context, {
        id: `return-exchange-${value.plan.kind}`,
        version: '1',
        generation: { kind: 'manual', reference: 'return-exchange/1' },
        steps: {
          [stepId]: {
            capability: action.capability,
            capabilityVersion: '0',
            targetKind: 'return_case_exchange',
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
        subject: { kind: 'return_case_exchange', id: value.id },
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

import type {
  ConnectionManagement,
  ConnectorFailure,
  EffectRegistry,
} from '@luma/connections';
import type { InstalledReturnRuntime } from '@luma/connections/composition';
import type { ExecutionResult } from '@luma/execution';
import { AdmissionRejected } from '@luma/execution';
import { parseAction } from '@luma/execution/composition';
import type {
  CreationAdmission,
  CreationExecution,
  FoundReturn,
  ReturnCases,
  ReturnOption,
  ReturnSystem,
  ReturnSystemResult,
} from '@luma/orders/composition';
import { canonicalJson } from '@luma/platform';

import type { createSafetyServices } from './services.js';

const failureReason = (
  failure: ConnectorFailure,
): Extract<ReturnSystemResult<never>, { ok: false }>['reason'] =>
  failure.code === 'rate_limited'
    ? 'busy'
    : [
          'authentication',
          'permission_denied',
          'unsupported_capability',
        ].includes(failure.code)
      ? 'denied'
      : failure.code === 'unavailable'
        ? 'unavailable'
        : 'failed';

/**
 * Adapts installed connections to the return cases' return-system port. Reads are bounded and
 * pass through the installation-gated capability runtime.
 */
export function createReturnSystem(
  runtime: InstalledReturnRuntime,
  installations: Pick<ConnectionManagement, 'list'>,
): ReturnSystem {
  return {
    async connections(context) {
      return (await installations.list(context)).map((c) => ({
        id: c.id,
        label: c.label,
        provider: c.provider ?? null,
        status: c.status,
        offersCreation: c.permissions.includes('returns.create'),
        canCreate: (
          [
            'returns.create',
            'returns.options.read',
            'returns.created.read',
          ] as const
        ).every((p) => c.granted.includes(p)),
      }));
    },
    async options(context, connectionId) {
      const result = await runtime.read(context, {
        connectionId,
        capability: 'returns.options.read',
        version: '0',
        input: { limit: 100 },
      });
      if (!result.ok) return { ok: false, reason: failureReason(result.error) };
      const warehouses: ReturnOption[] = [];
      const reasons: ReturnOption[] = [];
      for (const o of result.value.items) {
        if (o.kind !== 'snapshot') continue;
        const option = {
          externalId: o.source.externalId,
          scopeKey: o.source.scopeKey,
          name: o.data.name,
        };
        (o.data.kind === 'warehouse' ? warehouses : reasons).push(option);
      }

      return { ok: true, value: { warehouses, reasons } };
    },
    async created(context, connectionId, query) {
      const result = await runtime.read(context, {
        connectionId,
        capability: 'returns.created.read',
        version: '0',
        input: {
          limit: 25,
          order: query.order,
          lumaCaseId: query.lumaCaseId,
          ...(query.requestedReturn
            ? { requestedReturn: query.requestedReturn }
            : {}),
        },
      });
      if (!result.ok) return { ok: false, reason: failureReason(result.error) };
      const items: FoundReturn[] = result.value.items
        .filter(
          (o) =>
            o.kind === 'snapshot' && o.data.lumaCaseId === query.lumaCaseId,
        )
        .map((o) => ({
          observationId: o.id,
          observedAt: o.observedAt,
          externalId: o.source.externalId,
          number: o.data.number,
          lines: o.data.lines.map((line) => ({
            orderLine: line.orderLine,
            quantity: line.quantity.amount,
          })),
        }));

      return {
        ok: true,
        value: {
          items,
          complete:
            result.value.completeness === 'complete' &&
            !result.value.nextCursor,
        },
      };
    },
  };
}

const quantity = (value: number) => Number(value.toFixed(6)).toString();

/**
 * Resolves `returns.create` intents to the installed system of the case's order. The bound
 * creation must still match the intent exactly; verification is an independent read.
 */
export function createReturnCreationEffects(
  runtime: InstalledReturnRuntime,
  returnCases: () => ReturnCases,
): EffectRegistry {
  return {
    async resolve(context, intent) {
      if (
        intent.capability !== 'returns.create' ||
        intent.target.kind !== 'return_case_creation'
      )
        return null;
      const bound = await returnCases().creationForAction(
        context,
        intent.target.id,
      );
      if (!bound || canonicalJson(bound.action) !== canonicalJson(intent))
        return null;
      const { creation } = bound;

      return runtime
        .creationEffects({
          map: async () => ({
            lumaCaseId: creation.caseId,
            order: creation.order,
            ...(creation.requestedReturn
              ? { requestedReturn: creation.requestedReturn }
              : {}),
            warehouse: {
              externalId: creation.warehouse.externalId,
              scopeKey: creation.warehouse.scopeKey,
            },
            reason: {
              externalId: creation.reason.externalId,
              scopeKey: creation.reason.scopeKey,
            },
            lines: creation.lines.map((line) => ({
              orderLine: line.source,
              quantity: { amount: quantity(line.quantity), unit: 'each' },
            })),
          }),
          checkPreconditions: async (current, action) => {
            if (canonicalJson(action) !== canonicalJson(intent)) return false;

            return returnCases().eligible(current, {
              subject: { kind: 'return_case_creation', id: creation.id },
              action,
            });
          },
          verify: async (current) => ({
            ...(await returnCases().verify(current, creation.id)),
            observedAt: new Date().toISOString(),
            evaluatorVersion: 'return-case-creation/1',
          }),
        })
        .resolve(context, intent);
    },
  };
}

function execution(result: ExecutionResult | null): CreationExecution {
  if (!result) return { state: 'not_started' };
  if (result.state === 'not_executed') return { state: 'not_executed' };
  if (!('record' in result)) return { state: 'withheld', failure: 'withheld' };
  const { record } = result;
  if (record.attempt.dispatch === 'not_dispatched')
    return { state: 'withheld', failure: 'not_accepted' };
  if (record.attempt.businessOutcome === 'satisfied')
    return { state: 'verified' };
  if (record.attempt.businessOutcome === 'violated')
    return { state: 'failed', failure: 'mismatch' };

  return record.attempt.effectEvidenceRefs?.length
    ? { state: 'accepted' }
    : { state: 'uncertain' };
}

/** Keeps the recorded approval outcome and approver, without the approval's evidence. */
function decisionView<
  T extends {
    approval: { outcome: 'approved' | 'rejected'; approverId: string } | null;
  },
>({ approval, ...rest }: T) {
  return approval
    ? {
        ...rest,
        approval: {
          outcome: approval.outcome,
          approverId: approval.approverId,
        },
      }
    : rest;
}

/** Binds return creations to the shared Action Admission, policy and execution services. */
export function createReturnCreationAdmission(
  safety: ReturnType<typeof createSafetyServices>,
  effects: EffectRegistry,
): CreationAdmission {
  const step = 'create';

  return {
    writeMode: safety.execution.writeMode,
    async prepare(context, creation, action) {
      const artifact = await safety.provisioning.activate(context, {
        id: 'return-case-creation',
        version: '1',
        generation: { kind: 'manual', reference: 'return-case-creation/1' },
        steps: {
          [step]: {
            capability: 'returns.create',
            capabilityVersion: '0',
            targetKind: 'return_case_creation',
            minimumRisk: 'high',
          },
        },
      });
      await safety.provisioning.bind(context, {
        runId: creation.id,
        stepId: step,
        tenantId: context.tenantId,
        principalId: creation.requestedBy,
        artifactId: artifact.id,
        artifactVersion: artifact.version,
        artifactDigest: artifact.digest,
        subject: { kind: 'return_case_creation', id: creation.id },
        eligibilityValidUntil: creation.expiresAt,
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
          // Requesting a creation proposes it; the app declares its own permission.
          permission: effect?.permission ?? 'actions.propose',
        },
      );
    },
    async decision(context, id) {
      const decision = await safety.policies.decision(context, id);

      return decision && decisionView(decision);
    },
    async decisions(context, ids) {
      const decisions = await safety.policies.decisions(context, ids);

      return new Map(
        [...decisions].map(([id, decision]) => [
          id,
          decision && decisionView(decision),
        ]),
      );
    },
    async respond(context, decisionId, outcome, expiresAt) {
      await safety.policies.respond(context, decisionId, outcome, expiresAt);
    },
    async execute(context, creation) {
      try {
        return execution(
          await safety.execution.execute(context, {
            runId: creation.id,
            stepId: step,
          }),
        );
      } catch (error) {
        if (error instanceof AdmissionRejected)
          return { state: 'withheld', failure: 'changed' };
        throw error;
      }
    },
    async reconcile(context, creation) {
      const current = await safety.execution.get(context, creation.actionId);
      if (!current) return { state: 'not_started' };
      if (current.state === 'succeeded' || current.state === 'failed')
        return execution(current);

      return execution(
        await safety.execution.reconcile(context, creation.actionId),
      );
    },
    async get(context, creation) {
      return execution(await safety.execution.get(context, creation.actionId));
    },
  };
}

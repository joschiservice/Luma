import type {
  ConnectionManagement,
  ConnectorFailure,
  EffectRegistry,
  ExternalId,
} from '@luma/connections';
import type { InstalledPurchaseOrderRuntime } from '@luma/connections/composition';
import type { ExecutionResult } from '@luma/execution';
import { AdmissionRejected } from '@luma/execution';
import { parseAction } from '@luma/execution/composition';
import { canonicalJson } from '@luma/platform';
import type {
  PurchasingOrder,
  PurchasingSystem,
  SubmissionAdmission,
  SubmissionExecution,
  SupplierCommitments,
} from '@luma/procurement/composition';

import type { createSafetyServices } from './services.js';

const failures: Partial<Record<ConnectorFailure['code'], string>> = {
  unavailable:
    'The purchasing-system connection is unavailable. Check it in Apps.',
  authentication:
    'The purchasing system rejected the connection credentials. Reconnect it in Apps.',
  permission_denied:
    'The connection is not allowed to read purchase orders. Reconnect it with purchase-order access.',
  unsupported_capability:
    'This connection cannot read purchase orders. Reconnect it with purchase-order access.',
  rate_limited: 'The purchasing system is busy. Try again in a minute.',
};

const reason = (failure: ConnectorFailure) =>
  failures[failure.code] ??
  'The purchasing system could not be read. Try again.';

/**
 * Adapts installed connections to procurement's purchasing-system port. Reads are bounded and
 * pass through the installation-gated capability runtime.
 */
export function createPurchasingSystem(
  runtime: InstalledPurchaseOrderRuntime,
  installations: Pick<ConnectionManagement, 'list'>,
): PurchasingSystem {
  return {
    async connections(context) {
      return (await installations.list(context))
        .filter((c) =>
          c.permissions.some((p) =>
            [
              'suppliers.read',
              'purchase-orders.read',
              'purchase-orders.submit',
            ].includes(p),
          ),
        )
        .map((c) => ({
          id: c.id,
          label: c.label,
          provider: c.provider ?? null,
          status: c.status,
          canSubmit: c.granted.includes('purchase-orders.submit'),
          canReadOrders: c.granted.includes('purchase-orders.read'),
          canListSuppliers: c.granted.includes('suppliers.read'),
        }));
    },
    async suppliers(context, connectionId, query) {
      const result = await runtime.read(context, {
        connectionId,
        capability: 'suppliers.read',
        version: '0',
        input: {
          limit: 100,
          ...(query.cursor ? { cursor: query.cursor } : {}),
          ...(query.supplier ? { supplier: query.supplier } : {}),
        },
      });
      if (!result.ok) return { ok: false, reason: reason(result.error) };

      return {
        ok: true,
        value: {
          items: result.value.items
            .filter((o) => o.kind === 'snapshot')
            .map((o) => ({
              externalId: o.source.externalId,
              scopeKey: o.source.scopeKey,
              ...o.data,
            })),
          nextCursor: result.value.nextCursor,
        },
      };
    },
    async orders(context, connectionId, query) {
      const items: PurchasingOrder[] = [];
      let cursor: string | undefined;
      // A created-order lookup scans a bounded recent window; ten pages is ample.
      for (let page = 0; page < 10; page++) {
        const result = await runtime.read(context, {
          connectionId,
          capability: 'purchase-orders.read',
          version: '0',
          // A cursor carries the original query; later pages send only the cursor.
          input: cursor
            ? { limit: 25, cursor }
            : {
                limit: 25,
                ...(query.order ? { order: query.order } : {}),
                ...(query.created ? { created: query.created } : {}),
              },
        });
        if (!result.ok) return { ok: false, reason: reason(result.error) };
        for (const o of result.value.items)
          if (o.kind === 'snapshot')
            items.push({
              observationId: o.id,
              observedAt: o.observedAt,
              externalId: o.source.externalId,
              scopeKey: o.source.scopeKey,
              data: o.data,
            });
        if (!result.value.nextCursor) return { ok: true, value: items };
        cursor = result.value.nextCursor;
      }

      return {
        ok: false,
        reason: 'Too many purchase orders to search. Try again later.',
      };
    },
  };
}

const quantity = (value: number) => Number(value.toFixed(6)).toString();

/**
 * Resolves `purchase-orders.submit` intents to the installed purchasing system. The bound
 * submission must still match the intent exactly; verification is an independent read.
 */
export function createSubmissionEffects(
  runtime: InstalledPurchaseOrderRuntime,
  commitments: () => SupplierCommitments,
): EffectRegistry {
  return {
    async resolve(context, intent) {
      if (
        intent.capability !== 'purchase-orders.submit' ||
        intent.target.kind !== 'purchase_order_submission'
      )
        return null;
      const bound = await commitments().submissionForAction(
        context,
        intent.target.id,
      );
      if (!bound || canonicalJson(bound.action) !== canonicalJson(intent))
        return null;
      const { submission, order } = bound;

      return runtime
        .submissionEffects({
          map: async () => ({
            lumaOrderId: order.id,
            reference: order.reference,
            supplier: submission.supplier as ExternalId,
            requestedDeliveryDate: submission.requestedDeliveryDate,
            lines: submission.lines.map((line) => ({
              sku: line.sku,
              quantity: { amount: quantity(line.quantity), unit: line.unit },
            })),
          }),
          checkPreconditions: async (current, action) => {
            if (canonicalJson(action) !== canonicalJson(intent)) return false;

            return commitments().eligible(current, {
              subject: { kind: 'purchase_order_submission', id: submission.id },
              action,
            });
          },
          verify: async (current) => ({
            ...(await commitments().verify(current, submission.id)),
            observedAt: new Date().toISOString(),
            evaluatorVersion: 'purchase-order-submission/1',
          }),
        })
        .resolve(context, intent);
    },
  };
}

function execution(result: ExecutionResult | null): SubmissionExecution {
  if (!result) return { state: 'not_started' };
  if (result.state === 'not_executed')
    return { state: 'not_executed', reason: 'observe_only' };
  if (!('record' in result))
    return {
      state: 'withheld',
      reason:
        result.state === 'denied'
          ? 'Policy no longer allows sending this order. Nothing was sent.'
          : 'The approval no longer applies. Request approval again.',
    };
  const { record } = result;
  if (record.attempt.dispatch === 'not_dispatched')
    return {
      state: 'withheld',
      reason:
        'The purchasing system did not accept the order. Check the supplier and item links, then request again.',
    };
  if (record.attempt.businessOutcome === 'satisfied')
    return { state: 'verified' };
  if (record.attempt.businessOutcome === 'violated')
    return {
      state: 'failed',
      reason:
        'The purchasing system holds an order for this purchase order that does not match it. Review it in the purchasing system before anything else is sent.',
    };

  return record.attempt.effectEvidenceRefs?.length
    ? { state: 'accepted' }
    : { state: 'uncertain' };
}

/** Binds submissions to the shared Action Admission, policy and execution services. */
export function createSubmissionAdmission(
  safety: ReturnType<typeof createSafetyServices>,
  effects: EffectRegistry,
): SubmissionAdmission {
  const step = 'submit';

  return {
    writeMode: safety.execution.writeMode,
    async prepare(context, submission, action) {
      const artifact = await safety.provisioning.activate(context, {
        id: 'procurement-submission',
        version: '1',
        generation: { kind: 'manual', reference: 'procurement-submission/1' },
        steps: {
          [step]: {
            capability: 'purchase-orders.submit',
            capabilityVersion: '0',
            targetKind: 'purchase_order_submission',
            minimumRisk: 'high',
          },
        },
      });
      await safety.provisioning.bind(context, {
        runId: submission.id,
        stepId: step,
        tenantId: context.tenantId,
        principalId: submission.requestedBy,
        artifactId: artifact.id,
        artifactVersion: artifact.version,
        artifactDigest: artifact.digest,
        subject: { kind: 'purchase_order_submission', id: submission.id },
        eligibilityValidUntil: submission.expiresAt,
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
          // Preparing a submission proposes it; JTL declares its own permission.
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
    async respond(context, decisionId, outcome, expiresAt) {
      await safety.policies.respond(context, decisionId, outcome, expiresAt);
    },
    async execute(context, submission) {
      try {
        const raw = await safety.execution.execute(context, {
          runId: submission.id,
          stepId: step,
        });

        return execution(raw);
      } catch (error) {
        if (error instanceof AdmissionRejected)
          return {
            state: 'withheld',
            reason:
              'The order, supplier link or approval changed. Nothing was sent. Request approval again.',
          };
        throw error;
      }
    },
    async reconcile(context, submission) {
      const current = await safety.execution.get(context, submission.actionId);
      if (!current) return { state: 'not_started' };
      if (current.state === 'succeeded' || current.state === 'failed')
        return execution(current);

      return execution(
        await safety.execution.reconcile(context, submission.actionId),
      );
    },
    async get(context, submission) {
      return execution(
        await safety.execution.get(context, submission.actionId),
      );
    },
  };
}

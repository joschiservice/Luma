import { purchaseOrderInputSchema } from '@luma/api-contract';
import type {
  EffectIntent,
  EffectRegistry,
  VerificationResult,
} from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import { requireTenant } from '@luma/identity';
import { ServiceError } from '@luma/platform';
import type { ProcurementService } from '@luma/procurement';
import { createProcurementCapabilities } from '@luma/procurement/composition';
import { z } from 'zod';

const createParameters = z
  .object({
    submissionScope: z.string().optional(),
    supplierId: z.string().uuid(),
    reference: z.string().trim().min(1).max(200),
    lines: z.string(),
    workflowRunId: z.string().uuid().optional(),
    actionId: z.string().trim().min(1).max(200).optional(),
    outcomeId: z.string().trim().min(1).max(200).optional(),
    sourcePurchaseOrderId: z.string().uuid().optional(),
    sourceAttentionKey: z.string().min(1).max(400).optional(),
  })
  .strict();
const transitionParameters = z
  .object({
    status: z.enum(['open', 'closed', 'cancelled']),
    expectedRevision: z.number().int().min(1),
    reason: z.string().trim().min(1).max(1000),
    commandId: z.string().uuid(),
  })
  .strict();

function same(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function inputFor(intent: EffectIntent) {
  if (intent.target.kind !== 'purchase_order') return null;
  if (intent.capability === 'procurement.purchase-order.create') {
    if (intent.expectedPostcondition.status !== 'draft') return null;
    try {
      const params = createParameters.parse(intent.parameters);

      return purchaseOrderInputSchema.parse({
        id: intent.target.id,
        supplierId: params.supplierId,
        reference: params.reference,
        lines: JSON.parse(params.lines) as unknown,
        authority: 'luma',
        externalReferences: [],
        origin: {
          ...(params.workflowRunId
            ? { workflowRunId: params.workflowRunId }
            : {}),
          ...(params.actionId ? { actionId: params.actionId } : {}),
          ...(params.outcomeId ? { outcomeId: params.outcomeId } : {}),
          ...(params.sourcePurchaseOrderId
            ? { sourcePurchaseOrderId: params.sourcePurchaseOrderId }
            : {}),
          ...(params.sourceAttentionKey
            ? { sourceAttentionKey: params.sourceAttentionKey }
            : {}),
        },
      });
    } catch {
      return null;
    }
  }
  if (intent.capability === 'procurement.purchase-order.transition') {
    try {
      const params = transitionParameters.parse(intent.parameters);
      if (intent.expectedPostcondition.status !== params.status) return null;

      return {
        purchaseOrderId: z.string().uuid().parse(intent.target.id),
        ...params,
      };
    } catch {
      return null;
    }
  }

  return null;
}

/** Resolves Luma-owned purchase-order writes for Action Admission and readback verification. */
export function createProcurementEffects(
  service: ProcurementService,
): EffectRegistry {
  const capabilities = createProcurementCapabilities(service);

  return {
    async resolve(context: TenantContext, intent: EffectIntent) {
      requireTenant(context, intent.tenantId);
      if (
        intent.connectionId !== context.tenantId ||
        intent.capabilityVersion !== '1' ||
        ![
          'procurement.purchase-order.create',
          'procurement.purchase-order.transition',
        ].includes(intent.capability)
      )
        return null;
      const input = inputFor(intent);
      if (!input) return null;
      const boundIntent = structuredClone(intent);
      const boundInput = structuredClone(input);
      const create = intent.capability === 'procurement.purchase-order.create';
      const identity = JSON.stringify([
        'luma',
        intent.capability,
        '1',
        boundInput,
      ]);

      return {
        dispatchIdentity: identity,
        capability: intent.capability,
        version: '1',
        minimumRisk: create ? 'medium' : 'high',
        mechanism: 'api',
        executor: { kind: 'service', id: 'luma.procurement' },
        async checkPreconditions(action) {
          if (!same(action, boundIntent) || !same(inputFor(action), boundInput))
            return false;
          if (create) {
            const order = boundInput as Extract<
              typeof boundInput,
              { supplierId: string }
            >;
            const supplier = await capabilities.lookupSupplier(context, {
              supplierId: order.supplierId,
            });
            if (!supplier) return false;
            try {
              await service.detail(context, order.id);

              return false;
            } catch (error) {
              return error instanceof ServiceError && error.statusCode === 404;
            }
          }
          const transition = boundInput as {
            purchaseOrderId: string;
            expectedRevision: number;
            status: string;
          };
          try {
            const detail = await service.detail(
              context,
              transition.purchaseOrderId,
            );

            return (
              detail.order.authority === 'luma' &&
              detail.order.revision === transition.expectedRevision &&
              detail.allowedTransitions.includes(
                transition.status as typeof detail.order.status,
              )
            );
          } catch {
            return false;
          }
        },
        async execute(action, idempotencyKey) {
          if (!same(action, boundIntent) || !idempotencyKey.trim())
            throw new Error('Action binding changed');
          const order = create
            ? await capabilities.createOrder(context, boundInput)
            : await capabilities.transitionOrder(context, {
                purchaseOrderId: (boundInput as { purchaseOrderId: string })
                  .purchaseOrderId,
                id: (boundInput as { commandId: string }).commandId,
                expectedRevision: (boundInput as { expectedRevision: number })
                  .expectedRevision,
                status: (boundInput as { status: string }).status,
                reason: (boundInput as { reason: string }).reason,
              });

          return { evidenceRefs: [order.id], providerRequestId: null };
        },
        async verify(action): Promise<VerificationResult> {
          const observedAt = new Date().toISOString();
          const inconclusive = (): VerificationResult => ({
            outcome: 'inconclusive',
            observationRefs: [],
            observedAt,
            evaluatorVersion: 'procurement/1',
          });
          if (!same(action, boundIntent)) return inconclusive();
          const expected = create
            ? {
                status: 'draft' as const,
                revision: 1,
                commandId: action.target.id,
              }
            : {
                status: (
                  boundInput as { status: 'open' | 'closed' | 'cancelled' }
                ).status,
                revision:
                  (boundInput as { expectedRevision: number })
                    .expectedRevision + 1,
                commandId: (boundInput as { commandId: string }).commandId,
              };
          try {
            const result = await capabilities.verifyOrder(
              context,
              action.target.id,
              expected,
            );
            const contentMatches =
              !create ||
              same(
                {
                  supplierId: result.order.supplierId,
                  reference: result.order.reference,
                  lines: result.order.lines,
                  origin: result.order.origin,
                },
                {
                  supplierId: (boundInput as { supplierId: string }).supplierId,
                  reference: (boundInput as { reference: string }).reference,
                  lines: (boundInput as { lines: unknown }).lines,
                  origin: (boundInput as { origin: unknown }).origin,
                },
              );

            return {
              outcome: result.passed && contentMatches ? 'passed' : 'failed',
              observationRefs: result.evidenceRefs,
              observedAt,
              evaluatorVersion: 'procurement/1',
            };
          } catch {
            return inconclusive();
          }
        },
      };
    },
  };
}

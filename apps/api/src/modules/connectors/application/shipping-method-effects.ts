import { equalJson } from '../domain/equal-json.js';
import { requireTenant } from '../../identity/index.js';
import type { TenantContext } from '../../identity/index.js';
import type { CapabilityInput } from '../domain/capabilities.js';
import type { CapabilityRuntime } from './capabilities.js';
import type {
  EffectIntent,
  EffectRegistry,
  VerificationResult,
} from './effects.js';

type Input = CapabilityInput<'orders.shipping-method.write'>;
export interface ShippingMethodEffectBinding {
  /** Validate tenant-owned target, diagnosis evidence and approved method mapping. */
  map(context: TenantContext, intent: EffectIntent): Promise<Input | null>;
  /** Recheck diagnosis eligibility, evidence freshness and absence of concurrent order processing. */
  checkPreconditions(
    context: TenantContext,
    intent: EffectIntent,
  ): Promise<boolean>;
  now?: () => Date;
}

/** Verify the correction independently; shipment progress still requires fulfillment evidence. */
export function createShippingMethodEffects(
  runtime: CapabilityRuntime,
  binding: ShippingMethodEffectBinding,
): EffectRegistry {
  const now = binding.now ?? (() => new Date());
  async function map(context: TenantContext, intent: EffectIntent) {
    const input = await binding.map(context, intent);
    if (
      !input ||
      intent.target.kind !== 'order' ||
      Object.keys(intent.expectedPostcondition).length !== 1 ||
      intent.expectedPostcondition.shippingMethodId !==
        input.shippingMethod.externalId
    )
      return null;
    return input;
  }
  return {
    async resolve(context, intent) {
      requireTenant(context, intent.tenantId);
      if (
        intent.capability !== 'orders.shipping-method.write' ||
        intent.capabilityVersion !== '0'
      )
        return null;
      const mapped = await map(context, intent);
      if (!mapped) return null;
      const boundInput = structuredClone(mapped);
      const boundIntent = structuredClone(intent);
      return runtime
        .effects({
          capability: 'orders.shipping-method.write',
          map: async () => boundInput,
          async checkPreconditions(context, intent) {
            return (
              equalJson(intent, boundIntent) &&
              equalJson(await map(context, intent), boundInput) &&
              binding.checkPreconditions(context, intent)
            );
          },
          async verify(context, intent): Promise<VerificationResult> {
            const inconclusive = (): VerificationResult => ({
              outcome: 'inconclusive',
              observationRefs: [],
              observedAt: now().toISOString(),
              evaluatorVersion: 'shipping-method/1',
            });
            if (!equalJson(intent, boundIntent)) return inconclusive();
            const current = await map(context, intent);
            const input = boundInput;
            if (
              !equalJson(intent, boundIntent) ||
              !equalJson(current, boundInput)
            )
              return inconclusive();
            const startedAt = now().getTime();
            const result = await runtime.read(context, {
              connectionId: intent.connectionId,
              capability: 'orders.shipping-method.read',
              version: '0',
              input: { order: input.order, limit: 1 },
            });
            if (
              !result.ok ||
              result.value.completeness !== 'complete' ||
              result.value.nextCursor !== null ||
              result.value.items.length !== 1
            )
              return inconclusive();
            const observation = result.value.items[0]!;
            const time = Date.parse(observation.observedAt);
            if (
              observation.kind !== 'snapshot' ||
              observation.source.resource !== 'order' ||
              observation.source.externalId !== input.order.externalId ||
              observation.source.scopeKey !== input.order.scopeKey ||
              !Number.isFinite(time) ||
              time < startedAt ||
              time > now().getTime()
            )
              return inconclusive();
            return {
              outcome:
                !observation.data.isCancelled &&
                observation.data.shippingMethod.externalId ===
                  input.shippingMethod.externalId &&
                observation.data.shippingMethod.scopeKey ===
                  input.shippingMethod.scopeKey
                  ? 'passed'
                  : 'failed',
              observationRefs: [observation.id],
              observedAt: observation.observedAt,
              evaluatorVersion: 'shipping-method/1',
            };
          },
        })
        .resolve(context, intent);
    },
  };
}

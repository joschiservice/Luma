import { requireTenant } from '../../identity/index.js';
import type { TenantContext } from '../../identity/index.js';
import type {
  CapabilityReader,
  CapabilityRequest,
  CapabilityOutput,
  ReadCapability,
} from '../../connectors/index.js';
import type {
  DiagnosisInput,
  DiagnosisRereader,
} from '../../exceptions/index.js';

export interface DiagnosisReadPlan {
  requests: CapabilityRequest<ReadCapability>[];
  /** Retained provider backoff from the preceding scan, resolved by the workflow owner. */
  notBefore: string | null;
}
/** Canonical mapping and publication remain in workflows; the engine receives no connector write port. */
export function createDiagnosisRereader(
  reader: CapabilityReader,
  bindings: {
    plan(
      context: TenantContext,
      snapshot: Readonly<DiagnosisInput>,
    ): Promise<DiagnosisReadPlan | null>;
    publish(
      context: TenantContext,
      snapshot: Readonly<DiagnosisInput>,
      pages: CapabilityOutput<ReadCapability>[],
    ): Promise<void>;
  },
  now: () => Date,
): DiagnosisRereader {
  return {
    async read(context, snapshot, signal) {
      requireTenant(context, snapshot.input.facts.tenantId);
      const plan = await bindings.plan(context, snapshot);
      if (!plan || !plan.requests.length || plan.requests.length > 2)
        return { status: 'unavailable', retryAfter: null };
      if (plan.notBefore !== null) {
        if (!Number.isFinite(Date.parse(plan.notBefore)))
          return { status: 'unavailable', retryAfter: null };
        if (Date.parse(plan.notBefore) > now().getTime())
          return { status: 'rate_limited', retryAfter: plan.notBefore };
      }
      const connections = new Set(
        snapshot.evidence.flatMap((e) =>
          e.connectionId === null ? [] : [e.connectionId],
        ),
      );
      const pages: CapabilityOutput<ReadCapability>[] = [];
      for (const request of plan.requests) {
        if (signal.aborted) throw new Error('Investigation cancelled');
        if (
          !connections.has(request.connectionId) ||
          ![
            'inventory.read',
            'orders.read',
            'fulfillment.read',
            'products.read',
          ].includes(request.capability)
        )
          throw new Error('Read outside incident scope');
        const result = await reader.read(context, request);
        if (!result.ok) {
          if (result.error.code === 'rate_limited')
            return {
              status: 'rate_limited',
              retryAfter:
                result.error.retryAfterMs === undefined
                  ? null
                  : new Date(
                      now().getTime() + result.error.retryAfterMs,
                    ).toISOString(),
            };
          throw new Error('Authoritative read unavailable');
        }
        pages.push(result.value);
      }
      if (signal.aborted) throw new Error('Investigation cancelled');
      // The publisher must preserve completeness; one page cannot stand in for a complete scan.
      await bindings.publish(context, snapshot, pages);
      return { status: 'completed', retryAfter: null };
    },
  };
}

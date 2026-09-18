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
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function sameExternalId(actual: unknown, expected: unknown): boolean {
  const a = record(actual),
    b = record(expected);
  return (
    a !== null &&
    b !== null &&
    typeof b.externalId === 'string' &&
    b.externalId.length > 0 &&
    typeof b.scopeKey === 'string' &&
    a.externalId === b.externalId &&
    a.scopeKey === b.scopeKey
  );
}
/** Fail closed when the retained mapping cannot bind the canonical subject to a provider selector. */
function inIncidentScope(
  snapshot: Readonly<DiagnosisInput>,
  request: CapabilityRequest<ReadCapability>,
): boolean {
  const { input, subject } = snapshot;
  const selectors = record(request.input);
  if (!selectors) return false;
  const onlyKeys = (keys: string[]) =>
    Object.keys(selectors).every((key) =>
      ['limit', 'cursor', ...keys].includes(key),
    );
  const mappings = snapshot.evidence.filter(
    (e) =>
      e.adapterVersion === 'canonical-mapping-v1' &&
      e.tenantId === input.facts.tenantId &&
      e.facts.tenantId === input.facts.tenantId,
  );
  switch (input.exceptionClass) {
    case 'sync_failure':
      // Sync identity covers the connection's complete capability scan, not a selected resource.
      return (
        subject.kind === 'connection' &&
        subject.id === input.facts.connectionId &&
        subject.scope.length === 1 &&
        subject.scope[0] === input.facts.capability &&
        request.connectionId === input.facts.connectionId &&
        request.capability === input.facts.capability &&
        onlyKeys([])
      );
    case 'inventory_mismatch': {
      const f = input.facts;
      if (
        subject.kind !== 'sku' ||
        subject.id !== f.subjectId ||
        JSON.stringify(subject.scope) !==
          JSON.stringify([
            f.canonicalLocationId,
            ...[...f.connectionIds].sort(),
          ]) ||
        !f.mappedSku ||
        !f.equivalentPool ||
        request.capability !== 'inventory.read' ||
        !onlyKeys(['sku', 'location'])
      )
        return false;
      const matched = mappings.filter(
        (e) =>
          e.facts.skuId === f.subjectId &&
          e.facts.locationId === f.canonicalLocationId,
      );
      if (matched.length !== 1) return false;
      return ['left', 'right'].some((side, index) => {
        const mapping = record(matched[0]!.facts[side]);
        const source = record(mapping?.source);
        return (
          source?.tenantId === f.tenantId &&
          source.connectionId === f.connectionIds[index] &&
          request.connectionId === source.connectionId &&
          sameExternalId(selectors.sku, mapping?.sku) &&
          sameExternalId(selectors.location, mapping?.location)
        );
      });
    }
    case 'stuck_fulfillment': {
      const f = input.facts;
      if (
        subject.kind !== 'fulfillment' ||
        subject.id !== f.subjectId ||
        subject.scope.length !== 1 ||
        subject.scope[0] !== f.connectionId ||
        !f.mapped ||
        request.capability !== 'fulfillment.read' ||
        request.connectionId !== f.connectionId ||
        !onlyKeys(['order'])
      )
        return false;
      const matched = mappings.filter(
        (e) => e.facts.fulfillmentId === f.subjectId,
      );
      if (matched.length !== 1) return false;
      const mapping = matched[0]!.facts,
        source = record(mapping.source);
      return (
        source?.tenantId === f.tenantId &&
        source.connectionId === f.connectionId &&
        sameExternalId(selectors.order, mapping.order)
      );
    }
    case 'workflow_failure':
      // Workflow effects require the execution owner's reconciliation path.
      return false;
  }
}
/** Canonical mapping and publication remain in workflows; the engine receives no connector write port. */
export function createDiagnosisRereader(
  reader: CapabilityReader,
  bindings: {
    plan(
      context: TenantContext,
      snapshot: Readonly<DiagnosisInput>,
    ): Promise<DiagnosisReadPlan | null>;
    /** Honor cancellation at the persistence boundary; do not commit after the signal aborts. */
    publish(
      context: TenantContext,
      snapshot: Readonly<DiagnosisInput>,
      pages: CapabilityOutput<ReadCapability>[],
      signal: AbortSignal,
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
      // Validate the whole plan before invoking even its first read.
      if (plan.requests.some((request) => !inIncidentScope(snapshot, request)))
        throw new Error('Read outside incident scope');
      const pages: CapabilityOutput<ReadCapability>[] = [];
      for (const request of plan.requests) {
        if (signal.aborted) throw new Error('Investigation cancelled');
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
      await bindings.publish(context, snapshot, pages, signal);
      if (signal.aborted) throw new Error('Investigation cancelled');
      return { status: 'completed', retryAfter: null };
    },
  };
}

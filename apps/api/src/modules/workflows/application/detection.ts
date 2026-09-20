import type {
  ConnectorFailure,
  ExternalId,
  FulfillmentSnapshot,
  InventorySnapshot,
  Observation,
  SourceIdentity,
} from '#modules/connectors/index';
import type {
  Configuration,
  DetectionService,
  Evidence,
  Facts,
} from '#modules/exceptions/index';
import { decimalString, decimalUnits } from '#modules/exceptions/index';
import type { TenantContext } from '#modules/identity/index';
import { requireTenant } from '#modules/identity/index';

export interface InventoryMapping {
  tenantId: string;
  version: string;
  publishedAt: string;
  skuId: string;
  locationId: string;
  left: { source: SourceIdentity; sku: ExternalId; location: ExternalId };
  right: { source: SourceIdentity; sku: ExternalId; location: ExternalId };
  authority: 'left' | 'right' | null;
  sellingSource: 'left' | 'right';
}

export interface FulfillmentMapping {
  tenantId: string;
  version: string;
  publishedAt: string;
  fulfillmentId: string;
  source: SourceIdentity;
  order: ExternalId;
  lines: ExternalId[];
}

const externalMatches = (a: ExternalId, b: ExternalId) =>
  a.externalId === b.externalId && a.scopeKey === b.scopeKey;

const sourceMatches = (a: SourceIdentity, b: SourceIdentity) =>
  externalMatches(a, b) &&
  a.tenantId === b.tenantId &&
  a.connectionId === b.connectionId &&
  a.provider === b.provider &&
  a.resource === b.resource;

function sourceEvidence<T>(
  observation: Observation<T>,
  facts: Record<string, unknown>,
): Evidence {
  const { tenantId, connectionId, ...source } = observation.source;

  return {
    key: observation.id,
    tenantId,
    connectionId,
    source,
    observedAt: observation.observedAt,
    sourceUpdatedAt: observation.sourceUpdatedAt,
    adapterVersion: observation.adapterVersion,
    schemaVersion: observation.schemaVersion,
    facts: {
      kind: observation.kind,
      sourceRevision: observation.sourceRevision,
      ...facts,
    },
  };
}

function inventoryEvidence(observation: Observation<InventorySnapshot>) {
  const d = observation.data;

  return sourceEvidence(observation, {
    sku: d.sku,
    location: d.location,
    unit: d.unit,
    available: d.available,
    availabilityBasis: d.availabilityBasis,
    onHand: d.onHand,
    reserved: d.reserved,
  });
}

/** Invoke with persisted scan/event IDs and mappings resolved inside the trusted tenant scope. */
export function createDetectionPipeline(
  service: DetectionService,
  hash: (value: string) => string,
) {
  const key = (parts: unknown[]) => hash(JSON.stringify(parts));

  return {
    inventory(
      context: TenantContext,
      input: {
        left: Observation<InventorySnapshot>;
        right: Observation<InventorySnapshot>;
        mapping: InventoryMapping;
        complete: boolean;
        projectionCurrent: boolean;
        configuration: Configuration;
      },
    ) {
      const { left, right, mapping, configuration } = input;
      requireTenant(context, mapping.tenantId);
      requireTenant(context, left.source.tenantId);
      requireTenant(context, right.source.tenantId);
      requireTenant(context, mapping.left.source.tenantId);
      requireTenant(context, mapping.right.source.tenantId);
      const mappedSku =
        sourceMatches(left.source, mapping.left.source) &&
        sourceMatches(right.source, mapping.right.source) &&
        externalMatches(left.data.sku, mapping.left.sku) &&
        externalMatches(right.data.sku, mapping.right.sku);
      const equivalentPool =
        externalMatches(left.data.location, mapping.left.location) &&
        externalMatches(right.data.location, mapping.right.location);
      const mappingKey = `mapping:${key(['inventory', mapping])}`;
      const facts: Facts<'inventory_mismatch'> = {
        tenantId: context.tenantId,
        evidenceTenantId: context.tenantId,
        subjectId: mapping.skuId,
        evidenceRefs: [left.id, right.id, mappingKey],
        connectionIds: [left.source.connectionId, right.source.connectionId],
        canonicalLocationId: mapping.locationId,
        leftAvailable: left.data.available,
        rightAvailable: right.data.available,
        leftUnit: left.data.unit,
        rightUnit: right.data.unit,
        leftObservedAt: left.observedAt,
        rightObservedAt: right.observedAt,
        leftBasis: left.data.availabilityBasis,
        rightBasis: right.data.availabilityBasis,
        mappedSku,
        equivalentPool,
        complete:
          input.complete &&
          left.kind === 'snapshot' &&
          right.kind === 'snapshot',
        projectionCurrent: input.projectionCurrent,
        authority: mapping.authority,
        sellingSource: mapping.sellingSource,
        tolerance: configuration.inventoryTolerance,
      };
      const mappingEvidence: Evidence = {
        key: mappingKey,
        tenantId: context.tenantId,
        connectionId: null,
        source: null,
        observedAt: mapping.publishedAt,
        sourceUpdatedAt: null,
        adapterVersion: 'canonical-mapping-v1',
        schemaVersion: 1,
        facts: { ...mapping },
      };

      return service.ingest(context, {
        key: key([
          'inventory',
          left.id,
          right.id,
          mappingKey,
          input.complete,
          input.projectionCurrent,
        ]),
        input: { exceptionClass: 'inventory_mismatch', facts },
        evidence: [
          inventoryEvidence(left),
          inventoryEvidence(right),
          mappingEvidence,
        ],
        configuration,
      });
    },
    fulfillment(
      context: TenantContext,
      input: {
        observation: Observation<FulfillmentSnapshot>;
        mapping: FulfillmentMapping;
        complete: boolean;
        eligibility: 'eligible' | 'exempt' | 'unknown';
        eligibilityEvidence: Evidence;
        configuration: Configuration;
      },
    ) {
      const { observation: o, mapping, configuration } = input;
      requireTenant(context, o.source.tenantId);
      requireTenant(context, mapping.tenantId);
      requireTenant(context, mapping.source.tenantId);
      const uniqueLines =
        new Set(o.data.lines.map((line) => JSON.stringify(line.orderLine)))
          .size === o.data.lines.length &&
        new Set(mapping.lines.map((line) => JSON.stringify(line))).size ===
          mapping.lines.length;
      const mapped =
        uniqueLines &&
        sourceMatches(o.source, mapping.source) &&
        externalMatches(o.data.order, mapping.order) &&
        o.data.lines.length === mapping.lines.length &&
        o.data.lines.every((line) =>
          mapping.lines.some((expected) =>
            externalMatches(line.orderLine, expected),
          ),
        );
      const units = new Set(o.data.lines.map((line) => line.quantity.unit));
      const amounts = o.data.lines.map((line) =>
        decimalUnits(line.quantity.amount),
      );
      const quantity = amounts.some((amount) => amount < 0n)
        ? '-1'
        : o.data.lines.length === 0
          ? null
          : decimalString(
              o.data.lines.reduce(
                (sum, line) => sum + decimalUnits(line.quantity.amount),
                0n,
              ),
            );
      const mappingKey = `mapping:${key(['fulfillment', mapping])}`;
      const facts: Facts<'stuck_fulfillment'> = {
        tenantId: context.tenantId,
        evidenceTenantId: context.tenantId,
        subjectId: mapping.fulfillmentId,
        evidenceRefs: [o.id, mappingKey, input.eligibilityEvidence.key],
        connectionId: o.source.connectionId,
        status: o.data.status,
        observedAt: o.observedAt,
        lastProgressAt: o.data.lastProgressAt,
        quantity,
        unit: units.size === 1 ? [...units][0]! : 'unknown',
        mapped,
        complete: input.complete && o.kind === 'snapshot',
        eligibility: input.eligibility,
        progressBasis:
          o.source.provider === 'jtl'
            ? 'note_created_or_package_shipped'
            : 'source_updated',
        otherOperationShippedQuantity: '0',
      };
      const mappingEvidence: Evidence = {
        key: mappingKey,
        tenantId: context.tenantId,
        connectionId: null,
        source: null,
        observedAt: mapping.publishedAt,
        sourceUpdatedAt: null,
        adapterVersion: 'canonical-mapping-v1',
        schemaVersion: 1,
        facts: { ...mapping },
      };

      return service.ingest(context, {
        key: key([
          'fulfillment',
          o.id,
          mappingKey,
          input.eligibilityEvidence.key,
          input.complete,
          input.eligibility,
        ]),
        input: { exceptionClass: 'stuck_fulfillment', facts },
        configuration,
        evidence: [
          sourceEvidence(o, {
            order: o.data.order,
            status: o.data.status,
            lines: o.data.lines,
            lastProgressAt: o.data.lastProgressAt,
            failureCode: o.data.failureCode,
          }),
          mappingEvidence,
          input.eligibilityEvidence,
        ],
      });
    },
    scan(
      context: TenantContext,
      input: {
        event: Evidence;
        connectionId: string;
        capability: Facts<'sync_failure'>['capability'];
        active: boolean;
        status: 'failed' | 'success';
        error: ConnectorFailure | null;
        firstFailureAt: string;
        retryExhausted: boolean;
        scanComplete: boolean;
        configuration: Configuration;
      },
    ) {
      const { event, configuration } = input;
      const facts: Facts<'sync_failure'> = {
        tenantId: context.tenantId,
        evidenceTenantId: event.tenantId,
        subjectId: input.connectionId,
        evidenceRefs: [event.key],
        connectionId: input.connectionId,
        capability: input.capability,
        active: input.active,
        status: input.status,
        errorCode: input.error?.code ?? null,
        firstFailureAt: input.firstFailureAt,
        retryExhausted: input.retryExhausted,
        scanComplete: input.scanComplete,
      };

      return service.ingest(context, {
        key: key(['scan', input.connectionId, event.key]),
        input: { exceptionClass: 'sync_failure', facts },
        configuration,
        evidence: [event],
      });
    },
    workflow(
      context: TenantContext,
      input: {
        event: Evidence;
        facts: Omit<
          Facts<'workflow_failure'>,
          'tenantId' | 'evidenceTenantId' | 'evidenceRefs'
        >;
        configuration: Configuration;
      },
    ) {
      return service.ingest(context, {
        key: key(['workflow', input.event.key]),
        input: {
          exceptionClass: 'workflow_failure',
          facts: {
            ...input.facts,
            tenantId: context.tenantId,
            evidenceTenantId: input.event.tenantId,
            evidenceRefs: [input.event.key],
          },
        },
        evidence: [input.event],
        configuration: input.configuration,
      });
    },
  };
}

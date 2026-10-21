import type {
  CapabilityOutput,
  CapabilityReader,
  CapabilityRequest,
  CommerceObservation,
  FulfillmentSnapshot,
  InventorySnapshot,
  Observation,
  ReadCapability,
} from '@luma/connections';
import type {
  DetectionRequest,
  DiagnosisInput,
  Evidence,
} from '@luma/exceptions';
import type { TenantContext } from '@luma/identity';
import { z } from 'zod';

import {
  fulfillmentRequest,
  type InventoryMapping,
  inventoryRequest,
} from '../application/detection.js';
import type { DiagnosisReadPlan } from '../application/diagnosis.js';

const external = z.object({
  externalId: z.string().min(1).max(1024),
  scopeKey: z.string().max(1024),
});
const source = external.extend({
  tenantId: z.string().min(1),
  connectionId: z.string().min(1),
  provider: z.string().min(1),
  resource: z.enum([
    'order',
    'order_line',
    'sku',
    'location',
    'fulfillment',
    'product',
    'customer',
    'return',
    'refund',
    'supplier',
    'purchase_order',
    'message',
    'return_reason',
    'inventory_transfer',
    'inventory_shipment',
  ]),
});
const side = z.object({ source, sku: external, location: external });
const factAuthority = z.object({
  group: z.enum([
    'order_lines',
    'order_lifecycle',
    'order_fulfillment',
    'order_tracking',
    'inventory_stock',
    'inventory_selling',
  ]),
  state: z.enum(['resolved', 'unknown', 'conflicting']),
  basis: z.enum(['default', 'override']),
  connectionId: z.string().nullable(),
  overrideConnectionId: z.string().nullable(),
  candidateIds: z.array(z.string()),
  eligibleIds: z.array(z.string()),
});
const inventoryMapping = z.object({
  tenantId: z.string(),
  version: z.string(),
  publishedAt: z.string().datetime({ offset: true }),
  skuId: z.string(),
  locationId: z.string(),
  left: side,
  right: side,
  authority: z.enum(['left', 'right']).nullable(),
  sellingSource: z.enum(['left', 'right']),
  sourceAuthority: z
    .object({
      revision: z.number().int().nonnegative(),
      stock: factAuthority,
      selling: factAuthority,
    })
    .optional(),
});
const fulfillmentMapping = z.object({
  tenantId: z.string(),
  version: z.string(),
  publishedAt: z.string().datetime({ offset: true }),
  fulfillmentId: z.string(),
  source,
  order: external,
  lines: z.array(external),
});

// CapabilityReader has already validated complete normalized replies through each provider's
// output contract. These guards select the expected snapshot from its typed union; projection
// validates every optional field again through the Connections owner's observation boundary.
const decimal = z
  .string()
  .regex(/^-?\d{1,14}(\.\d{1,6})?$/)
  .nullable();
const inventoryData = z.object({
  sku: external,
  location: external,
  unit: z.string().min(1),
  onHand: decimal,
  reserved: decimal,
  available: decimal,
  availabilityBasis: z.enum(['provider_reported', 'derived', 'unknown']),
});

function isInventoryObservation(
  value: Observation<unknown>,
): value is Observation<InventorySnapshot> {
  return (
    value.source.resource === 'sku' &&
    inventoryData.safeParse(value.data).success
  );
}

const fulfillmentData = z.object({
  order: external,
  status: z.enum([
    'pending',
    'processing',
    'completed',
    'shipped',
    'delivered',
    'cancelled',
    'failed',
    'unknown',
  ]),
  lines: z.array(
    z.object({
      orderLine: external,
      quantity: z.object({ amount: z.string(), unit: z.string() }),
    }),
  ),
  lastProgressAt: z.string().datetime({ offset: true }).nullable(),
  failureCode: z.string().nullable(),
});

function isFulfillmentObservation(
  value: Observation<unknown>,
): value is Observation<FulfillmentSnapshot> {
  return (
    value.source.resource === 'fulfillment' &&
    fulfillmentData.safeParse(value.data).success
  );
}

function retainedMapping(snapshot: DiagnosisInput) {
  const found = snapshot.evidence.filter(
    (evidence) =>
      evidence.adapterVersion === 'canonical-mapping-v1' &&
      evidence.connectionId === null &&
      evidence.source === null &&
      evidence.tenantId === snapshot.input.facts.tenantId,
  );

  return found.length === 1 ? found[0]!.facts : null;
}

/** Plans typed reads from retained canonical mappings; model text never selects a capability. */
export async function planActiveDiagnosis(
  context: TenantContext,
  snapshot: DiagnosisInput,
  reader: Pick<CapabilityReader, 'discover'>,
): Promise<DiagnosisReadPlan | null> {
  const requested: {
    connectionId: string;
    capability: ReadCapability;
    input: CapabilityRequest<ReadCapability>['input'];
  }[] = [];
  if (snapshot.input.exceptionClass === 'inventory_mismatch') {
    const parsed = inventoryMapping.safeParse(retainedMapping(snapshot));
    if (!parsed.success) return null;
    for (const entry of [parsed.data.left, parsed.data.right])
      requested.push({
        connectionId: entry.source.connectionId,
        capability: 'inventory.read',
        input: { limit: 10, sku: entry.sku, location: entry.location },
      });
  } else if (snapshot.input.exceptionClass === 'stuck_fulfillment') {
    const parsed = fulfillmentMapping.safeParse(retainedMapping(snapshot));
    if (!parsed.success) return null;
    requested.push({
      connectionId: parsed.data.source.connectionId,
      capability: 'fulfillment.read',
      input: { limit: 10, order: parsed.data.order },
    });
  } else if (snapshot.input.exceptionClass === 'sync_failure') {
    const { facts } = snapshot.input;
    // A credential/grant failure is an operator task, never an automatic repeated experiment.
    if (
      !facts.active ||
      facts.accessLost ||
      facts.errorCode === 'authentication' ||
      facts.errorCode === 'permission_denied'
    )
      return null;
    requested.push({
      connectionId: facts.connectionId,
      capability: facts.capability,
      input: { limit: 100 },
    });
  } else return null;
  const requests: CapabilityRequest<ReadCapability>[] = [];
  for (const entry of requested) {
    const descriptor = (
      await reader.discover(context, entry.connectionId, entry.capability)
    ).find((item) => item.capability === entry.capability);
    if (!descriptor) return null;
    requests.push({ ...entry, version: descriptor.version });
  }

  return { requests, notBefore: null };
}

function page(value: CapabilityOutput<ReadCapability>, limit: number) {
  if (
    !('items' in value) ||
    !Array.isArray(value.items) ||
    !('completeness' in value) ||
    !('nextCursor' in value) ||
    value.items.length > limit
  )
    throw new Error('Investigation reply exceeds its bounded page contract');

  return {
    items: value.items,
    complete: value.completeness === 'complete' && value.nextCursor === null,
    retryAfterMs:
      'retryAfterMs' in value && typeof value.retryAfterMs === 'number'
        ? value.retryAfterMs
        : 0,
  };
}

/** Normalized reads to project atomically alongside their detection request. */
export type InvestigationObservation = Extract<
  CommerceObservation,
  { capability: 'inventory.read' | 'fulfillment.read' }
>;

/**
 * Reuses trusted detection builders and keeps scan completeness and uncertainty explicit. The
 * runtime publisher establishes whether every normalized inventory observation projected before
 * marking canonical state current. A complete page with no unique subject cannot invent absence.
 */
export function activeDiagnosisPublication(
  context: TenantContext,
  snapshot: DiagnosisInput,
  outputs: CapabilityOutput<ReadCapability>[],
  now: Date,
  hash: (value: string) => string,
): {
  request: DetectionRequest;
  observations: InvestigationObservation[];
} | null {
  if (new TextEncoder().encode(JSON.stringify(outputs)).length > 262_144)
    throw new Error('Investigation reply exceeds its data budget');
  const pages = outputs.map((value) =>
    page(value, snapshot.input.exceptionClass === 'sync_failure' ? 100 : 10),
  );
  const observations: InvestigationObservation[] = [];
  let request: DetectionRequest;
  const input = snapshot.input;
  const expectedConnections =
    input.exceptionClass === 'inventory_mismatch'
      ? (() => {
          const mapping = inventoryMapping.parse(retainedMapping(snapshot));

          return [
            mapping.left.source.connectionId,
            mapping.right.source.connectionId,
          ];
        })()
      : input.exceptionClass === 'sync_failure' ||
          input.exceptionClass === 'stuck_fulfillment'
        ? [input.facts.connectionId]
        : [];
  if (pages.length !== expectedConnections.length) return null;
  for (const [index, entry] of pages.entries()) {
    for (const item of entry.items) {
      const claimed = z.object({ source }).parse(item).source;
      if (
        claimed.tenantId !== context.tenantId ||
        claimed.connectionId !== expectedConnections[index]
      )
        throw new Error('Investigation reply has foreign provenance');
    }
  }
  if (input.exceptionClass === 'inventory_mismatch') {
    const { sourceAuthority, ...base } = inventoryMapping.parse(
      retainedMapping(snapshot),
    );
    const mapping: InventoryMapping = {
      ...base,
      ...(sourceAuthority ? { sourceAuthority } : {}),
    };
    const parsed = pages
      .flatMap<Observation<unknown>>((entry) => entry.items)
      .filter(isInventoryObservation)
      .map((observation) => ({
        capability: 'inventory.read' as const,
        observation,
      }));
    const match = (entry: typeof mapping.left) =>
      parsed.filter(
        (value) =>
          value.observation.source.tenantId === context.tenantId &&
          value.observation.source.connectionId === entry.source.connectionId &&
          value.observation.source.externalId === entry.source.externalId &&
          value.observation.source.scopeKey === entry.source.scopeKey &&
          value.observation.data.sku.externalId === entry.sku.externalId &&
          value.observation.data.sku.scopeKey === entry.sku.scopeKey &&
          value.observation.data.location.externalId ===
            entry.location.externalId &&
          value.observation.data.location.scopeKey === entry.location.scopeKey,
      );
    const left = match(mapping.left),
      right = match(mapping.right);
    if (left.length !== 1 || right.length !== 1) return null;
    observations.push(
      {
        capability: 'inventory.read',
        observation: left[0]!.observation,
      },
      {
        capability: 'inventory.read',
        observation: right[0]!.observation,
      },
    );
    request = inventoryRequest(
      context,
      {
        left: left[0]!.observation,
        right: right[0]!.observation,
        mapping,
        complete: pages.length === 2 && pages.every((entry) => entry.complete),
        projectionCurrent: false,
        configuration: snapshot.configuration,
      },
      hash,
    );
  } else if (input.exceptionClass === 'stuck_fulfillment') {
    const mapping = fulfillmentMapping.parse(retainedMapping(snapshot));
    const parsed = pages
      .flatMap<Observation<unknown>>((entry) => entry.items)
      .filter(isFulfillmentObservation)
      .map((observation) => ({
        capability: 'fulfillment.read' as const,
        observation,
      }))
      .filter(
        (entry) =>
          entry.observation.source.tenantId === context.tenantId &&
          entry.observation.source.connectionId ===
            mapping.source.connectionId &&
          entry.observation.source.externalId === mapping.source.externalId &&
          entry.observation.source.scopeKey === mapping.source.scopeKey,
      );
    if (parsed.length !== 1) return null;
    const observation = parsed[0]!.observation;
    observations.push({ capability: 'fulfillment.read', observation });
    const eligibility = snapshot.evidence.find((entry) =>
      entry.key.startsWith('eligibility:'),
    );
    if (!eligibility) return null;
    // A scoped read can refresh progress; it does not renew old hold/schedule eligibility.
    request = fulfillmentRequest(
      context,
      {
        observation,
        mapping,
        complete: pages.every((entry) => entry.complete),
        eligibility: 'unknown',
        eligibilityEvidence: eligibility,
        configuration: snapshot.configuration,
      },
      hash,
    );
  } else if (input.exceptionClass === 'sync_failure') {
    const complete = pages.length === 1 && pages[0]!.complete;
    const event: Evidence = {
      key: `investigation-scan:${hash(JSON.stringify([snapshot.exceptionId, snapshot.revision, outputs]))}`,
      tenantId: context.tenantId,
      connectionId: input.facts.connectionId,
      source: null,
      observedAt: now.toISOString(),
      sourceUpdatedAt: null,
      adapterVersion: 'diagnosis-investigation-v1',
      schemaVersion: 1,
      facts: {
        scanComplete: complete,
        originalFailureAt: input.facts.firstFailureAt,
        pageItemCounts: pages.map((entry) => entry.items.length),
      },
    };
    request = {
      key: event.key,
      input: {
        exceptionClass: 'sync_failure',
        facts: {
          ...input.facts,
          evidenceRefs: [event.key],
          status: 'success',
          errorCode: null,
          scanComplete: complete,
        },
      },
      evidence: [event],
      configuration: snapshot.configuration,
    };
  } else return null;
  const marker: Evidence = {
    key: `investigation:${hash(JSON.stringify([snapshot.exceptionId, snapshot.revision, request.key]))}`,
    tenantId: context.tenantId,
    connectionId: null,
    source: null,
    observedAt: now.toISOString(),
    sourceUpdatedAt: null,
    adapterVersion: 'diagnosis-investigation-v1',
    schemaVersion: 1,
    facts: {
      incidentId: snapshot.exceptionId,
      baseRevision: snapshot.revision,
      calls: outputs.length,
      maximumCalls: 2,
      actorId: context.actor.id,
      completedAt: now.toISOString(),
      complete: pages.every((entry) => entry.complete),
      costUsd: null,
      modelCalls: 0,
      retryAfterMs: Math.max(0, ...pages.map((entry) => entry.retryAfterMs)),
      supportingEvidenceRefs: [...request.input.facts.evidenceRefs],
      previousEvidenceRefs: [...snapshot.input.facts.evidenceRefs],
    },
  };
  request.evidence.push(marker);
  request.input.facts.evidenceRefs.push(marker.key);

  return { request, observations };
}

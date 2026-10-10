import { createHash } from 'node:crypto';

import { z } from 'zod';

import type {
  DetectionRequest,
  HumanDisposition,
  Resolution,
} from '../application/detection.js';
import { identity } from '../domain/evaluate.js';
import type { EvaluationInput, ExceptionClass } from '../domain/facts.js';

const timestamp = z.string().datetime();

const decimal = z.string().regex(/^-?\d{1,14}(?:\.\d{1,6})?$/);

const common = {
  tenantId: z.string().min(1),
  evidenceTenantId: z.string().min(1),
  subjectId: z.string().min(1),
  evidenceRefs: z.array(z.string().min(1)).min(1),
};

export const factSchemas = {
  sync_failure: z
    .object({
      ...common,
      connectionId: z.string().min(1),
      capability: z.enum([
        'inventory.read',
        'orders.read',
        'fulfillment.read',
        'products.read',
      ]),
      active: z.boolean(),
      accessLost: z.boolean().optional(),
      status: z.enum(['failed', 'success']),
      errorCode: z
        .enum([
          'authentication',
          'permission_denied',
          'invalid_response',
          'export_unavailable',
          'unsupported_capability',
          'unsupported_version',
          'transient',
          'timeout',
          'rate_limited',
          'internal',
          'unavailable',
          'invalid_input',
          'not_found',
          'conflict',
        ])
        .nullable(),
      firstFailureAt: timestamp,
      retryExhausted: z.boolean(),
      scanComplete: z.boolean(),
    })
    .strict(),
  stuck_fulfillment: z
    .object({
      ...common,
      connectionId: z.string().min(1),
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
      observedAt: timestamp,
      lastProgressAt: timestamp.nullable(),
      quantity: decimal.nullable(),
      unit: z.string().min(1),
      mapped: z.boolean(),
      complete: z.boolean(),
      eligibility: z.enum(['eligible', 'exempt', 'unknown']),
      progressBasis: z.enum([
        'note_created_or_package_shipped',
        'source_updated',
        'unknown',
      ]),
      otherOperationShippedQuantity: decimal,
    })
    .strict(),
  inventory_mismatch: z
    .object({
      ...common,
      connectionIds: z.tuple([z.string().min(1), z.string().min(1)]),
      canonicalLocationId: z.string().min(1),
      leftAvailable: decimal.nullable(),
      rightAvailable: decimal.nullable(),
      leftUnit: z.string().min(1),
      rightUnit: z.string().min(1),
      leftObservedAt: timestamp,
      rightObservedAt: timestamp,
      leftBasis: z.enum(['provider_reported', 'derived', 'unknown']),
      rightBasis: z.enum(['provider_reported', 'derived', 'unknown']),
      mappedSku: z.boolean(),
      equivalentPool: z.boolean(),
      complete: z.boolean(),
      projectionCurrent: z.boolean(),
      authority: z.enum(['left', 'right']).nullable(),
      authorityState: z.enum(['resolved', 'unknown', 'conflicting']).optional(),
      sellingSource: z.enum(['left', 'right']),
      tolerance: decimal.refine((value) => !value.startsWith('-')),
    })
    .strict(),
  workflow_failure: z
    .object({
      ...common,
      runId: z.string().min(1),
      stepKey: z.string().min(1),
      attempt: z.number().int().positive(),
      status: z.enum([
        'failed',
        'timed_out',
        'running',
        'succeeded',
        'cancelled',
        'interrupted',
      ]),
      durable: z.boolean(),
      retryExhausted: z.boolean(),
      effect: z.enum(['none', 'unknown']),
      executionId: z.string().min(1).nullable(),
      errorCode: z.string().min(1),
    })
    .strict(),
};

export const thresholdsSchema = z
  .object({
    freshnessSeconds: z.number().int().positive(),
    pairSkewSeconds: z.number().int().positive(),
    syncFailureSeconds: z.number().int().positive(),
    stuckSeconds: z.number().int().positive(),
    uncertaintySeconds: z.number().int().positive(),
  })
  .strict();

export const configurationSchema = z
  .object({
    version: z.string().min(1),
    ruleVersion: z.literal('v0.1'),
    thresholds: thresholdsSchema,
    inventoryTolerance: decimal.refine((value) => !value.startsWith('-')),
  })
  .strict();

/**
 * Validates and normalizes detector input for the selected exception class; rejects facts
 * that do not match that class.
 */
export function parseInput(
  exceptionClass: ExceptionClass,
  facts: unknown,
): EvaluationInput {
  return {
    exceptionClass,
    facts: factSchemas[exceptionClass].parse(facts),
  } as EvaluationInput;
}

const ref = z.string().min(1).max(512);

export const evidenceSchema = z
  .object({
    key: ref,
    tenantId: z.string().uuid(),
    connectionId: ref.nullable(),
    observedAt: z.string().datetime(),
    sourceUpdatedAt: z.string().datetime().nullable(),
    adapterVersion: ref,
    schemaVersion: z.literal(1),
    // Only normalized facts belong here; connector payloads stay with connectors.
    source: z
      .object({
        provider: ref,
        resource: ref,
        externalId: ref,
        scopeKey: z.string(),
      })
      .strict()
      .nullable(),
    facts: z.record(z.string(), z.unknown()),
  })
  .strict();

const humanDispositionSchema = z
  .object({
    kind: z.literal('human_disposition'),
    reason: ref,
    evidenceRefs: z.array(ref).min(1),
  })
  .strict();

export const resolutionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('human_disposition'),
      reason: ref,
      evidenceRefs: z.array(ref).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('verification'),
      reason: ref,
      evidenceRefs: z.array(ref).min(1),
      fingerprint: z.string().length(64),
      configVersion: ref,
      evaluatorVersion: ref,
      outcome: z.enum(['passed', 'failed', 'inconclusive']),
      complete: z.boolean(),
      authoritative: z.boolean(),
      evidence: z.array(evidenceSchema).min(1),
      incidentVersion: z.number().int().positive(),
      bindings: z
        .array(
          z
            .object({
              evidenceKey: ref,
              exceptionClass: z.enum([
                'sync_failure',
                'stuck_fulfillment',
                'inventory_mismatch',
                'workflow_failure',
              ]),
              subject: z
                .object({
                  ruleIdentity: ref,
                  subjectKind: ref,
                  subjectId: z.string().uuid(),
                  scope: z.array(ref),
                })
                .strict(),
              postcondition: z.enum([
                'complete_scan_checkpoint_advanced',
                'fulfillment_disposition_verified',
                'equivalent_inventory_agrees',
                'workflow_business_postcondition_verified',
              ]),
            })
            .strict(),
        )
        .min(1),
    })
    .strict(),
]);

export const detectionBoundary = {
  parse(request: DetectionRequest): DetectionRequest {
    const input = parseInput(request.input.exceptionClass, request.input.facts);
    z.string().uuid().parse(input.facts.tenantId);
    z.string().uuid().parse(identity(input).subjectId);
    if (input.exceptionClass === 'inventory_mismatch') {
      z.string().uuid().parse(input.facts.canonicalLocationId);
      z.array(z.string().uuid()).parse(input.facts.connectionIds);
    } else if (input.exceptionClass === 'stuck_fulfillment')
      z.string().uuid().parse(input.facts.connectionId);
    if (
      input.exceptionClass === 'workflow_failure' &&
      input.facts.effect === 'unknown'
    )
      z.string().uuid().parse(input.facts.executionId);

    return {
      key: ref.parse(request.key),
      input,
      evidence: z.array(evidenceSchema).min(1).parse(request.evidence),
      configuration: configurationSchema.parse(request.configuration),
    };
  },
  hash: (value: string) => createHash('sha256').update(value).digest('hex'),
  id: (value: string) => z.string().uuid().parse(value),
  disposition: (value: HumanDisposition) => humanDispositionSchema.parse(value),
  resolution: (value: Resolution) => resolutionSchema.parse(value),
};

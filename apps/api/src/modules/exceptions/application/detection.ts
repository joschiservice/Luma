import {
  evaluate,
  fingerprintMaterial,
  identity,
} from '#modules/exceptions/domain/evaluate';
import type {
  Configuration,
  Decision,
  EvaluationInput,
  ExceptionClass,
} from '#modules/exceptions/domain/facts';
import type { TenantContext } from '#modules/identity/index';
import { requireRole, requireTenant } from '#modules/identity/index';
import { measureSync } from '#modules/platform/index';

export interface Evidence {
  key: string;
  tenantId: string;
  connectionId: string | null;
  observedAt: string;
  sourceUpdatedAt: string | null;
  adapterVersion: string;
  schemaVersion: 1;
  source: {
    provider: string;
    resource: string;
    externalId: string;
    scopeKey: string;
  } | null;
  facts: Record<string, unknown>;
}

export interface HumanDisposition {
  kind: 'human_disposition';
  reason: string;
  evidenceRefs: string[];
}

export interface VerifiedDisposition {
  kind: 'verification';
  reason: string;
  evidenceRefs: string[];
  fingerprint: string;
  configVersion: string;
  evaluatorVersion: string;
  outcome: 'passed' | 'failed' | 'inconclusive';
  complete: boolean;
  authoritative: boolean;
  evidence: Evidence[];
  bindings: VerificationBinding[];
  incidentVersion: number;
}

export const verificationPostconditions = {
  sync_failure: 'complete_scan_checkpoint_advanced',
  stuck_fulfillment: 'fulfillment_disposition_verified',
  inventory_mismatch: 'equivalent_inventory_agrees',
  workflow_failure: 'workflow_business_postcondition_verified',
} as const;

export interface VerificationBinding {
  evidenceKey: string;
  exceptionClass: ExceptionClass;
  subject: Incident['subject'];
  postcondition: (typeof verificationPostconditions)[ExceptionClass];
}

export type VerificationResult = Pick<
  VerifiedDisposition,
  'reason' | 'outcome' | 'complete' | 'authoritative' | 'evidence' | 'bindings'
>;

/** Installed by the composition root. Reads authoritative state and checks the business postcondition. */
export interface VerificationEvaluator {
  version: string;
  evaluate(
    context: TenantContext,
    incident: Readonly<Incident>,
  ): Promise<VerificationResult>;
}

export type Resolution = HumanDisposition | VerifiedDisposition;

export interface DetectionRequest {
  /** Delivery correlation ID. Occurrences deduplicate by immutable evidence references. */
  key: string;
  input: EvaluationInput;
  evidence: Evidence[];
  configuration: Configuration;
}

export interface Incident {
  id: string;
  tenantId: string;
  fingerprint: string;
  exceptionClass: ExceptionClass;
  subject: ReturnType<typeof identity>;
  severity: 'medium' | 'high';
  state:
    | 'detected'
    | 'diagnosed'
    | 'proposed'
    | 'awaiting_approval'
    | 'allowed'
    | 'executing'
    | 'verifying'
    | 'resolved'
    | 'failed'
    | 'escalated';
  firstDetectedAt: string;
  lastDetectedAt: string;
  occurrenceCount: number;
  previousExceptionId: string | null;
  ruleVersion: string;
  configVersion: string;
  resolution?: Resolution & { actorId: string; at: string; auditId: string };
}

export interface DetectionResult {
  decision: Decision;
  incident: Incident | null;
  reviewRequired: boolean;
}

export interface Evaluation {
  request: DetectionRequest & { deliveryKey: string };
  decision: Decision;
  fingerprint: string;
  now: string;
}

export interface IncidentVerificationAttempt {
  attemptId?: string;
  phase: 'pending' | 'completed';
  actorId: string;
  occurredAt: string;
  evaluatorVersion: string;
  outcome?: 'passed' | 'failed' | 'inconclusive';
  evidenceRefs?: string[];
  authoritative?: boolean;
  complete?: boolean;
  accepted?: boolean;
  failureCode?: 'evaluation_failed' | 'resolution_rejected';
}

export interface DetectionRepository {
  verification(
    tenantId: string,
    incidentId: string,
    entry: IncidentVerificationAttempt,
  ): Promise<string>;
  record(value: Evaluation): Promise<DetectionResult>;
  get(
    tenantId: string,
    incidentId: string,
  ): Promise<{ incident: Incident; version: number } | null>;
  list(tenantId: string): Promise<Incident[]>;
  evidence(tenantId: string, incidentId: string): Promise<Evidence[]>;
  resolve(
    tenantId: string,
    incidentId: string,
    disposition: Resolution,
    actorId: string,
    now: string,
  ): Promise<boolean>;
}

/**
 * Creates incident detection, evidence ingestion, and resolution commands using the supplied
 * persistence and verification boundaries.
 */
export function createDetectionService(
  repository: DetectionRepository,
  now: () => Date,
  boundary: {
    parse(request: DetectionRequest): DetectionRequest;
    hash(value: string): string;
    id(value: string): string;
    resolution(value: Resolution): Resolution;
    disposition(value: HumanDisposition): HumanDisposition;
  },
  verifier?: VerificationEvaluator,
) {
  return {
    async ingest(context: TenantContext, request: DetectionRequest) {
      requireTenant(context, request.input.facts.tenantId);
      const { input, configuration, evidence } = boundary.parse(request);
      const fingerprint = boundary.hash(fingerprintMaterial(input));
      const key = boundary.hash(
        JSON.stringify([
          fingerprint,
          ...input.facts.evidenceRefs.slice().sort(),
        ]),
      );
      // Reject tenant provenance before any writes, including configuration publication.
      if (
        input.facts.evidenceTenantId !== context.tenantId ||
        evidence.some((item) => item.tenantId !== context.tenantId)
      )
        return {
          decision: {
            decision: 'reject',
            severity: null,
            reason: 'tenant_mismatch',
          },
          incident: null,
          reviewRequired: false,
        } satisfies DetectionResult;
      const refs = new Set(input.facts.evidenceRefs);
      if (
        refs.size !== input.facts.evidenceRefs.length ||
        evidence.length !== refs.size ||
        new Set(evidence.map((item) => item.key)).size !== refs.size ||
        evidence.some((item) => !refs.has(item.key))
      )
        throw new Error('Evidence references must match immutable evidence');
      const connections =
        input.exceptionClass === 'inventory_mismatch'
          ? input.facts.connectionIds
          : input.exceptionClass === 'workflow_failure'
            ? []
            : [input.facts.connectionId];
      if (
        evidence.some(
          (item) =>
            item.connectionId !== null &&
            !connections.includes(item.connectionId),
        )
      )
        throw new Error('Evidence connection does not match evaluation scope');
      if (
        input.exceptionClass === 'inventory_mismatch' &&
        input.facts.tolerance !== configuration.inventoryTolerance
      )
        throw new Error('Inventory tolerance must match configuration');
      const clock = now().toISOString();

      return repository.record({
        request: {
          key,
          input,
          evidence,
          configuration,
          deliveryKey: request.key,
        },
        decision: measureSync('detection.evaluate', () =>
          evaluate(input, clock, configuration.thresholds),
        ),
        fingerprint,
        now: clock,
      });
    },
    async get(context: TenantContext, incidentId: string) {
      requireTenant(context, context.tenantId);

      return (
        (await repository.get(context.tenantId, boundary.id(incidentId)))
          ?.incident ?? null
      );
    },
    list(context: TenantContext) {
      requireTenant(context, context.tenantId);

      return repository.list(context.tenantId);
    },
    evidence(context: TenantContext, incidentId: string) {
      requireTenant(context, context.tenantId);

      return repository.evidence(context.tenantId, boundary.id(incidentId));
    },
    async verify(context: TenantContext, incidentId: string) {
      requireRole(context, ['owner', 'admin']);
      if (!verifier)
        throw new Error('Verification evaluator is not configured');
      const id = boundary.id(incidentId);
      const snapshot = await repository.get(context.tenantId, id);
      if (!snapshot) throw new Error('Exception not found');
      if (snapshot.incident.state === 'resolved')
        throw new Error('Exception already resolved');
      const started = {
        phase: 'pending' as const,
        actorId: context.actor.id,
        occurredAt: now().toISOString(),
        evaluatorVersion: verifier.version,
      };
      const attemptId = await repository.verification(
        context.tenantId,
        id,
        started,
      );
      let proof: VerifiedDisposition;
      try {
        const result = await verifier.evaluate(
          context,
          structuredClone(snapshot.incident),
        );
        const parsed = boundary.resolution({
          ...result,
          kind: 'verification',
          fingerprint: snapshot.incident.fingerprint,
          configVersion: snapshot.incident.configVersion,
          evaluatorVersion: verifier.version,
          incidentVersion: snapshot.version,
          evidenceRefs: result.evidence.map((e) => e.key),
        });
        if (parsed.kind !== 'verification')
          throw new Error('Invalid verification result');
        for (const evidence of parsed.evidence)
          requireTenant(context, evidence.tenantId);
        proof = parsed;
      } catch (error) {
        await repository.verification(context.tenantId, id, {
          ...started,
          attemptId,
          phase: 'completed',
          occurredAt: now().toISOString(),
          failureCode: 'evaluation_failed',
        });
        throw error;
      }
      const completed = {
        ...started,
        attemptId,
        phase: 'completed' as const,
        outcome: proof.outcome,
        evidenceRefs: proof.evidenceRefs,
        authoritative: proof.authoritative,
        complete: proof.complete,
      };
      let accepted: boolean;
      try {
        accepted = await repository.resolve(
          context.tenantId,
          id,
          proof,
          context.actor.id,
          now().toISOString(),
        );
      } catch (error) {
        await repository.verification(context.tenantId, id, {
          ...completed,
          occurredAt: now().toISOString(),
          accepted: false,
          failureCode: 'resolution_rejected',
        });
        throw error;
      }
      await repository.verification(context.tenantId, id, {
        ...completed,
        occurredAt: now().toISOString(),
        accepted,
      });

      return accepted;
    },
    resolve(
      context: TenantContext,
      incidentId: string,
      disposition: HumanDisposition,
    ) {
      requireRole(context, ['owner', 'admin']);
      const parsed = boundary.disposition(disposition);

      return repository.resolve(
        context.tenantId,
        boundary.id(incidentId),
        parsed,
        context.actor.id,
        now().toISOString(),
      );
    },
  };
}

export type DetectionService = ReturnType<typeof createDetectionService>;

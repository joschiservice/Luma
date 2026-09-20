import type { Diagnosis, Incident } from '#modules/exceptions/index';
import type {
  BoundActionStep,
  ExecutionFailure,
  ExecutionRecord,
  VerificationAttempt,
} from '#modules/execution/index';
import type { TenantContext } from '#modules/identity/index';
import {
  IdentityError,
  requireRole,
  requireTenant,
} from '#modules/identity/index';

export interface ResolutionSelection {
  id: string;
  version: string;
  use: 'created' | 'improved' | 'reused' | 'partner_specific';
  reasonCode: string;
  previousVersion?: string | undefined;
  partnerCodeRef?: string | undefined;
}

export interface StartResolutionRun {
  id: string;
  diagnosisRevision: number;
  resolution: ResolutionSelection;
}

export type LearningFact =
  | {
      kind: 'cause';
      code: string;
      status: 'suspected' | 'confirmed' | 'rejected';
      supportingEvidenceRefs: string[];
      contradictingEvidenceRefs: string[];
      basis: 'model_hypothesis' | 'operator_investigation';
    }
  | {
      kind: 'repair_step';
      stepId: string;
      actionCode: string;
      inputEvidenceRefs: string[];
      actionHash: string;
      startedAt: string;
      finishedAt: string;
      effortSeconds: number;
      result: 'accepted' | 'failed' | 'unknown';
    }
  | {
      kind: 'intervention';
      stepId: string;
      reasonCode: string;
      effortSeconds: number;
      evidenceRefs: string[];
    }
  | {
      kind: 'observation';
      stepId: string;
      code: string;
      evidenceRefs: string[];
    }
  | {
      kind: 'human_edit';
      stepId: string;
      beforeHash: string;
      afterHash: string;
      reasonCode: string;
      evidenceRefs: string[];
    }
  | {
      kind: 'outcome';
      result: 'pending' | 'failed' | 'inconclusive' | 'verified';
      evaluatorVersion: string;
      authoritative: boolean;
      complete: boolean;
      evidenceRefs: string[];
      businessResult: {
        code: string;
        value: number | null;
        unit: string | null;
      };
    }
  | { kind: 'recurrence'; incidentId: string; evidenceRefs: string[] };

export interface LearningCommand {
  id: string;
  occurredAt: string;
  fact: LearningFact;
}

export interface LearningEvent extends LearningCommand {
  sequence: number;
  actorId: string;
  recordedAt: string;
}

export interface ResolutionRun extends StartResolutionRun {
  schemaVersion: 1;
  incidentId: string;
  actorId: string;
  createdAt: string;
  context: {
    evidenceRefs: string[];
    mappingVersions: string[];
    configVersion: string;
    ruleVersion: string;
    diagnosisVersion: string;
    hypotheses: Diagnosis['hypotheses'];
    model: Diagnosis['provenance']['model'];
  };
  generation: { kind: 'manual' | 'generated'; reference: string };
  artifactDigest: string;
}

export interface ResolutionHistory {
  run: ResolutionRun;
  events: LearningEvent[];
  steps: BoundActionStep[];
  executions: ExecutionRecord[];
  verifications: VerificationAttempt[];
  failures: ExecutionFailure[];
  incident: Incident;
  incidentVerifications: Record<string, unknown>[];
  recurrences: { id: string; detectedAt: string }[];
}

export interface LearningStore {
  list(
    context: TenantContext,
    incidentId: string,
    after?: string,
  ): Promise<{ items: ResolutionRun[]; nextCursor: string | null }>;
  start(
    context: TenantContext,
    incidentId: string,
    input: StartResolutionRun,
  ): Promise<ResolutionRun>;
  append(
    context: TenantContext,
    incidentId: string,
    runId: string,
    input: LearningCommand,
  ): Promise<LearningEvent>;
  read(
    context: TenantContext,
    incidentId: string,
    runId: string,
  ): Promise<ResolutionHistory>;
}

/** Resolution history commands that require a current owner or admin role. */
export interface LearningService {
  /** Lists resolution runs for an incident, optionally after a pagination cursor. */
  list(
    context: TenantContext,
    incidentId: string,
    after?: string,
  ): Promise<{ items: ResolutionRun[]; nextCursor: string | null }>;
  /** Validates and starts a resolution run bound to the supplied diagnosis revision. */
  start(
    context: TenantContext,
    incidentId: string,
    input: unknown,
  ): Promise<ResolutionRun>;
  /** Validates and appends a learning event to an existing resolution run. */
  append(
    context: TenantContext,
    incidentId: string,
    runId: string,
    input: unknown,
  ): Promise<LearningEvent>;
  /** Reads a resolution run with its evidence, execution attempts, and outcomes. */
  read(
    context: TenantContext,
    incidentId: string,
    runId: string,
  ): Promise<ResolutionHistory>;
}

/**
 * Creates authorized resolution-run and learning-event commands using the supplied
 * validators and persistent store.
 */
export function createLearningService(deps: {
  store: LearningStore;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  parseStart(input: unknown): StartResolutionRun;
  parseEvent(input: unknown): LearningCommand;
  parseId(input: string): string;
}): LearningService {
  async function authorized(context: TenantContext) {
    requireTenant(context, context.tenantId);
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    requireRole(fresh, ['owner', 'admin']);
    if (fresh.actor.id !== context.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Actor changed');

    return fresh;
  }

  return {
    async list(context: TenantContext, incidentId: string, after?: string) {
      return deps.store.list(
        await authorized(context),
        deps.parseId(incidentId),
        after === undefined ? undefined : deps.parseId(after),
      );
    },
    async start(context: TenantContext, incidentId: string, input: unknown) {
      return deps.store.start(
        await authorized(context),
        deps.parseId(incidentId),
        deps.parseStart(input),
      );
    },
    async append(
      context: TenantContext,
      incidentId: string,
      runId: string,
      input: unknown,
    ) {
      return deps.store.append(
        await authorized(context),
        deps.parseId(incidentId),
        deps.parseId(runId),
        deps.parseEvent(input),
      );
    },
    async read(context: TenantContext, incidentId: string, runId: string) {
      return deps.store.read(
        await authorized(context),
        deps.parseId(incidentId),
        deps.parseId(runId),
      );
    },
  };
}

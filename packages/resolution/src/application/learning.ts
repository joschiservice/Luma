import type { Diagnosis, Incident } from '@luma/exceptions';
import type {
  BoundActionStep,
  ExecutionFailure,
  ExecutionRecord,
  VerificationAttempt,
} from '@luma/execution';
import type { TenantContext } from '@luma/identity';
import { requirePermission, requireTenant } from '@luma/identity';
import { forbidden, ServiceError } from '@luma/platform';

import type {
  LearningCommand,
  LearningEvent,
  LearningEventFacts,
  LearningSelectionFacts,
  StartResolutionRun,
} from '../domain/learning.js';
import {
  learningEventConflict,
  learningSelectionConflict,
} from '../domain/learning.js';

export type {
  StartResolutionRun,
  LearningCommand,
  LearningEvent,
} from '../domain/learning.js';

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

/** Retained sources read under the resolution run lock for a new selection. */
export interface LearningRunSources extends LearningSelectionFacts {
  diagnosis: Pick<Diagnosis, 'hypotheses' | 'provenance'>;
  generation: ResolutionRun['generation'];
  artifactDigest: string;
  createdAt: string;
}

/** Facts read under the run and event locks for a new learning event. */
export interface LearningEventSources extends LearningEventFacts {
  sequence: number;
}

export interface LearningStore {
  /** Lists retained runs for the incident using tenant-scoped pagination. */
  list(
    context: TenantContext,
    incidentId: string,
    after?: string,
  ): Promise<{ items: ResolutionRun[]; nextCursor: string | null }>;
  /**
   * Locks the run and checks request, actor and incident identity before invoking accept.
   * Exact replays return the original record without calling accept. Fresh acceptance and
   * insertion share the transaction; rejection rolls back and conflicting IDs fail.
   */
  recordRun(
    context: TenantContext,
    incidentId: string,
    input: StartResolutionRun,
    accept: (sources: LearningRunSources) => ResolutionRun,
  ): Promise<ResolutionRun>;
  /**
   * Locks the run, then event ID, and checks request, actor and run identity before accept.
   * Exact replays skip accept. Source reads, acceptance, sequence allocation and insertion
   * share the transaction. Rejection must leave no event or consumed sequence.
   */
  recordEvent(
    context: TenantContext,
    incidentId: string,
    runId: string,
    input: LearningCommand,
    accept: (sources: LearningEventSources) => LearningEvent,
  ): Promise<LearningEvent>;
  /** Reads all retained history collections from one tenant-scoped statement snapshot. */
  read(
    context: TenantContext,
    incidentId: string,
    runId: string,
  ): Promise<ResolutionHistory>;
}

/** Resolution history commands that require the current `issues.manage` permission. */
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
    requirePermission(fresh, 'issues.manage');
    if (fresh.actor.id !== context.actor.id) throw forbidden('Actor changed');

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
      const fresh = await authorized(context);
      const incident = deps.parseId(incidentId);
      const command = deps.parseStart(input);

      return deps.store.recordRun(fresh, incident, command, (sources) => {
        const conflict = learningSelectionConflict(incident, command, sources);
        if (conflict) throw new ServiceError(409, 'CONFLICT', conflict);
        const diagnosis = sources.diagnosis;

        return {
          ...command,
          schemaVersion: 1,
          incidentId: incident,
          actorId: fresh.actor.id,
          createdAt: sources.createdAt,
          context: {
            evidenceRefs: diagnosis.provenance.evidence.map((e) => e.id),
            mappingVersions: diagnosis.provenance.mappingVersions,
            configVersion: diagnosis.provenance.configVersion,
            ruleVersion: diagnosis.provenance.ruleVersion,
            diagnosisVersion: diagnosis.provenance.engineVersion,
            hypotheses: diagnosis.hypotheses,
            model: diagnosis.provenance.model,
          },
          generation: sources.generation,
          artifactDigest: sources.artifactDigest,
        };
      });
    },
    async append(
      context: TenantContext,
      incidentId: string,
      runId: string,
      input: unknown,
    ) {
      const fresh = await authorized(context);
      const incident = deps.parseId(incidentId);
      const run = deps.parseId(runId);
      const command = deps.parseEvent(input);

      return deps.store.recordEvent(
        fresh,
        incident,
        run,
        command,
        (sources) => {
          const conflict = learningEventConflict(command, sources);
          if (conflict) throw new ServiceError(409, 'CONFLICT', conflict);

          return {
            ...command,
            sequence: sources.sequence,
            actorId: fresh.actor.id,
            recordedAt: sources.recordedAt,
          };
        },
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

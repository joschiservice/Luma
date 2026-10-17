import { type TenantContext } from '@luma/identity';
import type { FeatureFlag } from '@luma/platform';
import { conflict, notFound } from '@luma/platform';
import type { LearningService } from '@luma/resolution';
import type {
  ImprovementDiscoveryGroup,
  ImprovementEvidence,
  WorkflowImprovementControls,
} from '@luma/workflows';

/**
 * Reads verified learning facts through their owner. Raw provider payloads, credentials and
 * operator notes never enter generation; incomplete, human-disposed and unsupported cases fail.
 */
export function createWorkflowImprovementSource(
  learning: Pick<LearningService, 'read'>,
  release: (tenantId: string, flag: FeatureFlag) => Promise<boolean>,
  discovery?: {
    discover(context: TenantContext): Promise<{
      asOf: string;
      windowDays: number;
      minimumIncidents: number;
      items: ImprovementDiscoveryGroup[];
    }>;
  },
  controls?: WorkflowImprovementControls,
) {
  return {
    ...(controls ? { controls } : {}),
    discoveryEnabled: (context: TenantContext) =>
      discovery
        ? release(context.tenantId, 'workflow-improvement-discovery')
        : Promise.resolve(false),
    ...(discovery
      ? { discover: (context: TenantContext) => discovery.discover(context) }
      : {}),
    enabled: (context: TenantContext) =>
      release(context.tenantId, 'workflow-improvements'),
    async evidence(
      context: TenantContext,
      source: { incidentId: string; runId: string },
    ): Promise<ImprovementEvidence> {
      const history = await learning.read(
        context,
        source.incidentId,
        source.runId,
      );
      const { incident, run } = history;
      const resolution = incident.resolution;
      if (
        incident.tenantId !== context.tenantId ||
        run.incidentId !== source.incidentId
      )
        throw notFound('Resolution evidence not found.');
      if (
        incident.state !== 'resolved' ||
        resolution?.kind !== 'verification' ||
        resolution.outcome !== 'passed' ||
        !resolution.authoritative ||
        !resolution.complete ||
        !resolution.evidenceRefs.length
      )
        throw conflict(
          'This operation needs an independently verified resolution before it can inform an improvement.',
        );
      if (
        incident.exceptionClass !== 'inventory_mismatch' &&
        incident.exceptionClass !== 'sync_failure'
      )
        throw conflict(
          'This recurring pattern is not supported for workflow improvements.',
        );
      const confirmed = history.events.some(
        (event) =>
          event.fact.kind === 'outcome' &&
          event.fact.result === 'verified' &&
          event.fact.complete &&
          event.fact.authoritative &&
          event.fact.evaluatorVersion === resolution.evaluatorVersion &&
          resolution.evidenceRefs.every(
            (ref) =>
              event.fact.kind === 'outcome' &&
              event.fact.evidenceRefs.includes(ref),
          ),
      );
      if (!confirmed)
        throw conflict(
          'This resolution run has no recorded outcome matching the independent verification.',
        );
      const repairs = history.events.flatMap((event) =>
        event.fact.kind === 'repair_step' && event.fact.result === 'accepted'
          ? [event.fact.actionCode]
          : [],
      );
      // Codes are structured identifiers. Reject legacy free text before building a model input.
      if (repairs.some((code) => !/^[a-zA-Z0-9_.:-]{1,100}$/.test(code)))
        throw conflict(
          'The retained repair facts need structured action codes.',
        );

      return {
        incidentId: incident.id,
        runId: run.id,
        pattern: incident.exceptionClass,
        subjectId: incident.subject.subjectId,
        evidenceRefs: [
          ...new Set([...run.context.evidenceRefs, ...resolution.evidenceRefs]),
        ],
        evaluatorVersion: resolution.evaluatorVersion,
        verifiedAt: resolution.at,
        artifactDigest: run.artifactDigest,
        repairCodes: [...new Set(repairs)],
        humanInterventions: history.events.filter(
          (event) =>
            event.fact.kind === 'intervention' ||
            event.fact.kind === 'human_edit',
        ).length,
      };
    },
  };
}

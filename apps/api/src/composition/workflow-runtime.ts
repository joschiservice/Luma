import type { WorkflowConfig } from '@luma/config';
import { Pool } from 'pg';

import type { Diagnosis, DiagnosisService } from '#modules/exceptions/index';
import type { BoundActionStep } from '#modules/execution/index';
import { createIdentity } from '#modules/identity/composition';
import type { IdentityService, TenantContext } from '#modules/identity/index';
import { createTenantDatabase } from '#modules/platform/composition';
import type { ProposedAction } from '#modules/policies/index';
import type { TemporalSettings } from '#modules/workflows/composition';
import {
  createExceptionActivities,
  createExceptionClient,
  createExceptionWorker,
} from '#modules/workflows/composition';
import type {
  DeskService,
  PlaybookService,
  PlaybookSnapshot,
  WorkflowBindings,
} from '#modules/workflows/index';

import {
  createDeskServices,
  createDetectionServices,
  createSafetyServices,
} from './services.js';

/** Wire durable activities to the same tenant-scoped services used by commands. */
export function createExceptionWorkflowRuntime(
  settings: TemporalSettings,
  identity: Pick<IdentityService, 'refreshContext' | 'resolveWorkflowContext'>,
  detection: Pick<
    ReturnType<typeof createDetectionServices>,
    'exceptions' | 'diagnoses'
  >,
  safety: Pick<
    ReturnType<typeof createSafetyServices>,
    'execution' | 'provisioning'
  >,
  bindings: WorkflowBindings,
  desk?: DeskService,
  artifactReference = { id: 'exception-resolution', version: '1' },
  playbook?: {
    service: PlaybookService;
    /** Resolves the grant for a new proposal, preserving any existing run binding. */
    activationId:
      | string
      | ((
          context: TenantContext,
          action: ProposedAction,
        ) => Promise<string | null>);
    snapshot(
      context: TenantContext,
      diagnosis: Diagnosis,
      action: ProposedAction,
    ): Promise<PlaybookSnapshot>;
  },
) {
  if (desk)
    bindings = {
      ...bindings,
      recordWorkflow: desk.bindWorkflow,
      currentProposal: async (context, id) => {
        const review = await desk.review(context, id);
        const p = review.proposal;

        return p
          ? {
              id: p.id,
              revision: p.diagnosisRevision,
              expiresAt: new Date(
                Math.min(
                  Date.parse(p.expiresAt),
                  Date.parse(p.preconditions.validUntil),
                ),
              ).toISOString(),
              refreshable: Boolean(review.refreshable),
            }
          : null;
      },
    };
  if (desk && bindings.proposals) {
    const proposals = bindings.proposals;
    bindings = {
      ...bindings,
      proposals: {
        prepare: async (context, diagnosis) => {
          const action = await proposals.prepare(context, diagnosis);
          if (action)
            await desk.publish(
              context,
              diagnosis.exceptionId,
              diagnosis.revision,
              action,
            );

          return action;
        },
        get: desk.proposal,
      },
    };
  }
  if (bindings.proposals) {
    const proposals = bindings.proposals;
    bindings = {
      ...bindings,
      proposals: {
        ...proposals,
        prepare: async (context, diagnosis) => {
          const action = await proposals.prepare(context, diagnosis);
          if (!action) return null;
          if (playbook) {
            const activationId =
              typeof playbook.activationId === 'string'
                ? playbook.activationId
                : await playbook.activationId(context, action);
            if (!activationId) return null;
            await playbook.service.bind(context, {
              activationId,
              incidentId: diagnosis.exceptionId,
              diagnosisRevision: diagnosis.revision,
              action,
              snapshot: await playbook.snapshot(context, diagnosis, action),
            });

            return action;
          }
          const artifact = await safety.provisioning.artifact(
            context,
            artifactReference.id,
            artifactReference.version,
          );
          if (!artifact?.active) return null;
          await safety.provisioning.bind(context, {
            runId: action.id,
            stepId: 'execute',
            tenantId: context.tenantId,
            principalId: context.actor.id,
            artifactId: artifact.id,
            artifactVersion: artifact.version,
            artifactDigest: artifact.digest,
            incidentId: diagnosis.exceptionId,
            diagnosisRevision: diagnosis.revision,
            action,
          });

          return action;
        },
      },
    };
  }
  const activities = createExceptionActivities({
    identity,
    ...detection,
    execution: safety.execution,
    ...(playbook ? { playbook: playbook.service } : {}),
    bindings,
  });

  if (desk) {
    const execute = activities.execute;
    activities.execute = async (input, exceptionId, proposal) => {
      const context = await identity.resolveWorkflowContext(
        input.userId,
        input.tenantId,
        input.requestId,
      );

      return desk.withExecution(context, exceptionId, () =>
        execute(input, exceptionId, proposal),
      );
    };
  }

  return {
    activities,
    createClient: () => createExceptionClient(settings, identity),
    createWorker: () => createExceptionWorker(settings, activities),
  };
}

/** Recheck the bound diagnosis and its evidence independently of workflow decisions. */
export function createAdmissionEligibility(
  diagnoses: Pick<DiagnosisService, 'get'>,
  maxEvidenceAgeMs = 5 * 60_000,
) {
  if (!Number.isFinite(maxEvidenceAgeMs) || maxEvidenceAgeMs <= 0)
    throw new Error('Evidence freshness window must be positive');

  return async (context: TenantContext, step: BoundActionStep) => {
    const diagnosis = await diagnoses.get(context, step.incidentId);
    const now = Date.now();

    return (
      !!diagnosis &&
      diagnosis.exceptionId === step.incidentId &&
      !diagnosis.superseded &&
      diagnosis.status === 'ready' &&
      diagnosis.revision === step.diagnosisRevision &&
      (diagnosis.provenance.validUntil === null ||
        Date.parse(diagnosis.provenance.validUntil) > now) &&
      Date.parse(step.action.preconditions.validUntil) > now &&
      step.action.preconditions.evidenceRefs.every((id) => {
        const evidence = diagnosis.provenance.evidence.find(
          (evidence) => evidence.id === id,
        );
        const observedAt = Date.parse(evidence?.observedAt ?? '');

        return observedAt <= now && observedAt + maxEvidenceAgeMs > now;
      })
    );
  };
}

/** Start a worker for persisted incidents and diagnoses. */
export async function createDefaultExceptionWorker(
  identitySettings: Parameters<typeof createIdentity>[0],
  settings: WorkflowConfig & { temporal: TemporalSettings },
) {
  const identity = createIdentity(identitySettings);
  const detection = createDetectionServices(settings.databaseUrl);
  const safety = createSafetyServices(
    settings.databaseUrl,
    identity.service,
    {
      resolve: async () => null,
    },
    { eligible: createAdmissionEligibility(detection.diagnoses) },
  );
  const deskPool = new Pool({ connectionString: settings.databaseUrl, max: 5 });
  const desk = createDeskServices(
    createTenantDatabase(deskPool),
    identity.service,
  );
  const closeServices = async () => {
    await Promise.all([
      identity.close(),
      detection.close(),
      safety.close(),
      deskPool.end(),
    ]);
  };
  try {
    const runtime = createExceptionWorkflowRuntime(
      settings.temporal,
      identity.service,
      detection,
      safety,
      {
        loadDetection: async () => null,
        proposals: {
          prepare: async (context, diagnosis) => {
            const review = await desk.review(context, diagnosis.exceptionId);
            if (review.proposal?.diagnosisRevision !== diagnosis.revision)
              return null;

            return (
              (await desk.proposal(context, review.proposal.id))?.action ?? null
            );
          },
          get: desk.proposal,
        },
      },
      desk,
    );
    const worker = await runtime.createWorker();

    return {
      run: worker.run,
      shutdown: worker.shutdown,
      close: async () => {
        try {
          await worker.close();
        } finally {
          await closeServices();
        }
      },
    };
  } catch (error) {
    await closeServices();
    throw error;
  }
}

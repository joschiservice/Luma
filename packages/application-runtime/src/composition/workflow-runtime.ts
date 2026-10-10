import { setTimeout as delay } from 'node:timers/promises';

import { createAppHost } from '@luma/app-catalog';
import type { ConnectionsConfig, WorkflowConfig } from '@luma/config';
import { createInstalledRuntime } from '@luma/connections/composition';
import type { Diagnosis } from '@luma/exceptions';
import type { IdentityService, TenantContext } from '@luma/identity';
import { createIdentity } from '@luma/identity/composition';
import { createTenantDatabase } from '@luma/platform/composition';
import type { ProposedAction } from '@luma/policies';
import type {
  DeskService,
  PlaybookService,
  PlaybookSnapshot,
  ShadowService,
  WorkflowBindings,
} from '@luma/resolution';
import { createExceptionActivities } from '@luma/resolution/composition';
import type { TemporalSettings } from '@luma/workflow-temporal';
import {
  createExceptionClient,
  createExceptionWorker,
  createProcessClient,
} from '@luma/workflow-temporal';
import { Pool } from 'pg';

import { createApplicationServices } from './application.js';
import { createStockRefreshService } from './detection-worker.js';
import { createReplenishmentWorker } from './replenishment-worker.js';
import { createResourceScope } from './resources.js';
import { createDetectionServices, createSafetyServices } from './services.js';

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
  shadow?: ShadowService,
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
    ...(shadow ? { shadow } : {}),
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

/**
 * Start a worker for persisted incidents, diagnoses and process workflows. With `connections`,
 * installed apps contribute their case workflows; without it, only Luma's own run.
 */
export async function createDefaultExceptionWorker(
  identitySettings: Parameters<typeof createIdentity>[0],
  settings: WorkflowConfig & { temporal: TemporalSettings },
  connections?: ConnectionsConfig,
  env?: Readonly<Record<string, string | undefined>>,
) {
  const resources = createResourceScope();
  try {
    const identity = createIdentity(identitySettings);
    resources.add(identity.close);
    const pool = new Pool({ connectionString: settings.databaseUrl, max: 10 });
    resources.add(() => pool.end());
    const processClient = await createProcessClient(
      {
        ...settings.temporal,
        taskQueue: `${settings.temporal.taskQueue}-procurement`,
      },
      identity.service,
    );
    resources.add(processClient.close);
    const database = createTenantDatabase(pool);
    // Owners reread stale stock right before they act; the reread needs the host's providers.
    let stockRefresh: ReturnType<typeof createStockRefreshService> | undefined;
    const refreshStock = async (context: TenantContext, positionId: string) =>
      stockRefresh?.refresh(context, positionId);
    const host = connections
      ? createAppHost(database, {
          ...connections,
          refreshContext: identity.service.refreshContext,
          refreshStock,
          ...(env ? { env } : {}),
        })
      : undefined;
    if (host) {
      stockRefresh = createStockRefreshService({
        database,
        capabilities: createInstalledRuntime({
          installations: host.connections,
          providers: host.registry.providers(),
          // Owners record the reads they use as evidence; telemetry has no sink here.
          record: async () => undefined,
          recordObservations: async () => undefined,
        }),
      });
      resources.add(stockRefresh.close);
    }
    const {
      detection,
      safety,
      desk,
      http,
      replenishment,
      codeProcesses,
      caseWorkflows,
    } = createApplicationServices({
      database,
      identity: identity.service,
      execution: { kind: 'enabled', effects: { resolve: async () => null } },
      replenishmentTransport: processClient,
      ...(host
        ? {
            workflowSources: host.registry.workflowSources(),
            providerCatalog: host.providerCatalog,
            refreshStock,
          }
        : {}),
    });
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
      undefined,
      undefined,
      http.shadow,
    );
    const worker = await runtime.createWorker();
    resources.add(worker.close);
    const procurementWorker = await createReplenishmentWorker(
      settings.temporal,
      replenishment,
      pool,
      identity.service,
      codeProcesses,
      caseWorkflows,
    );
    resources.add(procurementWorker.close);

    const stopSchedules = new AbortController();

    async function advanceSchedules() {
      while (!stopSchedules.signal.aborted) {
        try {
          await pool.query('SELECT advance_workflow_schedules()');
        } catch (error) {
          console.error(
            'Scheduled workflow starts could not be advanced; retrying.',
            error,
          );
        }
        await delay(1000, undefined, { signal: stopSchedules.signal }).catch(
          () => undefined,
        );
      }
    }

    return {
      run: async () => {
        const schedules = advanceSchedules();
        try {
          await Promise.all([worker.run(), procurementWorker.run()]);
        } finally {
          stopSchedules.abort();
          await schedules;
        }
      },
      shutdown: () => {
        stopSchedules.abort();
        worker.shutdown();
        procurementWorker.shutdown();
      },
      close: resources.close,
    };
  } catch (error) {
    await resources.close();
    throw error;
  }
}

export { createAdmissionEligibility } from './admission.js';

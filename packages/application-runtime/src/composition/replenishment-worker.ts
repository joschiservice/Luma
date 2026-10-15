import { setTimeout as delay } from 'node:timers/promises';

import type { AppDefinition } from '@luma/app-host';
import type { IdentityService } from '@luma/identity';
import { pausesBackgroundWork } from '@luma/identity';
import {
  createProcessWorker,
  type StockProtectionWorkflowInput,
  type TemporalSettings,
} from '@luma/workflow-temporal';
import type {
  CaseWorkflows,
  ProcessActivities,
  ProcessRun,
} from '@luma/workflows';
import type {
  createCodeProcesses,
  createCoordination,
} from '@luma/workflows/composition';
import type { Pool } from 'pg';

import type { createReplenishmentRuntime } from './replenishment.js';

/**
 * Runs durable process activities for replenishment, case workflows and computation workflows,
 * starts case runs for new cases, and recovers committed starts after API or worker restarts.
 */
export async function createReplenishmentWorker(
  settings: TemporalSettings,
  runtime: ReturnType<typeof createReplenishmentRuntime>,
  pool: Pool,
  identity: Pick<IdentityService, 'resolveWorkflowContext'>,
  codeProcesses?: ReturnType<typeof createCodeProcesses>,
  caseWorkflows?: CaseWorkflows,
  coordination?: ReturnType<typeof createCoordination>,
  stockProtection?: {
    services: NonNullable<AppDefinition['stockProtection']>[];
    start(
      context: import('@luma/identity').TenantContext,
      incidentId: string,
    ): Promise<void>;
  },
) {
  const select = (run: ProcessRun) =>
    run.definitionId === 'inventory-replenishment'
      ? runtime.activities
      : caseWorkflows?.owns(run.definitionId)
        ? caseWorkflows.activities
        : codeProcesses?.activities;
  const activities: ProcessActivities = {
    ...(coordination ? { coordinate: coordination.coordinate } : {}),
    read: (run, step) => select(run)!.read(run, step),
    decision: (run, step) => select(run)!.decision(run, step),
    action: (run, version, step, outputs) =>
      select(run)!.action(run, version, step, outputs),
    verify: (run, step, outputs) => select(run)!.verify(run, step, outputs),
    record: (run, output) => select(run)!.record(run, output),
    code: (run, version, step, outputs) =>
      select(run)!.code!(run, version, step, outputs),
  };
  const worker = await createProcessWorker(
    { ...settings, taskQueue: `${settings.taskQueue}-procurement` },
    activities,
    stockProtection
      ? {
          stockProtectionTick: async (input: StockProtectionWorkflowInput) => {
            const context = await identity.resolveWorkflowContext(
              input.userId,
              input.tenantId,
              'stock-protection',
            );
            if (context.dataRegion !== input.dataRegion)
              throw new Error('Stock protection region changed');
            const results = await Promise.all(
              stockProtection.services.map((service) =>
                service.tick(context, input.incidentId),
              ),
            );

            return {
              done: results.every((result) => result.done),
              moreWork: results.some((result) => result.moreWork),
            };
          },
        }
      : undefined,
  );
  const stop = new AbortController();

  async function poll() {
    while (!stop.signal.aborted) {
      try {
        const scopes = await pool.query<{
          tenant_id: string;
          principal_id: string;
        }>('SELECT * FROM replenishment_worker_scopes()');
        // A workspace or member suspended after discovery is skipped quietly; discovery omits it
        // next time.
        for (const scope of scopes.rows) {
          if (stop.signal.aborted) break;
          try {
            await runtime.tick(
              await identity.resolveWorkflowContext(
                scope.principal_id,
                scope.tenant_id,
                'replenishment-monitor',
              ),
            );
          } catch (error) {
            if (pausesBackgroundWork(error)) continue;
            console.error(
              'Replenishment check could not complete; retrying.',
              error,
            );
          }
        }
        if (stockProtection) {
          const scopes = await pool.query<{
            tenant_id: string;
            principal_id: string;
          }>('SELECT * FROM detection_worker_scopes()');
          for (const scope of scopes.rows) {
            try {
              const context = await identity.resolveWorkflowContext(
                scope.principal_id,
                scope.tenant_id,
                'stock-protection-discovery',
              );
              for (const service of stockProtection.services)
                for (const incident of await service.discover(context)) {
                  const principal = await identity.resolveWorkflowContext(
                    incident.principalId,
                    scope.tenant_id,
                    'stock-protection-start',
                  );
                  await stockProtection.start(principal, incident.id);
                }
            } catch (error) {
              if (!pausesBackgroundWork(error))
                console.error(
                  'Stock protection discovery is unavailable; retrying.',
                  error,
                );
            }
          }
        }
        if (caseWorkflows) {
          const caseScopes = await pool.query<{
            tenant_id: string;
            principal_id: string;
          }>('SELECT * FROM case_workflow_worker_scopes()');
          for (const scope of caseScopes.rows) {
            if (stop.signal.aborted) break;
            try {
              await caseWorkflows.tick(
                await identity.resolveWorkflowContext(
                  scope.principal_id,
                  scope.tenant_id,
                  'case-workflow-monitor',
                ),
              );
            } catch (error) {
              if (pausesBackgroundWork(error)) continue;
              console.error(
                'Case workflow starts could not complete; retrying.',
                error,
              );
            }
          }
        }
        if (codeProcesses) {
          const codeScopes = await pool.query<{
            tenant_id: string;
            principal_id: string;
            definition_id: string;
          }>('SELECT * FROM code_process_worker_scopes()');
          for (const scope of codeScopes.rows) {
            if (stop.signal.aborted) break;
            try {
              await codeProcesses.tick(
                await identity.resolveWorkflowContext(
                  scope.principal_id,
                  scope.tenant_id,
                  'code-process-monitor',
                ),
                scope.definition_id,
              );
            } catch (error) {
              if (pausesBackgroundWork(error)) continue;
              console.error(
                'Code workflow start could not complete; retrying.',
              );
            }
          }
        }
      } catch (error) {
        console.error('Replenishment monitor is unavailable; retrying.', error);
      }
      await delay(5000, undefined, { signal: stop.signal }).catch(
        () => undefined,
      );
    }
  }

  return {
    run: async () => {
      const polling = poll();
      try {
        await worker.run();
      } finally {
        stop.abort();
        await polling;
      }
    },
    shutdown: () => {
      stop.abort();
      worker.shutdown();
    },
    close: worker.close,
  };
}

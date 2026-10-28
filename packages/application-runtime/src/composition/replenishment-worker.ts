import { setTimeout as delay } from 'node:timers/promises';

import type { AppDefinition } from '@luma/app-host';
import { listDetectionScopes } from '@luma/exceptions/composition';
import type { IdentityService } from '@luma/identity';
import { pausesBackgroundWork } from '@luma/identity';
import { createFailureLog } from '@luma/platform';
import { listReplenishmentScopes } from '@luma/procurement/composition';
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
import {
  type createCodeProcesses,
  type createCoordination,
  listCaseWorkflowScopes,
  listCodeProcessScopes,
} from '@luma/workflows/composition';
import type { Pool } from 'pg';

import type { createReplenishmentRuntime } from './replenishment.js';

/**
 * Runs durable process activities for replenishment, case workflows and computation workflows,
 * starts case runs for new cases, and recovers committed starts after API or worker restarts.
 * Monitor failures go to `log`, which defaults to stderr with sanitized error details.
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
  log: (message: string, error?: unknown) => void = createFailureLog(),
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
        // A workspace or member suspended after discovery is skipped quietly; discovery omits it
        // next time.
        for (const scope of await listReplenishmentScopes(pool)) {
          if (stop.signal.aborted) break;
          try {
            await runtime.tick(
              await identity.resolveWorkflowContext(
                scope.principalId,
                scope.tenantId,
                'replenishment-monitor',
              ),
            );
          } catch (error) {
            if (pausesBackgroundWork(error)) continue;
            log('Replenishment check could not complete; retrying.', error);
          }
        }
        if (stockProtection) {
          for (const scope of await listDetectionScopes(pool)) {
            try {
              const context = await identity.resolveWorkflowContext(
                scope.principalId,
                scope.tenantId,
                'stock-protection-discovery',
              );
              for (const service of stockProtection.services)
                for (const incident of await service.discover(context)) {
                  const principal = await identity.resolveWorkflowContext(
                    incident.principalId,
                    scope.tenantId,
                    'stock-protection-start',
                  );
                  await stockProtection.start(principal, incident.id);
                }
            } catch (error) {
              if (!pausesBackgroundWork(error))
                log(
                  'Stock protection discovery is unavailable; retrying.',
                  error,
                );
            }
          }
        }
        if (caseWorkflows) {
          for (const scope of await listCaseWorkflowScopes(pool)) {
            if (stop.signal.aborted) break;
            try {
              await caseWorkflows.tick(
                await identity.resolveWorkflowContext(
                  scope.principalId,
                  scope.tenantId,
                  'case-workflow-monitor',
                ),
              );
            } catch (error) {
              if (pausesBackgroundWork(error)) continue;
              log('Case workflow starts could not complete; retrying.', error);
            }
          }
        }
        if (codeProcesses) {
          for (const scope of await listCodeProcessScopes(pool)) {
            if (stop.signal.aborted) break;
            try {
              await codeProcesses.tick(
                await identity.resolveWorkflowContext(
                  scope.principalId,
                  scope.tenantId,
                  'code-process-monitor',
                ),
                scope.definitionId,
              );
            } catch (error) {
              if (pausesBackgroundWork(error)) continue;
              log('Code workflow start could not complete; retrying.', error);
            }
          }
        }
      } catch (error) {
        log('Replenishment monitor is unavailable; retrying.', error);
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
    polling: worker.polling,
    shutdown: () => {
      stop.abort();
      worker.shutdown();
    },
    close: worker.close,
  };
}

import { setTimeout as delay } from 'node:timers/promises';

import type { IdentityService } from '@luma/identity';
import {
  createProcessWorker,
  type TemporalSettings,
} from '@luma/workflow-temporal';
import type {
  CaseWorkflows,
  ProcessActivities,
  ProcessRun,
} from '@luma/workflows';
import type { createCodeProcesses } from '@luma/workflows/composition';
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
) {
  const select = (run: ProcessRun) =>
    run.definitionId === 'inventory-replenishment'
      ? runtime.activities
      : caseWorkflows?.owns(run.definitionId)
        ? caseWorkflows.activities
        : codeProcesses?.activities;
  const activities: ProcessActivities = {
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
  );
  const stop = new AbortController();

  async function poll() {
    while (!stop.signal.aborted) {
      try {
        const scopes = await pool.query<{
          tenant_id: string;
          principal_id: string;
        }>('SELECT * FROM replenishment_worker_scopes()');
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
            console.error(
              'Replenishment check could not complete; retrying.',
              error,
            );
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
            } catch {
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

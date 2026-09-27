import { setTimeout as delay } from 'node:timers/promises';

import type { IdentityService } from '@luma/identity';
import {
  createProcessWorker,
  type TemporalSettings,
} from '@luma/workflow-temporal';
import type { Pool } from 'pg';

import type { createReplenishmentRuntime } from './replenishment.js';

/** Runs durable procurement activities and recovers committed starts after API or worker restarts. */
export async function createReplenishmentWorker(
  settings: TemporalSettings,
  runtime: ReturnType<typeof createReplenishmentRuntime>,
  pool: Pool,
  identity: Pick<IdentityService, 'resolveWorkflowContext'>,
) {
  const worker = await createProcessWorker(
    { ...settings, taskQueue: `${settings.taskQueue}-procurement` },
    runtime.activities,
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

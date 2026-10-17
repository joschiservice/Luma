import { setTimeout as delay } from 'node:timers/promises';

import { createAppHost } from '@luma/app-catalog';
import type { ConnectionsConfig } from '@luma/config';
import type { IdentityService } from '@luma/identity';
import { pausesBackgroundWork } from '@luma/identity';
import { listReturnWriteScopes } from '@luma/orders/composition';
import type { Observability, TenantDatabase } from '@luma/platform';
import { createFailureLog } from '@luma/platform';
import type { Pool } from 'pg';

import { createApplicationServices } from './application.js';
import { applicationOptionsFor } from './application-options.js';
import { createTenantFeatureRelease } from './feature-release.js';

/**
 * Follows return writes in the background: sends approved return creations, settlements and
 * exchange steps as their requester within the approval, records unsent ones as expired after
 * it, and settles uncertain ones by reading. Every step reauthorizes in tenant scope; discovery
 * returns routing identities only.
 */
export function createReturnFollowUpWorker(options: {
  database: TenantDatabase;
  pool: Pool;
  identity: IdentityService;
  connections: ConnectionsConfig;
  observability?: Observability;
  env?: Readonly<Record<string, string | undefined>>;
  intervalMs?: number;
  log?: (message: string, error?: unknown) => void;
}) {
  const host = createAppHost(options.database, {
    ...options.connections,
    refreshContext: options.identity.refreshContext,
    featureEnabled: createTenantFeatureRelease(options.observability),
    ...(options.env ? { env: options.env } : {}),
  });
  const { returnCases, returnActions, returnExchanges } =
    createApplicationServices({
      database: options.database,
      identity: options.identity,
      ...applicationOptionsFor(host, {
        ...(options.observability
          ? { observability: options.observability }
          : {}),
      }),
      execution: { kind: 'enabled', effects: { resolve: async () => null } },
    });
  const log = options.log ?? createFailureLog();
  const stop = new AbortController();

  /** Runs one pass over every requester with live return writes. */
  async function pass() {
    for (const scope of await listReturnWriteScopes(options.pool)) {
      if (stop.signal.aborted) return;
      let context;
      try {
        context = await options.identity.resolveWorkflowContext(
          scope.principalId,
          scope.tenantId,
          'return-follow-up',
        );
      } catch (error) {
        // Suspended between discovery and this check; discovery skips it from the next pass.
        if (!pausesBackgroundWork(error))
          log('Return follow-up failed for a workspace; retrying.', error);
        continue;
      }
      for (const owner of [returnCases, returnActions, returnExchanges])
        await owner
          .recover(context)
          .catch((error: unknown) =>
            pausesBackgroundWork(error)
              ? undefined
              : log(
                  'Return follow-up failed for a workspace; retrying.',
                  error,
                ),
          );
    }
  }

  return {
    close: host.close,
    pass,
    async run() {
      while (!stop.signal.aborted) {
        await pass().catch((error: unknown) =>
          log('Return follow-up is unavailable; retrying.', error),
        );
        await delay(options.intervalMs ?? 15_000, undefined, {
          signal: stop.signal,
        }).catch(() => undefined);
      }
    },
    shutdown: () => stop.abort(),
  };
}

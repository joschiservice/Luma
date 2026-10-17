import { setTimeout as delay } from 'node:timers/promises';

import { createAppHost } from '@luma/app-catalog';
import type { ConnectionsConfig } from '@luma/config';
import type { IdentityService } from '@luma/identity';
import { pausesBackgroundWork } from '@luma/identity';
import type { Observability, TenantDatabase } from '@luma/platform';
import { createFailureLog } from '@luma/platform';
import {
  listSubmissionScopes,
  purgeExpiredSupplierMessages,
} from '@luma/procurement/composition';
import type { Pool } from 'pg';

import { createApplicationServices } from './application.js';
import { applicationOptionsFor } from './application-options.js';
import { createTenantFeatureRelease } from './feature-release.js';

/**
 * Follows placed purchase orders in the background: dispatches approved submissions as their
 * requester, settles uncertain ones by reading, records new confirmations and receipts, and
 * removes supplier message text after its retention period. Every step reauthorizes in tenant
 * scope; discovery returns routing identities only.
 */
export function createSupplierFollowUpWorker(options: {
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
  // Supplier follow-up has no model gateway settings, so supplier messages aren't extracted here.
  const { commitments } = createApplicationServices({
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

  /** Runs one pass over every principal with live submissions. */
  async function pass() {
    try {
      await purgeExpiredSupplierMessages(options.pool);
    } catch (error) {
      log('Supplier message retention could not run; retrying.', error);
    }
    for (const scope of await listSubmissionScopes(options.pool)) {
      if (stop.signal.aborted) return;
      try {
        await commitments.tick(
          await options.identity.resolveWorkflowContext(
            scope.principalId,
            scope.tenantId,
            'supplier-follow-up',
          ),
        );
      } catch (error) {
        // Suspended between discovery and this check; discovery skips it from the next pass.
        if (pausesBackgroundWork(error)) continue;
        log('Supplier follow-up failed for a workspace; retrying.', error);
      }
    }
  }

  return {
    close: host.close,
    pass,
    async run() {
      while (!stop.signal.aborted) {
        await pass().catch((error: unknown) =>
          log('Supplier follow-up is unavailable; retrying.', error),
        );
        await delay(options.intervalMs ?? 15_000, undefined, {
          signal: stop.signal,
        }).catch(() => undefined);
      }
    },
    shutdown: () => stop.abort(),
  };
}

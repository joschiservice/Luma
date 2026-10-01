import { setTimeout as delay } from 'node:timers/promises';

import { createAppHost } from '@luma/app-catalog';
import type { ConnectionsConfig } from '@luma/config';
import { createInstalledPurchaseOrderRuntime } from '@luma/connections/composition';
import type { IdentityService } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
import type { Pool } from 'pg';

import { createApplicationServices } from './application.js';

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
  env?: Readonly<Record<string, string | undefined>>;
  intervalMs?: number;
  log?: (message: string, error?: unknown) => void;
}) {
  const host = createAppHost(options.database, {
    ...options.connections,
    refreshContext: options.identity.refreshContext,
    ...(options.env ? { env: options.env } : {}),
  });
  const { commitments } = createApplicationServices({
    database: options.database,
    identity: options.identity,
    execution: { kind: 'enabled', effects: { resolve: async () => null } },
    purchasing: {
      runtime: createInstalledPurchaseOrderRuntime({
        installations: host.connections,
        providers: host.registry.providers(),
        record: async () => undefined,
        recordObservations: async () => undefined,
      }),
      installations: host.connections,
    },
  });
  const log =
    options.log ??
    ((message: string, error?: unknown) =>
      console.error(message, error instanceof Error ? error.message : ''));
  const stop = new AbortController();

  /** Runs one pass over every principal with live submissions. */
  async function pass() {
    try {
      await options.pool.query(
        'SELECT purge_expired_procurement_communications(200)',
      );
    } catch (error) {
      log('Supplier message retention could not run; retrying.', error);
    }
    const scopes = (
      await options.pool.query<{ tenant_id: string; principal_id: string }>(
        'SELECT tenant_id,principal_id FROM procurement_submission_scopes()',
      )
    ).rows;
    for (const scope of scopes) {
      if (stop.signal.aborted) return;
      try {
        await commitments.tick(
          await options.identity.resolveWorkflowContext(
            scope.principal_id,
            scope.tenant_id,
            'supplier-follow-up',
          ),
        );
      } catch (error) {
        log('Supplier follow-up failed for a workspace; retrying.', error);
      }
    }
  }

  return {
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

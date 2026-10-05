import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { createAppHost } from '@luma/app-catalog';
import { createSyncRunner, createSyncService } from '@luma/commerce-sync';
import {
  createIdentityReader,
  createSyncStore,
} from '@luma/commerce-sync/composition';
import type { CommerceSyncConfig, ConnectionsConfig } from '@luma/config';
import type { ConnectionManagement } from '@luma/connections';
import {
  createInstalledRuntime,
  createReadChecks,
} from '@luma/connections/composition';
import { createCustomerProfiles } from '@luma/customers/composition';
import type { IdentityService } from '@luma/identity';
import { createIdentity } from '@luma/identity/composition';
import type { TenantDatabase } from '@luma/platform';
import { createTenantDatabase } from '@luma/platform/composition';
import { Pool } from 'pg';

import { createDetectionWorker } from './detection-worker.js';
import { createResourceScope } from './resources.js';
import { createCommerceServices } from './services.js';
import { createSupplierFollowUpWorker } from './supplier-follow-up.js';

const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');

/**
 * Composes the background runner that imports connected history and keeps it in sync. Use a
 * database login that inherits `luma_connectors`, `luma_orders`, `luma_inventory`,
 * `luma_customers` and `luma_commerce_sync`. Several runners may share a database; leases
 * keep each page with one runner.
 */
export function createCommerceSyncWorker(options: {
  database: TenantDatabase;
  identity: Pick<IdentityService, 'resolveWorkflowContext' | 'refreshContext'>;
  connections: ConnectionsConfig;
  env?: Readonly<Record<string, string | undefined>>;
  /** Tenants processed in parallel. */
  concurrency?: number;
  idleMs?: number;
  log?: (message: string, error?: unknown) => void;
}) {
  const host = createAppHost(options.database, {
    ...options.connections,
    refreshContext: options.identity.refreshContext,
    ...(options.env ? { env: options.env } : {}),
  });
  const commerce = createCommerceServices(options.database);
  const reader = createInstalledRuntime({
    installations: host.connections,
    providers: host.registry.providers(),
    // Capability telemetry has no production sink; sync outcomes are persisted as runs.
    record: async () => undefined,
    // The runner stores each page itself after the adapter returns it.
    recordObservations: async () => undefined,
  });
  const log =
    options.log ??
    ((message: string, error?: unknown) =>
      console.error(message, error instanceof Error ? error.message : ''));
  const runner = createSyncRunner({
    store: createSyncStore(options.database),
    reader,
    ingestion: commerce.ingestion,
    customers: createCustomerProfiles(options.database),
    recordRead: createReadChecks(options.database),
    resolveContext: options.identity.resolveWorkflowContext,
    digest,
    log,
  });
  const stop = new AbortController();
  const concurrency = options.concurrency ?? 4;

  async function pass() {
    const scopes = await runner.scopes();
    const queue = [...scopes];
    await Promise.all(
      Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        for (let tenant = queue.shift(); tenant; tenant = queue.shift()) {
          if (stop.signal.aborted) return;
          await runner
            .tick(tenant)
            .catch((error: unknown) =>
              log('Sync pass failed; retrying.', error),
            );
        }
      }),
    );

    return scopes.length;
  }

  return {
    runner,
    /** Runs passes until shutdown; idle passes wait briefly before checking again. */
    async run() {
      while (!stop.signal.aborted) {
        let busy = 0;
        try {
          busy = await pass();
        } catch (error) {
          log('Sync scheduling is unavailable; retrying.', error);
        }
        await delay(busy ? 250 : (options.idleMs ?? 2000), undefined, {
          signal: stop.signal,
        }).catch(() => undefined);
      }
    },
    shutdown: () => stop.abort(),
    close: commerce.close,
  };
}

/** Creates the operator sync service for the API process. */
export function createCommerceSyncService(
  database: TenantDatabase,
  identity: Pick<IdentityService, 'refreshContext'>,
  connections: Pick<ConnectionManagement, 'list'>,
) {
  return createSyncService({
    store: createSyncStore(database),
    connections,
    identities: createIdentityReader(database),
    refreshContext: identity.refreshContext,
  });
}

/**
 * Starts the commerce sync process: identity for resolving who each sync runs as, the
 * worker database pool, the runner loop, supplier follow-up and scheduled detection. Close it
 * after `run` resolves.
 */
export async function createDefaultCommerceSyncWorker(
  identitySettings: Parameters<typeof createIdentity>[0],
  settings: CommerceSyncConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const resources = createResourceScope();
  try {
    const identity = createIdentity(identitySettings);
    resources.add(identity.close);
    const pool = new Pool({
      connectionString: settings.databaseUrl,
      max: settings.concurrency * 2 + 2,
    });
    resources.add(() => pool.end());
    const worker = createCommerceSyncWorker({
      database: createTenantDatabase(pool),
      identity: identity.service,
      connections: settings.connections,
      env,
      concurrency: settings.concurrency,
    });
    resources.add(worker.close);
    const followUp = createSupplierFollowUpWorker({
      database: createTenantDatabase(pool),
      pool,
      identity: identity.service,
      connections: settings.connections,
      env,
    });

    const detection = createDetectionWorker({
      database: createTenantDatabase(pool),
      pool,
      identity: identity.service,
      connections: settings.connections,
      env,
    });
    resources.add(detection.close);

    return {
      run: async () => {
        await Promise.all([worker.run(), followUp.run(), detection.run()]);
      },
      shutdown: () => {
        worker.shutdown();
        followUp.shutdown();
        detection.shutdown();
      },
      close: resources.close,
    };
  } catch (error) {
    await resources.close();
    throw error;
  }
}

import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { createAppHost } from '@luma/app-catalog';
import type { ConnectionsConfig } from '@luma/config';
import type { CapabilityReader } from '@luma/connections';
import { createInstalledRuntime } from '@luma/connections/composition';
import type { Configuration } from '@luma/exceptions';
import { defaultConfiguration } from '@luma/exceptions';
import type { IdentityService } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
import { createFailureLog } from '@luma/platform';
import { createDetectionMonitor } from '@luma/resolution';
import { createDetectionSources } from '@luma/resolution/composition';
import type { Pool } from 'pg';

import { createCommerceServices, createDetectionServices } from './services.js';

type Detection = Pick<
  ReturnType<typeof createDetectionServices>,
  'exceptions' | 'diagnoses'
>;

/**
 * Composes scheduled detection over stored commerce state. `detection` is read on every call,
 * so it may be created after this monitor and receive the monitor's verifier.
 */
export function createScheduledDetection(options: {
  database: TenantDatabase;
  capabilities: Pick<CapabilityReader, 'read'>;
  category(provider: string): 'erp' | 'storefront' | null;
  detection(): Detection;
  configuration?: Configuration;
  log?: (message: string, error?: unknown) => void;
}) {
  const commerce = createCommerceServices(options.database);
  const sources = createDetectionSources(options.database);
  const exceptions = () => options.detection().exceptions;
  const monitor = createDetectionMonitor({
    sources,
    capabilities: options.capabilities,
    exceptions: {
      ingest: (...args) => exceptions().ingest(...args),
      list: (...args) => exceptions().list(...args),
      verify: (...args) => exceptions().verify(...args),
    },
    diagnose: (context, exceptionId) =>
      options.detection().diagnoses.run(context, exceptionId),
    // A fresh read is current when it became the source's projection of the linked position.
    project: async (context, observation, positionId) => {
      const outcome = await commerce.ingestion.ingest(
        context,
        `detection:${observation.id}`,
        { capability: 'inventory.read', observation },
      );

      return outcome.status === 'applied' && outcome.entityId === positionId;
    },
    category: options.category,
    configuration: options.configuration ?? defaultConfiguration,
    hash: (value) => createHash('sha256').update(value).digest('hex'),
    ...(options.log ? { log: options.log } : {}),
  });

  return { ...monitor, sources, close: commerce.close };
}

/**
 * Runs scheduled detection and verification for every workspace whose commerce sync runs, as
 * the person the sync runs as. Use the sync worker's database login; it must also inherit
 * `luma_exceptions`.
 */
export function createDetectionWorker(options: {
  database: TenantDatabase;
  pool: Pool;
  identity: Pick<IdentityService, 'resolveWorkflowContext' | 'refreshContext'>;
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
  const log = options.log ?? createFailureLog();
  const monitor = createScheduledDetection({
    database: options.database,
    capabilities: createInstalledRuntime({
      installations: host.connections,
      providers: host.registry.providers(),
      record: async () => undefined,
      recordObservations: async () => undefined,
    }),
    category: (provider) =>
      host.providerCatalog.get(provider)?.category ?? null,
    // Read when a pass runs, after the services below receive the monitor's verifier.
    detection: () => detection,
    log,
  });
  const detection = createDetectionServices(
    options.database,
    undefined,
    monitor.verifier,
  );
  const stop = new AbortController();

  /** Runs one pass over every workspace with an active sync. */
  async function pass() {
    const scopes = (
      await options.pool.query<{ tenant_id: string; principal_id: string }>(
        'SELECT tenant_id,principal_id FROM detection_worker_scopes()',
      )
    ).rows;
    for (const scope of scopes) {
      if (stop.signal.aborted) return;
      try {
        await monitor.tick(
          await options.identity.resolveWorkflowContext(
            scope.principal_id,
            scope.tenant_id,
            'detection-monitor',
          ),
        );
      } catch (error) {
        log('Detection failed for a workspace; retrying.', error);
      }
    }
  }

  return {
    pass,
    async run() {
      while (!stop.signal.aborted) {
        await pass().catch((error: unknown) =>
          log('Detection is unavailable; retrying.', error),
        );
        await delay(options.intervalMs ?? 60_000, undefined, {
          signal: stop.signal,
        }).catch(() => undefined);
      }
    },
    shutdown: () => stop.abort(),
    close: async () => {
      await monitor.close();
      await detection.close();
    },
  };
}

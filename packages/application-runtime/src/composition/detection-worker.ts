import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { createAppHost } from '@luma/app-catalog';
import type { ConnectionsConfig } from '@luma/config';
import type { CapabilityReader } from '@luma/connections';
import {
  createInstalledRuntime,
  createOrderReadChecks,
  createOrderSourceVisibility,
  createSourceAuthority,
} from '@luma/connections/composition';
import type { Configuration } from '@luma/exceptions';
import { defaultConfiguration } from '@luma/exceptions';
import type { IdentityService, TenantContext } from '@luma/identity';
import { pausesBackgroundWork } from '@luma/identity';
import { orderStateQueries } from '@luma/orders/composition';
import type { Observability, TenantDatabase } from '@luma/platform';
import { createFailureLog } from '@luma/platform';
import { createOrderQuantities } from '@luma/read-models/composition';
import {
  createDetectionMonitor,
  createOrderRefresh,
  createStockRefresh,
} from '@luma/resolution';
import { createDetectionSources } from '@luma/resolution/composition';
import type { Pool } from 'pg';

import { createActiveDiagnosisRereader } from './active-diagnosis.js';
import { createTenantFeatureRelease } from './feature-release.js';
import { createSalesReadSource, createSalesTenantRelease } from './sales.js';
import { createCommerceServices, createDetectionServices } from './services.js';

type Detection = Pick<
  ReturnType<typeof createDetectionServices>,
  'exceptions' | 'diagnoses'
>;

/**
 * Composes the stock reread owners use right before they act: stale sources of one position are
 * read through the installed capabilities and stored as their current report. Returns the
 * function owners receive; it never throws for an unreadable source.
 */
export function createStockRefreshService(options: {
  database: TenantDatabase;
  capabilities: Pick<CapabilityReader, 'read'>;
  log?: (message: string, error?: unknown) => void;
}) {
  const commerce = createCommerceServices(options.database);
  const refresh = createStockRefresh({
    sources: createDetectionSources(options.database),
    capabilities: options.capabilities,
    project: async (context, observation, positionId) => {
      const outcome = await commerce.ingestion.ingest(
        context,
        `refresh:${observation.id}`,
        { capability: 'inventory.read', observation },
      );

      return outcome.status === 'applied' && outcome.entityId === positionId;
    },
    ...(options.log ? { log: options.log } : {}),
  });

  return {
    refresh: (context: TenantContext, positionId: string) =>
      refresh.refresh(context, positionId).then(() => undefined),
    close: commerce.close,
  };
}

/**
 * Composes the order reread that detection and owners use before they judge an order: every
 * stale source of one canonical order is read through the installed capabilities' point reads
 * and stored as current. A source that can't be reread keeps its stored reads.
 */
export function createOrderRefreshService(options: {
  database: TenantDatabase;
  capabilities: Pick<CapabilityReader, 'read' | 'discover'>;
  log?: (message: string, error?: unknown) => void;
}) {
  const commerce = createCommerceServices(options.database);
  const refresh = createOrderRefresh({
    sources: createDetectionSources(options.database),
    capabilities: options.capabilities,
    recordRead: createOrderReadChecks(options.database),
    id: randomUUID,
    project: async (context, read) => {
      const outcome = await commerce.ingestion.ingest(
        context,
        `refresh:${read.observation.id}`,
        read,
      );

      return outcome.status === 'applied';
    },
    ...(options.log ? { log: options.log } : {}),
  });

  return {
    refresh: (context: TenantContext, orderId: string, maxAgeMs?: number) =>
      refresh.refresh(context, orderId, maxAgeMs),
    close: commerce.close,
  };
}

/**
 * Composes scheduled detection over stored commerce state. `detection` is read on every call,
 * so it may be created after this monitor and receive the monitor's verifier.
 */
export function createScheduledDetection(options: {
  database: TenantDatabase;
  capabilities: Pick<CapabilityReader, 'read' | 'discover'>;
  internalOrdersEnabled?: (tenantId: string) => Promise<boolean>;
  category(provider: string): 'erp' | 'storefront' | null;
  detection(): Detection;
  configuration?: Configuration;
  /** How long a hold may explain missing progress; see `createDetectionMonitor`. */
  holdOverdueSeconds?: number;
  log?: (message: string, error?: unknown) => void;
}) {
  const commerce = createCommerceServices(options.database);
  const sources = createDetectionSources(options.database);
  const exceptions = () => options.detection().exceptions;
  const authorityOf = (database: TenantDatabase) =>
    createSourceAuthority(
      database,
      options.category,
      async (context) => context,
      options.internalOrdersEnabled,
    );
  const authority = authorityOf(options.database);
  const orders = createOrderRefreshService({
    database: options.database,
    capabilities: options.capabilities,
    ...(options.log ? { log: options.log } : {}),
  });
  const quantities = createOrderQuantities(
    options.database,
    { state: orderStateQueries },
    authorityOf,
    createOrderSourceVisibility(
      options.database,
      options.internalOrdersEnabled ?? (async () => false),
    ),
  );
  const monitor = createDetectionMonitor({
    sources,
    orders: {
      ...quantities,
      refresh: (context, orderId, maxAgeMs) =>
        orders.refresh(context, orderId, maxAgeMs),
    },
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
    authority,
    configuration: options.configuration ?? defaultConfiguration,
    ...(options.holdOverdueSeconds
      ? { holdOverdueSeconds: options.holdOverdueSeconds }
      : {}),
    hash: (value) => createHash('sha256').update(value).digest('hex'),
    ...(options.log ? { log: options.log } : {}),
  });

  return {
    ...monitor,
    sources,
    authority,
    /** Rereads one order's stale sources; owners call it before judging the order. */
    refreshOrder: orders.refresh,
    close: async () => {
      await orders.close();
      await commerce.close();
    },
  };
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
  observability?: Observability;
  intervalMs?: number;
  log?: (message: string, error?: unknown) => void;
}) {
  const host = createAppHost(options.database, {
    ...options.connections,
    refreshContext: options.identity.refreshContext,
    featureEnabled: createTenantFeatureRelease(options.observability),
    ...(options.env ? { env: options.env } : {}),
  });
  const log = options.log ?? createFailureLog();
  const capabilities = createInstalledRuntime({
    internalSource: createSalesReadSource(
      options.database,
      options.observability,
    ),
    installations: host.connections,
    providers: host.registry.providers(),
    record: async () => undefined,
    recordObservations: async () => undefined,
  });
  const monitor = createScheduledDetection({
    internalOrdersEnabled: createSalesTenantRelease(options.observability),
    database: options.database,
    capabilities,
    category: (provider) =>
      provider === 'luma-erp'
        ? 'erp'
        : (host.providerCatalog.get(provider)?.category ?? null),
    // Read when a pass runs, after the services below receive the monitor's verifier.
    detection: () => detection,
    log,
  });
  const rereader = createActiveDiagnosisRereader({
    database: options.database,
    reader: capabilities,
    identity: options.identity,
    authority: monitor.authority,
    enabled: (tenantId) =>
      createTenantFeatureRelease(options.observability)(
        tenantId,
        'active-diagnosis',
      ),
  });
  const detection = createDetectionServices(
    options.database,
    undefined,
    monitor.verifier,
    { ...(rereader ? { rereader } : {}) },
    monitor.authority,
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
        // Suspended between discovery and this check; discovery skips it from the next pass.
        if (pausesBackgroundWork(error)) continue;
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

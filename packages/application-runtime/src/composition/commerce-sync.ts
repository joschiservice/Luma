import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { createAppHost } from '@luma/app-catalog';
import type { AppFactoryContext } from '@luma/app-host';
import { createAuditLog } from '@luma/audit/composition';
import {
  autoLinkEvidence,
  createAutoLinkRunner,
  createAutoLinkService,
  createSyncRunner,
  createSyncService,
} from '@luma/commerce-sync';
import {
  createAutoLinkStore,
  createIdentityReader,
  createSyncStore,
} from '@luma/commerce-sync/composition';
import {
  type CommerceSyncConfig,
  type ConnectionsConfig,
  type ModelGatewayConfig,
  readAuthProtectionConfig,
  type RegionConfig,
} from '@luma/config';
import type { ConnectionManagement } from '@luma/connections';
import {
  createInstalledRuntime,
  createOrderSourceVisibility,
  createReadChecks,
} from '@luma/connections/composition';
import { createCustomerProfiles } from '@luma/customers/composition';
import type { IdentityService } from '@luma/identity';
import { createWorkflowIdentity } from '@luma/identity/composition';
import type { Observability, TenantDatabase } from '@luma/platform';
import { createFailureLog } from '@luma/platform';
import {
  createDatabasePool,
  createModelGateway,
  createTenantDatabase,
  createValkeyStore,
} from '@luma/platform/composition';
import {
  createPurchasingTermsImporter,
  createSupplierTerms,
} from '@luma/procurement/composition';

import { assertCellRegion } from '../cell-region.js';
import { createDataRetentionWorker } from './data-retention.js';
import { createDetectionWorker } from './detection-worker.js';
import { createTenantFeatureRelease } from './feature-release.js';
import { createMailboxSyncWorker } from './mailbox-sync.js';
import { createResourceScope } from './resources.js';
import { createReturnFollowUpWorker } from './return-follow-up.js';
import { createSalesReadSource, createSalesTenantRelease } from './sales.js';
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
  /** Trusted synthetic provider transport; production callers omit it. */
  simulation?: AppFactoryContext['simulation'];
  /** Tenants processed in parallel. */
  concurrency?: number;
  workspaceConcurrency?: number;
  connectionConcurrency?: number;
  observability?: Observability;
  idleMs?: number;
  log?: (message: string, error?: unknown) => void;
}) {
  const host = createAppHost(options.database, {
    ...options.connections,
    refreshContext: options.identity.refreshContext,
    featureEnabled: createTenantFeatureRelease(options.observability),
    ...(options.simulation ? { simulation: options.simulation } : {}),
    ...(options.env ? { env: options.env } : {}),
  });
  const commerce = createCommerceServices(options.database);
  const reader = createInstalledRuntime({
    internalSource: createSalesReadSource(
      options.database,
      options.observability,
    ),
    installations: host.connections,
    providers: host.registry.providers(),
    // Capability telemetry has no production sink; sync outcomes are persisted as runs.
    record: async () => undefined,
    // The runner stores each page itself after the adapter returns it.
    recordObservations: async () => undefined,
  });
  const log = options.log ?? createFailureLog();
  const runner = createSyncRunner({
    automaticLinks: createAutoLinkRunner({
      store: createAutomaticLinkStore(options.database),
      resolveContext: options.identity.resolveWorkflowContext,
      log,
    }),
    store: createSyncStore(options.database),
    reader,
    ingestion: commerce.ingestion,
    recordPurchasingTerms: createPurchasingTermsImporter(
      options.database,
      createSupplierTerms(
        options.database,
        options.identity.refreshContext,
        createAuditLog,
        (context) =>
          createTenantFeatureRelease(options.observability)(
            context.tenantId,
            'supplier-purchasing-terms',
          ),
      ),
    ),
    customers: createCustomerProfiles(options.database),
    recordRead: createReadChecks(options.database),
    resolveContext: options.identity.resolveWorkflowContext,
    digest,
    workspaceConcurrency: options.workspaceConcurrency ?? 4,
    connectionConcurrency: options.connectionConcurrency ?? 2,
    log,
  });
  const stop = new AbortController();
  const concurrency = options.concurrency ?? 4;
  let progressAt = Date.now();

  async function pass() {
    progressAt = Date.now();
    const scopes = await runner.scopes();
    const queue = [...scopes];
    await Promise.all(
      Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        for (let tenant = queue.shift(); tenant; tenant = queue.shift()) {
          if (stop.signal.aborted) return;
          await runner
            .tick(tenant, undefined, stop.signal)
            .catch((error: unknown) =>
              log('Sync pass failed; retrying.', error),
            );
          progressAt = Date.now();
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
    /** When the loop last started a pass or finished a workspace's tick, in epoch milliseconds. */
    progressAt: () => progressAt,
    shutdown: () => stop.abort(),
    close: async () => {
      await commerce.close();
      await host.close();
    },
  };
}

/**
 * How long the sync loop may go without starting a pass or finishing a workspace's tick before
 * health reports it stalled. Idle passes repeat every 2 seconds and a tick starts pages for at
 * most 20 seconds, so a working loop reports progress far more often. The bound is two 5-minute
 * page leases: a page step that has run that long has already lost its lease to another runner,
 * and the loop cannot start its next pass until that step returns.
 */
export const syncStallMs = 10 * 60_000;

/** Reports whether the loop's last progress is older than {@link syncStallMs} at `now`. */
export function syncStalled(progressAt: number, now: number) {
  return now - progressAt > syncStallMs;
}

/** Creates the operator sync service for the API process. */
export function createCommerceSyncService(
  database: TenantDatabase,
  identity: Pick<IdentityService, 'refreshContext'>,
  connections: Pick<ConnectionManagement, 'list'>,
  observability?: Observability,
) {
  const hidden = createOrderSourceVisibility(
    database,
    createSalesTenantRelease(observability),
  );
  const fixed = createOrderSourceVisibility(database, async () => false);

  return createSyncService({
    sourcePolicy: async (context) => {
      const [hiddenSources, fixedSources] = await Promise.all([
        hidden(context),
        fixed(context),
      ]);

      return { hidden: hiddenSources, fixed: fixedSources };
    },
    automaticLinks: createAutoLinkService({
      store: createAutomaticLinkStore(database),
      refreshContext: identity.refreshContext,
    }),
    store: createSyncStore(database),
    connections,
    identities: createIdentityReader(database),
    refreshContext: identity.refreshContext,
  });
}

/**
 * Starts the commerce sync process: identity for resolving who each sync runs as, the
 * worker database pool, the runner loop, supplier follow-up, return follow-up, mailbox
 * reading, scheduled detection and data retention. Failures
 * are written to stderr and reported through `observability` when supplied. Close it after
 * `run` resolves. With `modelSettings` and `observability`, mailbox reading extracts facts from
 * documents and supplier messages through the configured regional routes.
 */
export async function createDefaultCommerceSyncWorker(
  cell: RegionConfig,
  settings: CommerceSyncConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
  observability?: Observability,
  modelSettings?: ModelGatewayConfig,
) {
  const resources = createResourceScope();
  const log = createFailureLog(observability);
  try {
    // Mailbox reading counts against the same tenant token budgets as the API, in the Valkey
    // that holds the API's request counters.
    const counters = readAuthProtectionConfig(env).rateLimit.store;
    const budgetStore = counters
      ? createValkeyStore(counters.url, counters.cluster)
      : undefined;
    if (budgetStore) resources.add(() => budgetStore.close());
    const model =
      modelSettings && observability
        ? {
            gateway: createModelGateway(modelSettings, observability, {
              ...(budgetStore ? { budgetStore } : {}),
            }),
            settings: modelSettings,
          }
        : undefined;
    // Members and workflow contexts are read with the worker login, never the API's.
    const identity = createWorkflowIdentity(
      { databaseUrl: settings.databaseUrl, ...cell },
      {
        onDatabaseError: (error) =>
          log('Sync identity database connection failed', error),
      },
    );
    resources.add(identity.close);
    const pool = createDatabasePool({
      connectionString: settings.databaseUrl,
      max: settings.concurrency * settings.workspaceConcurrency * 2 + 2,
      workload: 'background',
      onError: (error) => log('Sync database connection failed', error),
    });
    resources.add(() => pool.end());
    await assertCellRegion(pool, cell.region);
    const worker = createCommerceSyncWorker({
      database: createTenantDatabase(pool),
      identity: identity.service,
      connections: settings.connections,
      env,
      ...(observability ? { observability } : {}),
      concurrency: settings.concurrency,
      workspaceConcurrency: settings.workspaceConcurrency,
      connectionConcurrency: settings.connectionConcurrency,
      log,
    });
    resources.add(worker.close);
    const followUp = createSupplierFollowUpWorker({
      ...(observability ? { observability } : {}),
      database: createTenantDatabase(pool),
      pool,
      identity: identity.service,
      connections: settings.connections,
      env,
      log,
    });

    const mailboxes = createMailboxSyncWorker({
      ...(observability ? { observability } : {}),
      database: createTenantDatabase(pool),
      identity: identity.service,
      connections: settings.connections,
      env,
      retentionDays: settings.messaging.retentionDays,
      pollMs: settings.messaging.pollMs,
      ...(model ? { model } : {}),
      log,
    });

    const returnFollowUp = createReturnFollowUpWorker({
      ...(observability ? { observability } : {}),
      database: createTenantDatabase(pool),
      pool,
      identity: identity.service,
      connections: settings.connections,
      env,
      log,
    });

    resources.add(followUp.close);
    resources.add(mailboxes.close);
    resources.add(returnFollowUp.close);

    const detection = createDetectionWorker({
      ...(observability ? { observability } : {}),
      database: createTenantDatabase(pool),
      pool,
      identity: identity.service,
      connections: settings.connections,
      env,
      log,
    });
    resources.add(detection.close);
    const retention = createDataRetentionWorker({
      pool,
      closureRetentionDays: settings.closureRetentionDays,
      auditRetentionDays: settings.auditRetentionDays,
      log,
    });

    const loops = [
      worker,
      followUp,
      mailboxes,
      returnFollowUp,
      detection,
      retention,
    ];

    return {
      run: () => runLoops(loops),
      /** True when the commerce sync loop has made no progress within {@link syncStallMs}. */
      stalled: (now = Date.now()) => syncStalled(worker.progressAt(), now),
      shutdown: () => {
        for (const loop of loops) loop.shutdown();
      },
      close: resources.close,
    };
  } catch (error) {
    await resources.close();
    throw error;
  }
}

/**
 * Runs background loops until each resolves. When one loop rejects, every loop is told to shut
 * down and all are awaited before the first failure is rethrown, so resources are never closed
 * under a loop that is still running.
 */
export async function runLoops(
  loops: readonly { run(): Promise<void>; shutdown(): void }[],
) {
  const stopAll = () => {
    for (const loop of loops) loop.shutdown();
  };
  const results = await Promise.allSettled(
    loops.map((loop) =>
      loop.run().catch((error: unknown) => {
        stopAll();
        throw error;
      }),
    ),
  );
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
}

/** Wires automatic remapping to the commerce owner in the candidate transaction. */
export function createAutomaticLinkStore(database: TenantDatabase) {
  return createAutoLinkStore(database, (scoped, context, rule, candidate) => {
    const evidence = autoLinkEvidence(rule, candidate.key);

    return createCommerceServices(scoped).ingestion.link(
      context,
      rule.kind,
      candidate.targetId,
      candidate.sourceId,
      evidence.reason,
      evidence.method,
    );
  });
}

/** Composes the term owner and audit for product sync in workers and synthetic pilot runtimes. */
export function createPurchasingTermsRecorder(
  database: TenantDatabase,
  refreshContext: IdentityService['refreshContext'],
  released: Parameters<typeof createSupplierTerms>[3],
) {
  return createPurchasingTermsImporter(
    database,
    createSupplierTerms(database, refreshContext, createAuditLog, released),
  );
}

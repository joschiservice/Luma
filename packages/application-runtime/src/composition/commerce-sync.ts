import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { createAppHost } from '@luma/app-catalog';
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
import type {
  CommerceSyncConfig,
  ConnectionsConfig,
  ModelGatewayConfig,
} from '@luma/config';
import type { ConnectionManagement } from '@luma/connections';
import {
  createInstalledRuntime,
  createOrderSourceVisibility,
  createReadChecks,
} from '@luma/connections/composition';
import { createCustomerProfiles } from '@luma/customers/composition';
import type { IdentityService } from '@luma/identity';
import { createIdentity } from '@luma/identity/composition';
import type { Observability, TenantDatabase } from '@luma/platform';
import { createFailureLog } from '@luma/platform';
import {
  createModelGateway,
  createTenantDatabase,
} from '@luma/platform/composition';
import { Pool } from 'pg';

import { createDetectionWorker } from './detection-worker.js';
import { createTenantFeatureRelease } from './feature-release.js';
import { createMailboxSyncWorker } from './mailbox-sync.js';
import { createResourceScope } from './resources.js';
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
 * worker database pool, the runner loop, supplier follow-up, mailbox reading and scheduled
 * detection. Failures
 * are written to stderr and reported through `observability` when supplied. Close it after
 * `run` resolves. With `modelSettings` and `observability`, mailbox reading extracts facts from
 * documents and supplier messages through the configured EU routes.
 */
export async function createDefaultCommerceSyncWorker(
  identitySettings: Parameters<typeof createIdentity>[0],
  settings: CommerceSyncConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
  observability?: Observability,
  modelSettings?: ModelGatewayConfig,
) {
  const resources = createResourceScope();
  const log = createFailureLog(observability);
  try {
    const model =
      modelSettings && observability
        ? {
            gateway: createModelGateway(modelSettings, observability),
            settings: modelSettings,
          }
        : undefined;
    const identity = createIdentity(identitySettings);
    resources.add(identity.close);
    const pool = new Pool({
      connectionString: settings.databaseUrl,
      max: settings.concurrency * settings.workspaceConcurrency * 2 + 2,
    });
    resources.add(() => pool.end());
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
      database: createTenantDatabase(pool),
      pool,
      identity: identity.service,
      connections: settings.connections,
      env,
      log,
    });

    const mailboxes = createMailboxSyncWorker({
      database: createTenantDatabase(pool),
      identity: identity.service,
      connections: settings.connections,
      env,
      retentionDays: settings.messaging.retentionDays,
      pollMs: settings.messaging.pollMs,
      ...(model ? { model } : {}),
      log,
    });

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

    return {
      run: async () => {
        await Promise.all([
          worker.run(),
          followUp.run(),
          mailboxes.run(),
          detection.run(),
        ]);
      },
      shutdown: () => {
        worker.shutdown();
        followUp.shutdown();
        mailboxes.shutdown();
        detection.shutdown();
      },
      close: resources.close,
    };
  } catch (error) {
    await resources.close();
    throw error;
  }
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

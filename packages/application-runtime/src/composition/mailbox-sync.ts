import { setTimeout as delay } from 'node:timers/promises';

import { createAppHost } from '@luma/app-catalog';
import type { ConnectionsConfig, ModelGatewayConfig } from '@luma/config';
import { createInstalledMessageRuntime } from '@luma/connections/composition';
import type { IdentityService } from '@luma/identity';
import { purgeExpiredMessaging } from '@luma/messaging/composition';
import type { ModelGateway, TenantDatabase } from '@luma/platform';
import { createFailureLog } from '@luma/platform';

import { createApplicationServices } from './application.js';
import {
  documentExtractionAvailability,
  supplierExtractionAvailability,
} from './authoring.js';

/**
 * Reads connected mailboxes in the background and removes message text after its retention
 * period. Each due mailbox is read as its member, reauthorized on every pass; discovery returns
 * routing identities only. Inbound supplier messages on purchase-order threads go to
 * procurement through the same pass, which also sends approved replies as their requester and
 * checks unconfirmed sends by reading the thread.
 */
export function createMailboxSyncWorker(options: {
  database: TenantDatabase;
  identity: IdentityService;
  connections: ConnectionsConfig;
  env?: Readonly<Record<string, string | undefined>>;
  retentionDays?: number;
  pollMs?: number;
  /** Wait between passes when no mailbox was due; defaults to 5 seconds. */
  idleMs?: number;
  /**
   * Model routes for reading documents and supplier messages handed to procurement. Without
   * them, documents get table facts only and supplier messages are stored for people to read.
   */
  model?: { gateway: ModelGateway; settings: ModelGatewayConfig };
  log?: (message: string, error?: unknown) => void;
}) {
  const log = options.log ?? createFailureLog();
  const host = createAppHost(options.database, {
    ...options.connections,
    refreshContext: options.identity.refreshContext,
    ...(options.env ? { env: options.env } : {}),
  });
  // Messages are stored by messaging itself, never as commerce observations.
  const mailbox = createInstalledMessageRuntime({
    installations: host.connections,
    providers: host.registry.providers(),
    record: async () => undefined,
    recordObservations: async () => undefined,
  });
  const { messaging } = createApplicationServices({
    database: options.database,
    identity: options.identity,
    // Approved replies are sent and uncertain sends checked through Action Admission.
    execution: { kind: 'enabled', effects: { resolve: async () => null } },
    ...(options.model ? { modelGateway: options.model.gateway } : {}),
    supplierExtraction: supplierExtractionAvailability(
      options.model?.settings,
      !!options.model,
    ),
    documentExtraction: documentExtractionAvailability(
      options.model?.settings,
      !!options.model,
    ),
    messaging: {
      installations: host.connections,
      reader: mailbox,
      sender: mailbox,
      ...(options.retentionDays
        ? { retentionDays: options.retentionDays }
        : {}),
      ...(options.pollMs ? { pollMs: options.pollMs } : {}),
      log,
    },
  });
  const sync = messaging.sync!;
  const stop = new AbortController();

  /** Runs one pass over every member with due mailboxes; returns how many were due. */
  async function pass() {
    try {
      await purgeExpiredMessaging(options.database);
    } catch (error) {
      log('Message retention could not run; retrying.', error);
    }
    const scopes = await sync.scopes();
    for (const scope of scopes) {
      if (stop.signal.aborted) break;
      await sync
        .tick(scope)
        .catch((error: unknown) =>
          log('Reading a mailbox failed for a workspace; retrying.', error),
        );
    }

    return scopes.length;
  }

  return {
    close: host.close,
    pass,
    async run() {
      while (!stop.signal.aborted) {
        let busy = 0;
        try {
          busy = await pass();
        } catch (error) {
          log('Mailbox reading is unavailable; retrying.', error);
        }
        await delay(busy ? 1000 : (options.idleMs ?? 5000), undefined, {
          signal: stop.signal,
        }).catch(() => undefined);
      }
    },
    shutdown: () => stop.abort(),
  };
}

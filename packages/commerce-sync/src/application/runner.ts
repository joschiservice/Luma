import type { ProjectionOutcome } from '@luma/commerce-ingestion';
import { LinkError } from '@luma/commerce-ingestion';
import type {
  CapabilityReader,
  CapabilityResult,
  CommerceObservation,
  CustomerSnapshot,
  Observation,
  OrderSnapshot,
  ProductSnapshot,
  ReadCapability,
} from '@luma/connections';
import type { CustomerProfiles } from '@luma/customers';
import type { TenantContext } from '@luma/identity';
import { requirePermission, WorkspaceInactiveError } from '@luma/identity';
import { ServiceError } from '@luma/platform';

import {
  failureMessage,
  nextDueAt,
  planScan,
  recordCapabilities,
  type RecordType,
  recordTypes,
  retryDelayMs,
  syncPolicy,
  type SyncStream,
} from '../domain/streams.js';
import type { AutoLinkRunner } from './automatic-links.js';
import type {
  ItemKey,
  LedgerEntry,
  PageCounts,
  SyncConnection,
  SyncStore,
} from './ports.js';
import { itemKey } from './ports.js';

export interface SyncRunnerDependencies {
  store: SyncStore;
  automaticLinks?: AutoLinkRunner;
  reader: CapabilityReader;
  ingestion: {
    import(
      context: TenantContext,
      ingestKey: string,
      input: CommerceObservation,
    ): Promise<ProjectionOutcome>;
    /** Imports a page in one transaction; any failure rejects the whole batch. */
    importMany(
      context: TenantContext,
      items: { ingestKey: string; input: CommerceObservation }[],
    ): Promise<ProjectionOutcome[]>;
    link(
      context: TenantContext,
      kind: 'sku' | 'location' | 'order' | 'order_line',
      targetId: string,
      otherId: string,
      reason: string,
    ): Promise<unknown>;
    unlink(
      context: TenantContext,
      kind: 'sku' | 'location' | 'order' | 'order_line',
      entityId: string,
      connectionId: string,
      reason: string,
    ): Promise<unknown>;
  };
  /** Records purchasing metadata after canonical SKU mappings exist; exact retries are harmless. */
  recordPurchasingTerms?(
    context: TenantContext,
    observations: Observation<ProductSnapshot>[],
    complete: boolean,
  ): Promise<void>;
  customers: Pick<
    CustomerProfiles,
    'upsert' | 'recordOrders' | 'recordOrderAddresses' | 'remove'
  >;
  /** Records the read outcome for connection freshness. Customer records are never passed. */
  recordRead(
    context: TenantContext,
    connectionId: string,
    capability: ReadCapability,
    result: CapabilityResult<ReadCapability>,
  ): Promise<void>;
  /** Resolves a person's current workspace membership for background work. */
  resolveContext(
    principalId: string,
    tenantId: string,
    requestId: string,
  ): Promise<TenantContext>;
  digest(value: string): string;
  /** Records requested per page; defaults to the sync policy. */
  pageSize?: number;
  /** Maximum concurrent pages per workspace and per provider connection. */
  workspaceConcurrency?: number;
  connectionConcurrency?: number;
  now?: () => Date;
  id?: () => string;
  /** Receives operational failures without tenant data or provider payloads. */
  log?: (message: string, error?: unknown) => void;
}

const principalMessage =
  'The person this sync runs as no longer manages this workspace. Resume it to continue with your access.';

/**
 * Advances imports and syncs for one tenant at a time: creates streams for newly active
 * connections, applies change notifications, runs due pages within a time budget and
 * processes link requests. Every page is committed with its checkpoint, so a restart
 * continues from the last committed page.
 */
export function createSyncRunner(deps: SyncRunnerDependencies) {
  const now = deps.now ?? (() => new Date());
  const id = deps.id ?? (() => crypto.randomUUID());
  const log = deps.log ?? (() => undefined);

  async function prepare(tenantId: string) {
    const [connections, streams] = await Promise.all([
      deps.store.connections(tenantId),
      deps.store.streams(tenantId),
    ]);
    const block = new Map<string, SyncStream['blocked']>();
    for (const connection of connections) {
      const granted = grantedTypes(connection);
      const existing = streams.filter(
        (stream) => stream.connectionId === connection.id,
      );
      if (connection.status === 'active' && connection.installerId) {
        const missing = granted.filter(
          (type) => !existing.some((stream) => stream.recordType === type),
        );
        if (missing.length)
          await deps.store.createStreams(
            tenantId,
            connection.id,
            missing,
            connection.installerId,
          );
      }
      for (const stream of existing) {
        const wanted =
          connection.status !== 'active'
            ? 'connection_inactive'
            : !granted.includes(stream.recordType)
              ? 'capability_removed'
              : stream.blocked === 'principal_unavailable'
                ? 'principal_unavailable'
                : null;
        if (wanted !== stream.blocked) block.set(stream.id, wanted);
      }
    }
    for (const reason of new Set(block.values()))
      await deps.store.setBlocked(
        tenantId,
        [...block].filter(([, value]) => value === reason).map(([key]) => key),
        reason,
      );
  }

  async function context(
    stream: Pick<SyncStream, 'principalId' | 'id'>,
    tenantId: string,
  ) {
    const resolved = await deps.resolveContext(
      stream.principalId,
      tenantId,
      `commerce-sync:${stream.id}`,
    );
    requirePermission(resolved, 'sync.manage');

    return resolved;
  }

  async function importCustomer(
    tenant: TenantContext,
    observation: Observation<unknown>,
  ): Promise<RecordOutcome | null> {
    const data = observation.data as CustomerSnapshot;
    const result = await deps.customers.upsert(tenant, {
      connectionId: observation.source.connectionId,
      externalId: observation.source.externalId,
      displayName: data.displayName,
      email: data.email,
      phone: data.phone,
      address: data.address,
      state: data.state,
      sourceCreatedAt: data.createdAt,
      orderCount: data.orderCount,
      amountSpent: data.amountSpent,
      tags: data.tags,
      shared: data.shared,
      sourceUpdatedAt: observation.sourceUpdatedAt,
      observedAt: observation.observedAt,
      observationId: observation.id,
    });
    // Erased customers are not tracked; the next read skips them again.
    if (result === 'suppressed') return null;

    return { status: 'current', problem: null, entityId: null };
  }

  /**
   * Removes the profiles of customers that complete full reads have not found for the retention
   * period, leaving out customers on the current page. Returns their ledger keys, which the page
   * commit forgets; a page that fails to commit repeats the removal when it is retried. Up to
   * 1000 customers are removed per full read; the rest follow at the next one.
   */
  async function removeMissingCustomers(
    tenant: TenantContext,
    connectionId: string,
    seen: ItemKey[],
  ) {
    const page = new Set(seen.map(itemKey));
    const expired = (
      await deps.store.missingSince(
        tenant.tenantId,
        connectionId,
        'customers',
        new Date(+now() - syncPolicy.missingCustomerRetentionMs).toISOString(),
        1000,
      )
    ).filter((item) => !page.has(itemKey(item)));
    if (expired.length)
      await deps.customers.remove(
        tenant,
        connectionId,
        expired.map((item) => item.externalId),
      );

    return expired;
  }

  /**
   * Imports a page's changed records together. When one record breaks Luma's record rules,
   * the batch is rolled back and its records are imported one by one, so only that record fails.
   */
  async function importRecords(
    tenant: TenantContext,
    recordType: RecordType,
    observations: Observation<unknown>[],
  ): Promise<(RecordOutcome | null)[]> {
    if (!observations.length) return [];
    if (recordType === 'customers') {
      const outcomes: (RecordOutcome | null)[] = [];
      for (const observation of observations)
        outcomes.push(await isolate(() => importCustomer(tenant, observation)));

      return outcomes;
    }
    const item = (observation: Observation<unknown>) => ({
      ingestKey: `sync:${observation.id}`,
      input: {
        capability: recordCapabilities[recordType],
        observation:
          recordType === 'orders'
            ? withoutPersonalData(observation)
            : observation,
      } as CommerceObservation,
    });
    try {
      return (
        await retryConflict(() =>
          deps.ingestion.importMany(tenant, observations.map(item)),
        )
      ).map(recordOutcome);
    } catch (error) {
      if (!isRecordProblem(error)) throw error;
      if (observations.length === 1) return [rejected];
    }
    const outcomes: (RecordOutcome | null)[] = [];
    for (const observation of observations) {
      const { ingestKey, input } = item(observation);
      outcomes.push(
        await isolate(async () =>
          recordOutcome(
            await retryConflict(() =>
              deps.ingestion.import(tenant, ingestKey, input),
            ),
          ),
        ),
      );
    }

    return outcomes;
  }

  /** Runs one page of the next due stream; returns false when nothing was due. */
  async function runPage(tenantId: string) {
    const token = id();
    const claimed = await deps.store.claim(
      tenantId,
      token,
      syncPolicy.leaseMs,
      {
        connectionConcurrency: deps.connectionConcurrency ?? 2,
        workspaceConcurrency: deps.workspaceConcurrency ?? 4,
      },
    );
    if (!claimed) return false;
    const started = now();
    const fail = (
      code: string,
      options: {
        restart?: boolean;
        block?: SyncStream['blocked'];
        delayMs?: number;
        message?: string;
      } = {},
    ) =>
      deps.store.failPage(tenantId, claimed.id, token, {
        code,
        message: options.message ?? failureMessage(code),
        dueAt: new Date(
          +started + (options.delayMs ?? retryDelayMs(claimed.attempts + 1)),
        ).toISOString(),
        restart: options.restart ?? false,
        block: options.block ?? null,
      });
    let tenant: TenantContext;
    try {
      tenant = await context(claimed, tenantId);
    } catch (error) {
      // A suspended workspace pauses its sync without blocking the stream. The lease expires,
      // and discovery returns the workspace once it is active again.
      if (error instanceof WorkspaceInactiveError) return false;
      await fail('principal_unavailable', {
        block: 'principal_unavailable',
        message: principalMessage,
        delayMs: 0,
      });

      return true;
    }
    const capability = recordCapabilities[claimed.recordType];
    try {
      const descriptor = (
        await deps.reader.discover(tenant, claimed.connectionId)
      ).find((item) => item.capability === capability);
      // Grants are checked when streams are prepared; an unusable connection is retried.
      if (!descriptor) {
        await fail('unavailable');

        return true;
      }
      if (descriptor.filters?.includes('confirmMissing')) {
        const candidates = await deps.store.confirmationCandidates(
          tenantId,
          claimed.connectionId,
          claimed.recordType,
          10,
        );
        for (const candidate of candidates) {
          const confirmation = await deps.reader.read(tenant, {
            connectionId: claimed.connectionId,
            capability,
            version: '0',
            input: {
              limit: 1,
              confirmMissing: {
                externalId: candidate.externalId,
                scopeKey: candidate.scopeKey,
                createdAt: candidate.createdAt
                  ? new Date(candidate.createdAt).toISOString()
                  : null,
              },
            },
          });
          if (!confirmation.ok) {
            await fail(confirmation.error.code);

            return true;
          }
          if (
            confirmation.value.completeness !== 'complete' ||
            !confirmation.value.confirmation
          ) {
            await fail('invalid_response');

            return true;
          }
          if (confirmation.value.confirmation === 'deleted') {
            if (
              confirmation.value.items.length !== 1 ||
              confirmation.value.items[0]?.kind !== 'tombstone' ||
              itemKey(key(confirmation.value.items[0])) !== itemKey(candidate)
            ) {
              await fail('invalid_response');

              return true;
            }
            const outcomes = await importRecords(
              tenant,
              claimed.recordType,
              confirmation.value.items,
            );
            if (
              outcomes.some(
                (outcome) =>
                  !outcome || outcome.status !== 'current' || outcome.retained,
              )
            ) {
              await fail('invalid_response');

              return true;
            }
          }
          await deps.store.recordConfirmation(
            tenantId,
            claimed.connectionId,
            claimed.recordType,
            candidate,
            confirmation.value.confirmation,
          );
        }
      }
      const supportsSince =
        descriptor.filters?.includes('updatedSince') ?? false;
      let stream: SyncStream | null = claimed;
      const liveDue =
        (claimed.hintAt && Date.parse(claimed.hintAt) <= +started) ||
        (claimed.liveDueAt && Date.parse(claimed.liveDueAt) <= +started);
      if (
        supportsSince &&
        claimed.scan &&
        claimed.scan.kind !== 'incremental' &&
        !claimed.suspendedScan &&
        liveDue
      )
        stream = await deps.store.suspendScan(tenantId, claimed.id, token);
      if (!stream) return true;
      if (!stream.scan) {
        const plan = stream.suspendedScan
          ? {
              kind: 'incremental' as const,
              since: new Date(
                Date.parse(stream.watermark ?? stream.suspendedScan.startedAt) -
                  syncPolicy.overlapMs,
              ).toISOString(),
              trigger: claimed.hintAt
                ? ('webhook' as const)
                : ('schedule' as const),
            }
          : planScan(stream, started, supportsSince);
        if (
          plan.kind === 'backfill' &&
          !stream.recentHistoryCompletedAt &&
          ['orders', 'fulfillments', 'returns'].includes(stream.recordType) &&
          descriptor.filters?.includes('createdSince')
        )
          plan.createdSince =
            stream.recentHistoryFrom ??
            new Date(+started - syncPolicy.recentHistoryMs).toISOString();
        stream = await deps.store.startScan(tenantId, claimed.id, token, {
          id: id(),
          plan,
          fullScan: plan.since === null && !plan.createdSince,
          now: started.toISOString(),
          liveEnabled: supportsSince,
        });
        if (!stream?.scan) return true;
      }
      const scan = stream.scan!;
      const result = await deps.reader.read(tenant, {
        readPurpose: scan.kind === 'incremental' ? 'incremental' : 'history',
        connectionId: claimed.connectionId,
        capability,
        version: '0',
        input: {
          limit: deps.pageSize ?? syncPolicy.pageSize,
          ...(scan.cursor ? { cursor: scan.cursor } : {}),
          ...(scan.since ? { updatedSince: scan.since } : {}),
          ...(scan.createdSince ? { createdSince: scan.createdSince } : {}),
          ...(scan.kind === 'backfill' &&
          !scan.createdSince &&
          descriptor.filters?.includes('historyImport')
            ? { historyImport: { key: scan.id, chunkSize: 500 } }
            : {}),
        },
      });
      if (!result.ok && result.error.providerCode === 'ADMISSION_DEFERRED') {
        await deps.store.commitPage(tenantId, claimed.id, token, {
          entries: [],
          unchanged: [],
          counts: {
            records: 0,
            changed: 0,
            unchanged: 0,
            pending: 0,
            failed: 0,
          },
          nextCursor: scan.cursor,
          total: null,
          history: undefined,
          complete: null,
          now: now().toISOString(),
          deferred: true,
          deferReason: 'admission',
          admissionWaitReason:
            result.error.code === 'unavailable'
              ? 'admission_unavailable'
              : 'request_capacity',
          dueAt: new Date(
            +now() + Math.max(50, result.error.retryAfterMs ?? 1000),
          ).toISOString(),
        });

        return true;
      }
      if (!result.ok || !result.value.deferred)
        await deps
          .recordRead(
            tenant,
            claimed.connectionId,
            capability,
            redact(capability, result),
          )
          .catch((error: unknown) =>
            log('Sync read check was not recorded', error),
          );
      if (!result.ok) {
        if (result.error.code === 'rate_limited')
          await deps.store.deferConnection(
            tenantId,
            claimed.connectionId,
            new Date(
              +now() +
                retryDelayMs(claimed.attempts + 1, result.error.retryAfterMs),
            ).toISOString(),
          );
        const restart = result.error.code === 'invalid_input' && !!scan.cursor;
        await fail(result.error.code, {
          restart,
          delayMs: restart
            ? 0
            : retryDelayMs(claimed.attempts + 1, result.error.retryAfterMs),
        });

        return true;
      }
      const page = result.value;
      if (page.completeness !== 'complete') {
        // Returned purchasing evidence remains useful, but an incomplete scan never establishes absence.
        if (claimed.recordType === 'products' && deps.recordPurchasingTerms)
          await deps.recordPurchasingTerms(
            tenant,
            page.items as Observation<ProductSnapshot>[],
            false,
          );
        await fail('invalid_response');

        return true;
      }
      if (page.retryAfterMs && !page.deferred)
        await deps.store.deferConnection(
          tenantId,
          claimed.connectionId,
          new Date(+now() + page.retryAfterMs).toISOString(),
        );
      const keys = page.items.map(key);
      const known = await deps.store.ledger(
        tenantId,
        claimed.connectionId,
        claimed.recordType,
        keys,
      );
      const counts: PageCounts = {
        records: page.items.length,
        changed: 0,
        unchanged: 0,
        pending: 0,
        failed: 0,
      };
      const entries: LedgerEntry[] = [];
      const unchanged: ItemKey[] = [];
      const changed: { observation: Observation<unknown>; digest: string }[] =
        [];
      for (const observation of page.items as Observation<unknown>[]) {
        const item = key(observation);
        const digest = deps.digest(
          JSON.stringify([
            observation.kind,
            observation.sourceUpdatedAt,
            observation.sourceRevision,
            observation.data,
          ]),
        );
        const prior = known.get(itemKey(item));
        if (prior?.digest === digest && prior.status === 'current') {
          unchanged.push(item);
          counts.unchanged += 1;
          continue;
        }
        changed.push({ observation, digest });
      }
      const outcomes = await importRecords(
        tenant,
        claimed.recordType,
        changed.map((item) => item.observation),
      );
      if (claimed.recordType === 'products' && deps.recordPurchasingTerms) {
        await deps.recordPurchasingTerms(
          tenant,
          page.items as Observation<ProductSnapshot>[],
          page.completeness === 'complete',
        );
      }
      if (claimed.recordType === 'orders') {
        await deps.customers.recordOrders(
          tenant,
          claimed.connectionId,
          changed.flatMap(({ observation }) => customerOrder(observation)),
        );
        await deps.customers.recordOrderAddresses(
          tenant,
          claimed.connectionId,
          changed.flatMap(({ observation }) => orderAddresses(observation)),
        );
      }
      const forget =
        claimed.recordType === 'customers' &&
        !page.nextCursor &&
        !page.deferred &&
        !scan.since &&
        !scan.createdSince
          ? await removeMissingCustomers(tenant, claimed.connectionId, keys)
          : [];
      for (const [index, { observation, digest }] of changed.entries()) {
        const outcome = outcomes[index];
        if (!outcome) {
          counts.unchanged += 1;
          continue;
        }
        counts[
          outcome.status === 'current'
            ? 'changed'
            : outcome.status === 'pending'
              ? 'pending'
              : 'failed'
        ] += 1;
        entries.push({
          ...key(observation),
          ...outcome,
          digest,
          sourceCreatedAt: createdAt(claimed.recordType, observation),
          sourceUpdatedAt: observation.sourceUpdatedAt,
        });
      }
      await deps.store.commitPage(tenantId, claimed.id, token, {
        entries,
        unchanged,
        counts,
        nextCursor: page.nextCursor,
        total: page.total ?? null,
        history: page.history,
        complete: page.nextCursor
          ? null
          : { nextDueAt: nextDueAt(now(), supportsSince) },
        now: now().toISOString(),
        forget,
        ...(page.deferred
          ? {
              deferred: true,
              dueAt: new Date(
                +now() + (page.retryAfterMs ?? 2000),
              ).toISOString(),
            }
          : {}),
      });
    } catch (error) {
      log('Sync page failed', error);
      await fail(
        error instanceof ServiceError ? 'principal_unavailable' : 'internal',
        {
          ...(error instanceof ServiceError
            ? {
                block: 'principal_unavailable',
                message: principalMessage,
                delayMs: 0,
              }
            : {}),
        },
      ).catch((cause: unknown) => log('Sync failure was not recorded', cause));
    }

    return true;
  }

  async function processLinks(tenantId: string) {
    for (;;) {
      const request = await deps.store.claimLink(tenantId, 60_000);
      if (!request) return;
      try {
        const tenant = await context(
          { principalId: request.requestedBy, id: request.id },
          tenantId,
        );
        if (request.operation === 'link')
          await deps.ingestion.link(
            tenant,
            request.kind,
            request.entityId,
            request.otherId!,
            request.reason,
          );
        else
          await deps.ingestion.unlink(
            tenant,
            request.kind,
            request.entityId,
            request.connectionId!,
            request.reason,
          );
        await deps.store.finishLink(tenantId, request.id, {
          state: 'completed',
          message: null,
        });
      } catch (error) {
        // A suspended workspace keeps the request; it runs once the workspace is active again.
        if (error instanceof WorkspaceInactiveError) {
          await deps.store.finishLink(tenantId, request.id, {
            state: 'requested',
            message: null,
          });

          return;
        }
        const expected =
          error instanceof LinkError || error instanceof ServiceError;
        if (!expected) log('Link request failed', error);
        await deps.store.finishLink(tenantId, request.id, {
          state: 'failed',
          message:
            error instanceof LinkError
              ? error.message
              : error instanceof ServiceError
                ? 'You no longer have permission to link records in this workspace.'
                : 'Luma could not apply this change. No records were merged or split; try again.',
        });
      }
    }
  }

  return {
    /** Tenants that currently have sync work. */
    scopes: async () => {
      const [sync, automatic] = await Promise.all([
        deps.store.scopes(),
        deps.automaticLinks?.scopes() ?? [],
      ]);

      return [...new Set([...sync, ...automatic])];
    },
    /** Advances one tenant for up to `budgetMs` of page work; cancellation stops new pages after the current page. */
    async tick(tenantId: string, budgetMs = 20_000, signal?: AbortSignal) {
      const deadline = Date.now() + budgetMs;
      await prepare(tenantId);
      await deps.store.applyHints(tenantId, syncPolicy.hintDelayMs);
      await processLinks(tenantId);
      await Promise.all(
        Array.from({ length: deps.workspaceConcurrency ?? 4 }, async () => {
          while (
            !signal?.aborted &&
            Date.now() < deadline &&
            (await runPage(tenantId))
          );
        }),
      );
      await deps.automaticLinks?.tick(tenantId);
    },
  };
}

type RecordOutcome = Pick<LedgerEntry, 'status' | 'problem' | 'entityId'> & {
  retained?: boolean;
};

const rejected: RecordOutcome = {
  status: 'failed',
  problem: 'The source record does not match Luma’s record rules',
  entityId: null,
};

function recordOutcome(outcome: ProjectionOutcome): RecordOutcome {
  if (outcome.status === 'pending')
    return {
      status: 'pending',
      problem: outcome.missing.some((source) => source.resource === 'order')
        ? 'Waiting for its order to be imported'
        : 'Waiting for related records to be imported',
      entityId: null,
    };

  return {
    status: 'current',
    problem: null,
    entityId: outcome.entityId,
    retained: outcome.status === 'retained',
  };
}

/** Runs one record's import; a record-rule failure marks only that record as failed. */
async function isolate(
  work: () => Promise<RecordOutcome | null>,
): Promise<RecordOutcome | null> {
  try {
    return await work();
  } catch (error) {
    if (!isRecordProblem(error)) throw error;

    return rejected;
  }
}

/**
 * Concurrent imports take entity locks in sorted order, but PostgreSQL may still resolve a rare
 * lock cycle by cancelling one transaction. The batch rolled back, so it is retried once.
 */
async function retryConflict<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const code =
      error instanceof Error && 'code' in error ? error.code : undefined;
    if (code !== '40P01' && code !== '40001') throw error;

    return work();
  }
}

/** The order's customer reference as a customer-store link; none when the read omits it. */
function customerOrder(observation: Observation<unknown>) {
  const customer = (observation.data as Partial<OrderSnapshot>).customer;
  if (customer === undefined) return [];

  return [
    {
      order: {
        externalId: observation.source.externalId,
        scopeKey: observation.source.scopeKey,
      },
      customerExternalId: customer?.externalId ?? null,
      placedAt: (observation.data as Partial<OrderSnapshot>).placedAt ?? null,
      observedAt: observation.observedAt,
    },
  ];
}

/** The order's addresses as a customer-store record; none when the read omits them. */
function orderAddresses(observation: Observation<unknown>) {
  const data = observation.data as Partial<OrderSnapshot>;
  if (data.addresses === undefined) return [];

  return [
    {
      order: {
        externalId: observation.source.externalId,
        scopeKey: observation.source.scopeKey,
      },
      ...(data.customer === undefined
        ? {}
        : { customerExternalId: data.customer?.externalId ?? null }),
      shared: data.addresses.shared,
      shipping: data.addresses.shared ? data.addresses.shipping : null,
      billing: data.addresses.shared ? data.addresses.billing : null,
      observedAt: observation.observedAt,
    },
  ];
}

// Customer references and addresses are erasable personal data; order observations are
// retained evidence.
function withoutPersonalData(observation: Observation<unknown>) {
  const data = observation.data as Partial<OrderSnapshot>;
  if (data.customer === undefined && data.addresses === undefined)
    return observation;
  const retained = { ...data };
  delete retained.customer;
  delete retained.addresses;

  return { ...observation, data: retained };
}

function grantedTypes(connection: SyncConnection): RecordType[] {
  return recordTypes.filter((type) =>
    connection.granted.includes(recordCapabilities[type]),
  );
}

function key(observation: Observation<unknown>): ItemKey {
  return {
    resource: observation.source.resource,
    scopeKey: observation.source.scopeKey,
    externalId: observation.source.externalId,
  };
}

function createdAt(recordType: RecordType, observation: Observation<unknown>) {
  const data = observation.data as {
    placedAt?: unknown;
    createdAt?: unknown;
    requestedAt?: unknown;
  };
  const value =
    recordType === 'orders'
      ? data.placedAt
      : recordType === 'customers' ||
          recordType === 'inventory_transfers' ||
          recordType === 'inventory_shipments'
        ? data.createdAt
        : recordType === 'returns'
          ? (data.requestedAt ?? data.createdAt)
          : null;

  return typeof value === 'string' ? value : null;
}

// Record read checks keep page outcomes for freshness. Product pages keep their items,
// which name mapped SKUs; other pages are already stored as observations, and customer
// pages must not be retained outside the erasable profile store.
function redact(
  capability: ReadCapability,
  result: CapabilityResult<ReadCapability>,
): CapabilityResult<ReadCapability> {
  if (
    !result.ok ||
    capability === 'products.read' ||
    !('items' in result.value)
  )
    return result;

  return {
    ok: true,
    value: {
      items: [],
      nextCursor: result.value.nextCursor,
      completeness: result.value.completeness,
    },
  };
}

/**
 * Validation failures belong to one source record and must not stop the page; database,
 * permission and provider failures fail the page so it is retried from its checkpoint.
 */
function isRecordProblem(error: unknown) {
  return (
    error instanceof Error &&
    !(error instanceof ServiceError) &&
    // The connection changed state during the page; retry the page instead.
    error.message !== 'Connection unavailable' &&
    (error.name === 'ZodError' ||
      (error.constructor === Error && !('code' in error)))
  );
}

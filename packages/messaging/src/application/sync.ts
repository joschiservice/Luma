import type { TenantContext } from '@luma/identity';
import {
  hasPermission,
  IdentityError,
  pausesBackgroundWork,
} from '@luma/identity';

import type { Mailbox, MailboxCursor, ScanCursor } from '../domain/mailbox.js';
import {
  backoffMs,
  blockingFailure,
  mailboxFilter,
  planScan,
} from '../domain/mailbox.js';
import type { Ingest } from './ingest.js';
import type {
  MailboxConnection,
  MailboxConnections,
  MessageReader,
} from './ports.js';
import type { MessagingStore, MessagingTransaction } from './store.js';

/** Work that runs for a workspace after its mailboxes, such as reading documents. */
export type BackgroundPass = (context: TenantContext) => Promise<void>;

export interface SyncDependencies {
  store: MessagingStore;
  connections: MailboxConnections;
  reader: MessageReader;
  ingest: Ingest;
  /** Reauthorizes the member a mailbox is read as. */
  resolveContext(
    userId: string,
    tenantId: string,
    requestId: string,
  ): Promise<TenantContext>;
  now(): Date;
  id(): string;
  log(message: string, error?: unknown): void;
  /** Time between reads of a current mailbox; defaults to two minutes. */
  pollMs?: number;
  /** Pages read per mailbox before yielding to other mailboxes; defaults to 10. */
  maxPages?: number;
  /** Runs after mailboxes for each workspace pass. */
  passes?: BackgroundPass[];
}

const leaseMs = 5 * 60_000;
const pageSize = 50;
const mailboxesPerPass = 10;

/**
 * Reads connected mailboxes in the background. Each mailbox is leased while one runner reads
 * it; every pass reauthorizes the member it is read as. Coverage advances only after a
 * complete scan, so a restart resumes from the stored provider cursor.
 */
export function createMailboxSync(deps: SyncDependencies) {
  const pollMs = deps.pollMs ?? 120_000;
  const maxPages = deps.maxPages ?? 10;

  /** Releases a leased mailbox with changes, unless another runner took it over. */
  async function release(
    tenantId: string,
    connectionId: string,
    token: string,
    change: (
      mailbox: Mailbox,
      tx: MessagingTransaction,
    ) => Promise<Mailbox> | Mailbox,
    keepLease = false,
  ) {
    return deps.store.transaction(tenantId, async (tx) => {
      const current = await tx.mailboxes.leased(connectionId, token);
      if (!current) return false;
      const next = await change(current, tx);
      await tx.mailboxes.update({
        ...next,
        ...(keepLease
          ? {
              leaseUntil: new Date(
                deps.now().getTime() + leaseMs,
              ).toISOString(),
            }
          : { leaseToken: null, leaseUntil: null }),
        updatedAt: deps.now().toISOString(),
      });

      return true;
    });
  }

  const later = (ms: number) =>
    new Date(deps.now().getTime() + ms).toISOString();

  async function fail(
    context: TenantContext,
    mailbox: Mailbox,
    token: string,
    connection: MailboxConnection,
    scan: ScanCursor,
    failure: { code: string; retryAfterMs?: number | undefined },
  ) {
    const blocked = blockingFailure(failure.code);
    await release(context.tenantId, mailbox.connectionId, token, (current) => {
      const attempts = current.attempts + 1;
      // A rejected provider cursor restarts the scan instead of failing forever.
      const restart = failure.code === 'invalid_input' && !!scan.page;
      const cursor: MailboxCursor = { ...current.cursor };
      if (restart) delete cursor.scan;
      else cursor.scan = scan;
      if (blocked) cursor.blockedVersion = connection.version;

      return {
        ...current,
        cursor,
        attempts,
        lastError: failure.code.slice(0, 100),
        blocked,
        dueAt: later(backoffMs(attempts, failure.retryAfterMs)),
      };
    });
  }

  /** Reads one leased mailbox for at most `maxPages` pages. */
  async function read(
    context: TenantContext,
    mailbox: Mailbox,
    token: string,
    connection: MailboxConnection | undefined,
  ) {
    const tenantId = context.tenantId;
    if (!connection || connection.status !== 'active' || !connection.canRead) {
      // Mailbox state shows the connection problem; reading resumes when it is active again.
      await release(tenantId, mailbox.connectionId, token, (current) => ({
        ...current,
        hintAt: null,
        dueAt: later(pollMs),
      }));

      return;
    }
    const rules = await deps.store.transaction(tenantId, (tx) =>
      tx.rules.active(mailbox.connectionId),
    );
    let scan = planScan(mailbox, rules, deps.now());
    if (!scan) {
      await release(tenantId, mailbox.connectionId, token, (current) => {
        const cursor = { ...current.cursor };
        delete cursor.scan;

        return { ...current, cursor, hintAt: null, dueAt: later(pollMs) };
      });

      return;
    }
    const filter = mailboxFilter(
      rules.filter((rule) => scan!.ruleIds.includes(rule.id)),
    );
    for (let page = 0; page < maxPages; page++) {
      let result: Awaited<ReturnType<MessageReader['messages']>>;
      try {
        result = await deps.reader.messages(context, mailbox.connectionId, {
          filter,
          receivedSince: scan.since,
          cursor: scan.page,
          limit: pageSize,
        });
      } catch (error) {
        deps.log('A mailbox read failed; retrying.', error);
        result = { ok: false, code: 'internal' };
      }
      if (!result.ok) {
        await fail(context, mailbox, token, connection, scan, result);

        return;
      }
      try {
        await deps.ingest(context, mailbox, rules, result.items);
      } catch (error) {
        deps.log('Storing mailbox messages failed; retrying.', error);
        await fail(context, mailbox, token, connection, scan, {
          code: 'internal',
        });

        return;
      }
      if (!result.nextCursor) {
        const completed = scan;
        await release(
          tenantId,
          mailbox.connectionId,
          token,
          async (current, tx) => {
            const cursor: MailboxCursor = { ...current.cursor };
            delete cursor.scan;
            delete cursor.blockedVersion;
            if (completed.kind !== 'backfill')
              cursor.coveredUntil = completed.startedAt;
            const active = new Set(
              (await tx.rules.active(current.connectionId)).map((r) => r.id),
            );
            if (completed.kind !== 'incremental')
              await tx.rules.markBackfilled(
                completed.ruleIds.filter((id) => active.has(id)),
                deps.now().toISOString(),
              );
            const pending = (await tx.rules.active(current.connectionId)).some(
              (rule) => !rule.backfilledAt,
            );

            return {
              ...current,
              cursor,
              attempts: 0,
              lastError: null,
              lastSyncedAt: deps.now().toISOString(),
              hintAt:
                current.hintAt && current.hintAt > completed.startedAt
                  ? current.hintAt
                  : null,
              // Rules added meanwhile still need their older messages.
              dueAt: pending ? deps.now().toISOString() : later(pollMs),
            };
          },
        );

        return;
      }
      scan = { ...scan, page: result.nextCursor };
      const checkpoint = scan;
      const held = await release(
        tenantId,
        mailbox.connectionId,
        token,
        (current) => ({
          ...current,
          cursor: { ...current.cursor, scan: checkpoint },
        }),
        true,
      );
      if (!held) return;
    }
    // More pages remain; continue on the next pass so other mailboxes get their turn.
    await release(tenantId, mailbox.connectionId, token, (current) => ({
      ...current,
      dueAt: deps.now().toISOString(),
    }));
  }

  return {
    /** Workspaces and the members whose mailboxes are due. */
    scopes: () => deps.store.scopes(),
    /**
     * Reads due mailboxes read as one member, then runs the extra passes. A paused workspace or
     * member is skipped quietly; a member who can no longer read messages blocks their
     * mailboxes until someone else takes them over.
     */
    async tick(scope: { tenantId: string; principalId: string }) {
      let context: TenantContext;
      try {
        context = await deps.resolveContext(
          scope.principalId,
          scope.tenantId,
          'mailbox-sync',
        );
      } catch (error) {
        if (pausesBackgroundWork(error)) return;
        if (
          error instanceof IdentityError &&
          [401, 403, 404].includes(error.statusCode)
        ) {
          await deps.store.transaction(scope.tenantId, (tx) =>
            tx.mailboxes.blockPrincipal(
              scope.principalId,
              'principal_unavailable',
            ),
          );

          return;
        }
        throw error;
      }
      if (!hasPermission(context, 'messages.read')) {
        await deps.store.transaction(scope.tenantId, (tx) =>
          tx.mailboxes.blockPrincipal(
            scope.principalId,
            'principal_unavailable',
          ),
        );

        return;
      }
      const connections = new Map(
        (await deps.connections.list(context)).map((c) => [c.id, c]),
      );
      for (let index = 0; index < mailboxesPerPass; index++) {
        const token = deps.id();
        const mailbox = await deps.store.transaction(scope.tenantId, (tx) =>
          tx.mailboxes.claim(scope.principalId, token, leaseMs),
        );
        if (!mailbox) break;
        await read(
          context,
          mailbox,
          token,
          connections.get(mailbox.connectionId),
        );
      }
      for (const pass of deps.passes ?? []) await pass(context);
    },
  };
}

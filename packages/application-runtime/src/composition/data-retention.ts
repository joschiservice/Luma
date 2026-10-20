import { setTimeout as delay } from 'node:timers/promises';

import { createFailureLog } from '@luma/platform';
import { changeRetentionDays } from '@luma/read-models';
import type { Pool } from 'pg';

interface PurgeBatch {
  deleted: number;
  done: boolean;
  blocked: string | null;
}

const privacyCheckMs = 60 * 60_000;
const privacyWarningDays = 7;
/** Batches per kind and pass, so one large workspace cannot hold the pass indefinitely. */
const batchesPerPass = 20;

/**
 * Applies retention in bounded batches. Each pass announces deletion dates for closed workspaces
 * and queues owner notices, removes connections queued by a Shopify shop/redact, removes closed
 * workspaces whose announced date has passed, then deletes audit entries of workspaces closed
 * longer than `auditRetentionDays` and change feed entries past their retention. Hourly, it also reports open Shopify privacy requests due
 * within seven days through `log`, with counts only. Use a login that inherits
 * `luma_commerce_sync`. A removal blocked by a foreign key or an unclassified table is reported
 * and retried on the next pass; other failures are logged and retried.
 */
export function createDataRetentionWorker(options: {
  pool: Pool;
  closureRetentionDays: number;
  auditRetentionDays: number;
  /** Rows removed per database call; defaults to 2000. */
  batch?: number;
  intervalMs?: number;
  now?: () => Date;
  log?: (message: string, error?: unknown) => void;
}) {
  const log = options.log ?? createFailureLog();
  const now = options.now ?? (() => new Date());
  const batch = options.batch ?? 2000;
  const stop = new AbortController();
  let privacyCheckedAt = -Infinity;

  /** Calls one purge function until it has no due work, is blocked or used its batches. */
  async function drain(
    kind: string,
    purge: () => Promise<PurgeBatch | undefined>,
  ) {
    for (let i = 0; i < batchesPerPass && !stop.signal.aborted; i++) {
      const result = await purge();
      if (!result) return;
      if (result.blocked) {
        log(
          result.blocked.startsWith('unclassified:')
            ? `${kind} removal waits for a retention class; retrying.`
            : `${kind} removal is blocked by a reference; retrying.`,
          new Error(
            result.blocked.startsWith('unclassified:')
              ? `Table ${result.blocked.slice(13)} has no retention class`
              : `Rows in ${result.blocked} could not be deleted`,
          ),
        );

        return;
      }
    }
  }

  async function first(sql: string, values: unknown[]) {
    return (await options.pool.query<PurgeBatch>(sql, values)).rows[0];
  }

  async function checkPrivacyRequests() {
    if (now().getTime() - privacyCheckedAt < privacyCheckMs) return;
    const row = (
      await options.pool.query<{ due: number; overdue: number }>(
        'SELECT due,overdue FROM shopify_privacy_requests_due($1)',
        [privacyWarningDays],
      )
    ).rows[0];
    privacyCheckedAt = now().getTime();
    if (row?.due)
      log(
        'Shopify privacy requests are due within 7 days; complete them with the privacy tool.',
        new Error(`${row.due} open, ${row.overdue} overdue`),
      );
  }

  /** Deletes audit entries past their retention in batches, up to the pass limit. */
  async function purgeAudit() {
    for (let i = 0; i < batchesPerPass && !stop.signal.aborted; i++) {
      const row = (
        await options.pool.query<{ removed: number }>(
          'SELECT purge_closed_workspace_audit($1,$2) AS removed',
          [options.auditRetentionDays, batch],
        )
      ).rows[0];
      if (!row || row.removed < batch) return;
    }
  }

  /** Deletes change feed entries past their retention in batches, up to the pass limit. */
  async function pruneChanges() {
    for (let i = 0; i < batchesPerPass && !stop.signal.aborted; i++) {
      const row = (
        await options.pool.query<{ removed: number }>(
          'SELECT prune_workspace_changes($1,$2) AS removed',
          [changeRetentionDays, batch],
        )
      ).rows[0];
      if (!row || row.removed < batch) return;
    }
  }

  /** Runs one pass of every retention step; each step's failure is logged independently. */
  async function pass() {
    await options.pool
      .query('SELECT schedule_closed_workspace_deletions($1)', [
        options.closureRetentionDays,
      ])
      .catch((error: unknown) =>
        log(
          'Closed workspace deletions could not be scheduled; retrying.',
          error,
        ),
      );
    await drain('Shop data', () =>
      first(
        'SELECT deleted,done,blocked FROM purge_requested_connection_data($1)',
        [batch],
      ),
    ).catch((error: unknown) =>
      log('Shop data removal could not run; retrying.', error),
    );
    await drain('Closed workspace data', () =>
      first(
        'SELECT deleted,done,blocked FROM purge_closed_workspace_data($1)',
        [batch],
      ),
    ).catch((error: unknown) =>
      log('Closed workspace data removal could not run; retrying.', error),
    );
    await purgeAudit().catch((error: unknown) =>
      log(
        'Closed workspace audit entries could not be removed; retrying.',
        error,
      ),
    );
    await pruneChanges().catch((error: unknown) =>
      log('Old change feed entries could not be removed; retrying.', error),
    );
    await checkPrivacyRequests().catch((error: unknown) =>
      log('Shopify privacy deadlines could not be checked; retrying.', error),
    );
  }

  return {
    pass,
    async run() {
      while (!stop.signal.aborted) {
        await pass();
        await delay(options.intervalMs ?? 60_000, undefined, {
          signal: stop.signal,
        }).catch(() => undefined);
      }
    },
    shutdown: () => stop.abort(),
  };
}

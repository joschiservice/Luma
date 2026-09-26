import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { JournalEntry } from '@luma/simulator-core';

import { type Measure, unmeasured } from './performance.js';
import type { Run } from './run.js';
import { provisionOperationalStock } from './run.js';
import { summarizeRun } from './run-summary.js';

/** Opens durable run state and append-only journal storage, migrating legacy documents atomically. */
export async function openStore(path: string, measure: Measure = unmeasured) {
  await mkdir(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  measure('sqlite.initialize', () =>
    database.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS simulator_runs (
        id TEXT PRIMARY KEY, document TEXT NOT NULL, summary TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS simulator_journal (
        run_id TEXT NOT NULL, sequence INTEGER NOT NULL, document TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence)
      );
    `),
  );
  const saveRun = database.prepare(
    'INSERT INTO simulator_runs VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET document=excluded.document, summary=excluded.summary',
  );
  const appendJournal = database.prepare(
    'INSERT INTO simulator_journal VALUES (?, ?, ?)',
  );
  const deleteJournal = database.prepare(
    'DELETE FROM simulator_journal WHERE run_id=?',
  );

  function persist(run: Run, previous?: string) {
    for (const entry of run.clock.journal)
      appendJournal.run(run.id, entry.sequence, JSON.stringify(entry));
    // During a transaction the clock holds only newly appended entries.
    run.clock.journal = [];
    const document = measure('simulator.encode', () => JSON.stringify(run));
    if (document !== previous)
      measure('sqlite.UPDATE', () =>
        saveRun.run(run.id, document, JSON.stringify(summarizeRun(run))),
      );
  }

  try {
    database.exec('BEGIN IMMEDIATE');
    const legacy = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='simulator_state'",
      )
      .get();
    if (legacy) {
      const row = database
        .prepare('SELECT document FROM simulator_state WHERE id=1')
        .get();
      const runs = JSON.parse(String(row?.document ?? '{}')) as Record<
        string,
        Run
      >;
      for (const run of Object.values(runs)) {
        run.serviceHealth ??= { jtl: 'healthy', shopify: 'healthy' };
        run.operationalScenarios ??= [];
        provisionOperationalStock(run);
        persist(run);
      }
      database.exec('DROP TABLE simulator_state');
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    database.close();
    throw error;
  }

  return {
    /** Reads compact run summaries without a write lock or decoding provider state. */
    list() {
      return database
        .prepare('SELECT summary FROM simulator_runs ORDER BY rowid')
        .all()
        .map(
          (row) =>
            JSON.parse(String(row.summary)) as ReturnType<typeof summarizeRun>,
        );
    },
    /** Checks run existence without loading its state or history. */
    exists(id: string) {
      return !!database
        .prepare('SELECT 1 FROM simulator_runs WHERE id=?')
        .get(id);
    },
    /** Reads one run's provider state; journal history is available through journal(). */
    get(id: string): Run | undefined {
      const row = database
        .prepare('SELECT document FROM simulator_runs WHERE id=?')
        .get(id);

      return row ? (JSON.parse(String(row.document)) as Run) : undefined;
    },
    /** Reads newest entries first, using an exclusive sequence cursor for older pages. */
    journal(id: string, limit = 100, before?: number) {
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        (before !== undefined && (!Number.isSafeInteger(before) || before < 1))
      )
        throw new Error('Invalid journal page');
      const rows = database
        .prepare(
          'SELECT document FROM simulator_journal WHERE run_id=? AND sequence < ? ORDER BY sequence DESC LIMIT ?',
        )
        .all(id, before ?? Number.MAX_SAFE_INTEGER, limit + 1);
      const items = rows
        .slice(0, limit)
        .map((row) => JSON.parse(String(row.document)) as JournalEntry);

      return {
        items,
        nextCursor: rows.length > limit ? items.at(-1)!.sequence : null,
      };
    },
    /** Commits state and new journal entries together; callbacks see only selected runs and new journal entries. resetJournal clears their prior history atomically. */
    async transact<T>(
      work: (runs: Record<string, Run>) => T,
      {
        runIds,
        resetJournal = false,
      }: { runIds?: string[]; resetJournal?: boolean } = {},
    ): Promise<T> {
      return measure('simulator.transaction', () => {
        measure('sqlite.BEGIN', () => database.exec('BEGIN IMMEDIATE'));
        try {
          const rows = measure('sqlite.SELECT', () =>
            runIds
              ? runIds.flatMap((id) => {
                  const row = database
                    .prepare(
                      'SELECT id, document FROM simulator_runs WHERE id=?',
                    )
                    .get(id);

                  return row ? [row] : [];
                })
              : database
                  .prepare('SELECT id, document FROM simulator_runs')
                  .all(),
          );
          const runs = measure('simulator.decode', () =>
            Object.fromEntries(
              rows.map((row) => [
                String(row.id),
                JSON.parse(String(row.document)) as Run,
              ]),
            ),
          );
          const originals = { ...runs };
          const documents = new Map(
            rows.map((row) => [String(row.id), String(row.document)]),
          );
          const result = work(runs);
          for (const [id, run] of Object.entries(runs)) {
            if (resetJournal) deleteJournal.run(id);
            persist(run, documents.get(id));
          }
          for (const id of Object.keys(originals)) {
            if (runs[id]) continue;
            deleteJournal.run(id);
            database.prepare('DELETE FROM simulator_runs WHERE id=?').run(id);
          }
          // Clone before commit so an invalid result cannot commit a failed transaction.
          const copy = structuredClone(result);
          measure('sqlite.COMMIT', () => database.exec('COMMIT'));

          return copy;
        } catch (error) {
          measure('sqlite.ROLLBACK', () => database.exec('ROLLBACK'));
          throw error;
        }
      });
    },
    /** Closes the SQLite connection after pending synchronous work completes. */
    async close() {
      database.close();
    },
  };
}

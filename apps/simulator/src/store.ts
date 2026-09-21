import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { Run } from './run.js';

/** Opens a durable SQLite store; each transaction reads current state and commits before exposing its result. */
export async function openStore(path: string) {
  await mkdir(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec(
    'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS simulator_state (id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL)',
  );
  database
    .prepare('INSERT OR IGNORE INTO simulator_state VALUES(1, ?)')
    .run('{}');

  return {
    async transact<T>(work: (runs: Record<string, Run>) => T): Promise<T> {
      database.exec('BEGIN IMMEDIATE');
      try {
        const row = database
          .prepare('SELECT document FROM simulator_state WHERE id=1')
          .get()!;
        const runs = JSON.parse(String(row.document)) as Record<string, Run>;
        for (const run of Object.values(runs))
          run.serviceHealth ??= { jtl: 'healthy', shopify: 'healthy' };
        const result = work(runs);
        const document = JSON.stringify(runs);
        if (document !== row.document)
          database
            .prepare('UPDATE simulator_state SET document=? WHERE id=1')
            .run(document);
        database.exec('COMMIT');

        return structuredClone(result);
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    async close() {
      database.close();
    },
  };
}

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { type Measure, unmeasured } from './performance.js';
import type { Run } from './run.js';
import { provisionOperationalStock } from './run.js';

/** Opens a durable SQLite store; each transaction reads current state and commits before exposing its result. */
export async function openStore(path: string, measure: Measure = unmeasured) {
  await mkdir(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  measure('sqlite.initialize', () =>
    database.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS simulator_state (id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL)',
    ),
  );
  measure('sqlite.INSERT', () =>
    database
      .prepare('INSERT OR IGNORE INTO simulator_state VALUES(1, ?)')
      .run('{}'),
  );

  return {
    async transact<T>(work: (runs: Record<string, Run>) => T): Promise<T> {
      return measure('simulator.transaction', () => {
        measure('sqlite.BEGIN', () => database.exec('BEGIN IMMEDIATE'));
        try {
          const row = measure('sqlite.SELECT', () =>
            database
              .prepare('SELECT document FROM simulator_state WHERE id=1')
              .get()!,
          );
          const runs = measure('simulator.decode', () =>
            JSON.parse(String(row.document)),
          ) as Record<string, Run>;
          for (const run of Object.values(runs)) {
            run.serviceHealth ??= { jtl: 'healthy', shopify: 'healthy' };
            run.operationalScenarios ??= [];
            provisionOperationalStock(run);
          }
          const result = work(runs);
          const document = measure('simulator.encode', () =>
            JSON.stringify(runs),
          );
          if (document !== row.document)
            measure('sqlite.UPDATE', () =>
              database
                .prepare('UPDATE simulator_state SET document=? WHERE id=1')
                .run(document),
            );
          measure('sqlite.COMMIT', () => database.exec('COMMIT'));

          return structuredClone(result);
        } catch (error) {
          measure('sqlite.ROLLBACK', () => database.exec('ROLLBACK'));
          throw error;
        }
      });
    },
    async close() {
      database.close();
    },
  };
}

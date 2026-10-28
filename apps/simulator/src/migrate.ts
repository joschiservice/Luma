import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import pg from 'pg';

const directory = new URL('../migrations/', import.meta.url);

// A migration waiting for a table lock queues every later query on that table behind it, so each
// statement gives up after this long instead. The run then fails and can be repeated.
const LOCK_TIMEOUT = '5s';
const RUNNER_LOCK = "hashtext('luma_simulator_migrations')";

/**
 * Applies the simulator's ordered migrations with an owner connection and grants table access
 * to the runtime role. A session advisory lock serializes concurrent callers. Checksums of every
 * applied migration are verified before anything changes, and a changed file throws. Each pending
 * file commits in its own transaction with its record, so a failure keeps earlier migrations and
 * a repeated run continues with the failed one. A statement that cannot take a table lock within
 * five seconds fails the run.
 */
export async function migrate(ownerUrl: string, runtimeRole: string) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeRole))
    throw new Error('Invalid simulator runtime role');
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  let locked = false;
  try {
    await client.query(`SELECT pg_advisory_lock(${RUNNER_LOCK})`);
    locked = true;
    // Set after the advisory lock so a second caller still waits for the first to finish.
    await client.query(`SET lock_timeout = '${LOCK_TIMEOUT}'`);
    await client.query(
      'CREATE TABLE IF NOT EXISTS simulator_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );

    const applied = new Map(
      (
        await client.query<{ name: string; checksum: string }>(
          'SELECT name, checksum FROM simulator_migrations',
        )
      ).rows.map((row) => [row.name, row.checksum]),
    );
    const names = (await readdir(directory))
      .filter((name) => name.endsWith('.sql'))
      .sort();
    const pending: { name: string; source: string; checksum: string }[] = [];
    for (const name of names) {
      const source = await readFile(new URL(name, directory), 'utf8');
      const checksum = createHash('sha256').update(source).digest('hex');
      const appliedChecksum = applied.get(name);
      if (appliedChecksum === undefined) {
        pending.push({ name, source, checksum });
        continue;
      }
      if (appliedChecksum !== checksum)
        throw new Error(`Applied simulator migration changed: ${name}`);
    }

    for (const { name, source, checksum } of pending)
      await inTransaction(client, name, async () => {
        await client.query(source);
        await client.query(
          'INSERT INTO simulator_migrations (name, checksum) VALUES ($1, $2)',
          [name, checksum],
        );
      });

    // The runtime role reads and writes simulator data but cannot change its schema.
    await inTransaction(client, 'runtime grants', async () => {
      await client.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${runtimeRole}`,
      );
      await client.query(
        `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${runtimeRole}`,
      );
      await client.query(
        `REVOKE ALL ON simulator_migrations FROM ${runtimeRole}`,
      );
    });
  } finally {
    if (locked)
      await client
        .query(`SELECT pg_advisory_unlock(${RUNNER_LOCK})`)
        .catch(() => undefined);
    await client.end();
  }
}

/** Runs one step in a transaction and names the step and any lock timeout in the error. */
async function inTransaction(
  client: pg.Client,
  step: string,
  run: () => Promise<void>,
) {
  try {
    await client.query('BEGIN');
    await run();
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    const reason =
      error instanceof Error && 'code' in error && error.code === '55P03'
        ? `could not acquire a lock within ${LOCK_TIMEOUT}; retry when traffic on the affected tables allows`
        : error instanceof Error
          ? error.message
          : String(error);
    throw new Error(`Simulator migration ${step} failed: ${reason}`, {
      cause: error,
    });
  }
}

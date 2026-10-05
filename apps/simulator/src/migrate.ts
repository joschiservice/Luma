import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import pg from 'pg';

const directory = new URL('../migrations/', import.meta.url);

/**
 * Applies the simulator's ordered migrations with an owner connection and grants table access
 * to the runtime role. Applied migrations must not change; their checksums are verified.
 * Runs inside one transaction under an advisory lock, so concurrent callers apply each file once.
 */
export async function migrate(ownerUrl: string, runtimeRole: string) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeRole))
    throw new Error('Invalid simulator runtime role');
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('luma_simulator_migrations'))",
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS simulator_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const names = (await readdir(directory))
      .filter((name) => name.endsWith('.sql'))
      .sort();
    for (const name of names) {
      const source = await readFile(new URL(name, directory), 'utf8');
      const checksum = createHash('sha256').update(source).digest('hex');
      const { rows } = await client.query<{ checksum: string }>(
        'SELECT checksum FROM simulator_migrations WHERE name = $1',
        [name],
      );
      if (rows[0]) {
        if (rows[0].checksum !== checksum)
          throw new Error(`Applied simulator migration changed: ${name}`);
        continue;
      }
      await client.query(source);
      await client.query(
        'INSERT INTO simulator_migrations (name, checksum) VALUES ($1, $2)',
        [name, checksum],
      );
    }
    // The runtime role reads and writes simulator data but cannot change its schema.
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${runtimeRole}`,
    );
    await client.query(
      `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${runtimeRole}`,
    );
    await client.query(
      `REVOKE ALL ON simulator_migrations FROM ${runtimeRole}`,
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

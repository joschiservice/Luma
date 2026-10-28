import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import { Pool } from 'pg';

// Migrations run while the previous release keeps serving traffic. A migration that waits for a
// table lock queues every later query on that table behind it, so each statement gives up after
// this long instead. The run then fails and can be repeated once traffic allows.
const LOCK_TIMEOUT = '5s';
const RUNNER_LOCK = "hashtext('luma_identity_migrations')";

const connectionString = process.env.MIGRATION_DATABASE_URL;

if (!connectionString) throw new Error('MIGRATION_DATABASE_URL is required');

const pool = new Pool({ connectionString, max: 1 });

const client = await pool.connect();

/** Lists core migrations followed by installed app migrations, in application order. */
async function listMigrations() {
  const coreDirectory = new URL('../migrations/', import.meta.url);
  const migrations = (await readdir(coreDirectory))
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, url: new URL(name, coreDirectory) }));
  const appsDirectory = new URL('../../apps/', import.meta.url);
  let apps;
  try {
    apps = await readdir(appsDirectory, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    apps = [];
  }
  for (const app of apps
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()) {
    const directory = new URL(`${app}/migrations/`, appsDirectory);
    let names;
    try {
      names = await readdir(directory);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const file of names.filter((name) => name.endsWith('.sql')).sort())
      migrations.push({
        name: `app:${app}/${file}`,
        url: new URL(file, directory),
      });
  }

  return migrations;
}

// The session-level advisory lock serializes runners for the whole run. Each migration then
// commits on its own together with its identity_migrations row, so a failure keeps the
// migrations before it and a repeated run continues with the failed one.
let locked = false;
try {
  await client.query(`SELECT pg_advisory_lock(${RUNNER_LOCK})`);
  locked = true;
  // Set after the advisory lock so a second runner still waits for the first to finish.
  await client.query(`SET lock_timeout = '${LOCK_TIMEOUT}'`);
  await client.query(
    'CREATE TABLE IF NOT EXISTS identity_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
  );

  const applied = new Map(
    (
      await client.query('SELECT name, checksum FROM identity_migrations')
    ).rows.map((row) => [row.name, row.checksum]),
  );
  const pending = [];
  // Verify every applied checksum before changing anything.
  for (const { name, url } of await listMigrations()) {
    const source = await readFile(url, 'utf8');
    const checksum = createHash('sha256').update(source).digest('hex');
    if (!applied.has(name)) {
      pending.push({ name, source, checksum });
      continue;
    }
    if (applied.get(name) !== checksum)
      throw new Error(`Applied migration changed: ${name}`);
  }

  for (const { name, source, checksum } of pending) {
    try {
      await client.query('BEGIN');
      await client.query(source);
      await client.query(
        'INSERT INTO identity_migrations(name, checksum) VALUES ($1, $2)',
        [name, checksum],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      const reason =
        error.code === '55P03'
          ? `could not acquire a lock within ${LOCK_TIMEOUT}; retry when traffic on the affected tables allows`
          : error.message;
      throw new Error(`Migration ${name} failed: ${reason}`, { cause: error });
    }
    console.log(`Applied ${name}`);
  }
} finally {
  if (locked)
    await client
      .query(`SELECT pg_advisory_unlock(${RUNNER_LOCK})`)
      .catch(() => undefined);
  client.release();
  await pool.end();
}

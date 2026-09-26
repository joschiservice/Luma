import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import { Pool } from 'pg';

const connectionString = process.env.MIGRATION_DATABASE_URL;

if (!connectionString) throw new Error('MIGRATION_DATABASE_URL is required');

const pool = new Pool({ connectionString, max: 1 });

const client = await pool.connect();

try {
  await client.query('BEGIN');
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext('luma_identity_migrations'))",
  );
  await client.query(
    'CREATE TABLE IF NOT EXISTS identity_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
  );
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
  for (const { name, url } of migrations) {
    const source = await readFile(url, 'utf8');
    const checksum = createHash('sha256').update(source).digest('hex');
    const existing = await client.query(
      'SELECT checksum FROM identity_migrations WHERE name = $1',
      [name],
    );
    if (existing.rowCount) {
      if (existing.rows[0].checksum !== checksum)
        throw new Error(`Applied migration changed: ${name}`);
      continue;
    }
    await client.query(source);
    await client.query(
      'INSERT INTO identity_migrations(name, checksum) VALUES ($1, $2)',
      [name, checksum],
    );
    console.log(`Applied ${name}`);
  }
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}

import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('workspace change topics', () => {
  const name = `topics_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: databaseUrl });
  let owner: Pool;

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(databaseUrl!);
    url.pathname = `/${name}`;
    owner = new Pool({ connectionString: url.toString() });
    const setup = await admin.connect();
    try {
      await setup.query(
        "SELECT pg_advisory_lock(hashtext('luma_test_role_setup'))",
      );
      for (const file of (
        await readdir(new URL('../migrations/', import.meta.url))
      ).sort())
        if (file.endsWith('.sql'))
          await owner.query(
            await readFile(
              new URL(`../migrations/${file}`, import.meta.url),
              'utf8',
            ),
          );
    } finally {
      await setup.query(
        "SELECT pg_advisory_unlock(hashtext('luma_test_role_setup'))",
      );
      setup.release();
    }
  });

  afterAll(async () => {
    await owner?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.end();
  });

  // Live views refresh only for named topics, and a trigger missing an operation leaves
  // them stale after that kind of write.
  it('names topics and covers inserts, updates and deletes on every changed table', async () => {
    const triggers = await owner.query<{
      table: string;
      topics: number;
      operations: string[];
    }>(
      `SELECT c.relname AS table, t.tgnargs AS topics,
        ARRAY_REMOVE(ARRAY[
          CASE WHEN t.tgtype & 4 <> 0 THEN 'INSERT' END,
          CASE WHEN t.tgtype & 8 <> 0 THEN 'DELETE' END,
          CASE WHEN t.tgtype & 16 <> 0 THEN 'UPDATE' END
        ], NULL) AS operations
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE t.tgname = 'metric_change' ORDER BY c.relname`,
    );

    expect(triggers.rows.length).toBeGreaterThan(0);
    expect(
      triggers.rows.filter(
        (row) =>
          row.topics !== 1 ||
          [...row.operations].sort().join() !== 'DELETE,INSERT,UPDATE',
      ),
    ).toEqual([]);
  });
});

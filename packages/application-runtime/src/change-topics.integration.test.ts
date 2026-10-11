import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase } from './test-support/database.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('workspace change topics', () => {
  let database: Awaited<ReturnType<typeof createMigratedDatabase>>;
  let owner: Pool;

  beforeAll(async () => {
    database = await createMigratedDatabase(databaseUrl!);
    owner = database.owner;
  });

  afterAll(async () => {
    await database?.drop();
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

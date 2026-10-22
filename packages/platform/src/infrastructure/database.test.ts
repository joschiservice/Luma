import { Client, type Pool } from 'pg';
import { expect, it } from 'vitest';

import { createTenantDatabase } from './database.js';

/** A pool whose one client records every query it receives. */
function recordingPool() {
  const queries: string[] = [];
  const escapeLiteral = Client.prototype.escapeLiteral;
  const client = {
    escapeLiteral,
    async query(text: string) {
      queries.push(text);

      return { rows: [], rowCount: 0 };
    },
    release() {},
  };

  return { pool: { connect: async () => client } as unknown as Pool, queries };
}

it('opens a tenant transaction in one round trip with the tenant as an escaped literal', async () => {
  const { pool, queries } = recordingPool();
  await createTenantDatabase(pool).transaction(
    "tenant'; DROP TABLE x; --",
    (tx) => tx.query('SELECT 1'),
  );
  expect(queries).toEqual([
    "BEGIN; SELECT set_config('app.tenant_id', 'tenant''; DROP TABLE x; --', true)",
    'SELECT 1',
    'COMMIT',
  ]);
});

it('reports pool occupancy when no connection is acquired in time', async () => {
  const timeout = new Error('timeout exceeded when trying to connect');
  const pool = {
    connect: async () => {
      throw timeout;
    },
    totalCount: 20,
    idleCount: 0,
    waitingCount: 7,
  } as unknown as Pool;

  const failure = await createTenantDatabase(pool)
    .transaction('tenant', (tx) => tx.query('SELECT 1'))
    .catch((error: unknown) => error);

  expect(failure).toMatchObject({
    message: 'Database connection unavailable (20 open, 0 idle, 7 waiting)',
    cause: timeout,
  });
});

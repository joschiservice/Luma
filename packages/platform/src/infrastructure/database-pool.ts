import { Pool } from 'pg';

/**
 * Bounds for each kind of work a pool serves. Request pools answer people waiting on a
 * response, so they fail fast. Background pools serve sync passes, workflow activities and
 * retention, whose batch reads and writes legitimately run longer; their limits only stop
 * runaway statements and abandoned transactions from holding connections indefinitely.
 * Transactions that need more, such as provider token rotation, raise their own limits with
 * `SET LOCAL`. Migrations use their own connection and are not affected.
 */
const workloadLimits = {
  request: {
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
    // Some request transactions hold a lock across a provider call with a 15 second timeout.
    idle_in_transaction_session_timeout: 30_000,
  },
  background: {
    connectionTimeoutMillis: 10_000,
    statement_timeout: 120_000,
    // Exceeds the longest provider call timeout, the 120 second Shopify export read.
    idle_in_transaction_session_timeout: 180_000,
  },
} as const;

/**
 * Creates a PostgreSQL pool with acquire, statement, idle-in-transaction and idle-client
 * timeouts for its workload. Waiting longer than the acquire timeout for a connection rejects
 * the query. Errors from idle clients, such as a server restart, go to `onError` instead of
 * crashing the process. Call `end` to release the pool.
 */
export function createDatabasePool(settings: {
  connectionString: string;
  max: number;
  workload: keyof typeof workloadLimits;
  onError: (error: Error) => void;
}) {
  const pool = new Pool({
    connectionString: settings.connectionString,
    max: settings.max,
    idleTimeoutMillis: 30_000,
    ...workloadLimits[settings.workload],
  });
  pool.on('error', settings.onError);

  return pool;
}

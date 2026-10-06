import { readConnectionsConfig } from './connections.js';

export interface CommerceSyncConfig {
  /** Worker login with the commerce owner, customer and sync roles. */
  databaseUrl: string;
  connections: NonNullable<ReturnType<typeof readConnectionsConfig>>;
  /** Tenants synchronized in parallel by one process. */
  concurrency: number;
  /** Bounded pages per workspace and concurrent streams per connection. */
  workspaceConcurrency: number;
  connectionConcurrency: number;
}

/**
 * Reads settings for the commerce sync process. It reuses `WORKFLOW_DATABASE_URL` and the
 * connection keyring; both are required because sync reads installed connections.
 */
export function readCommerceSyncConfig(
  env: Readonly<Record<string, string | undefined>>,
): CommerceSyncConfig {
  const databaseUrl = env.WORKFLOW_DATABASE_URL;
  if (
    !databaseUrl ||
    !['postgres:', 'postgresql:'].includes(new URL(databaseUrl).protocol)
  )
    throw new Error('WORKFLOW_DATABASE_URL must be a PostgreSQL URL');
  const connections = readConnectionsConfig(env);
  if (!connections)
    throw new Error(
      'Configure CONNECTIONS_ACTIVE_KEY_ID and CONNECTIONS_KEYS to run commerce sync',
    );
  const concurrency = Number(env.COMMERCE_SYNC_CONCURRENCY ?? '4');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32)
    throw new Error(
      'COMMERCE_SYNC_CONCURRENCY must be an integer from 1 to 32',
    );

  const bounded = (key: string, fallback: number, max: number) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isInteger(value) || value < 1 || value > max)
      throw new Error(`${key} must be an integer from 1 to ${max}`);

    return value;
  };
  const workspaceConcurrency = bounded(
    'COMMERCE_SYNC_WORKSPACE_CONCURRENCY',
    4,
    8,
  );
  const connectionConcurrency = bounded(
    'COMMERCE_SYNC_CONNECTION_CONCURRENCY',
    1,
    4,
  );

  return {
    databaseUrl,
    connections,
    concurrency,
    workspaceConcurrency,
    connectionConcurrency,
  };
}

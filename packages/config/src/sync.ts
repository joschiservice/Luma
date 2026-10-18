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
  /** Mailbox reading in the same process. */
  messaging: {
    /** Days message text and attachment content are kept after receipt. */
    retentionDays: number;
    /** Time between reads of a current mailbox. */
    pollMs: number;
  };
  /** Days a closed workspace's data is kept before the sync process removes it. */
  closureRetentionDays: number;
  /** Days a closed workspace's audit entries are kept after closure; at least the closure window. */
  auditRetentionDays: number;
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
    2,
    4,
  );

  const retentionDays = Number(env.MESSAGING_RETENTION_DAYS ?? '365');
  if (
    !Number.isInteger(retentionDays) ||
    retentionDays < 30 ||
    retentionDays > 3650
  )
    throw new Error(
      'MESSAGING_RETENTION_DAYS must be an integer from 30 to 3650',
    );
  const pollSeconds = Number(env.MESSAGING_POLL_SECONDS ?? '120');
  if (!Number.isInteger(pollSeconds) || pollSeconds < 30 || pollSeconds > 3600)
    throw new Error(
      'MESSAGING_POLL_SECONDS must be an integer from 30 to 3600',
    );

  const closureRetentionDays = Number(
    env.WORKSPACE_CLOSURE_RETENTION_DAYS ?? '90',
  );
  if (
    !Number.isInteger(closureRetentionDays) ||
    closureRetentionDays < 30 ||
    closureRetentionDays > 3650
  )
    throw new Error(
      'WORKSPACE_CLOSURE_RETENTION_DAYS must be an integer from 30 to 3650',
    );

  // One year after closure covers disputes about actions taken for the merchant; longer legal
  // retention is the operator's decision.
  const auditRetentionDays = Number(env.AUDIT_RETENTION_DAYS ?? '365');
  if (
    !Number.isInteger(auditRetentionDays) ||
    auditRetentionDays < closureRetentionDays ||
    auditRetentionDays > 3650
  )
    throw new Error(
      'AUDIT_RETENTION_DAYS must be an integer from WORKSPACE_CLOSURE_RETENTION_DAYS to 3650',
    );

  return {
    databaseUrl,
    connections,
    concurrency,
    workspaceConcurrency,
    connectionConcurrency,
    messaging: { retentionDays, pollMs: pollSeconds * 1000 },
    closureRetentionDays,
    auditRetentionDays,
  };
}

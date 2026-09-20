export interface WorkflowConfig {
  databaseUrl: string;
  temporal: {
    address: string;
    namespace: string;
    taskQueue: string;
    dataRegion: 'EU';
    tls: boolean;
    apiKey?: string;
  };
}

/**
 * Validates the workflow database and EU Temporal settings; production connections and API
 * keys require TLS.
 */
export function readWorkflowConfig(
  env: Readonly<Record<string, string | undefined>>,
): WorkflowConfig {
  const databaseUrl = env.WORKFLOW_DATABASE_URL;
  if (
    !databaseUrl ||
    !['postgres:', 'postgresql:'].includes(new URL(databaseUrl).protocol)
  )
    throw new Error('WORKFLOW_DATABASE_URL must be a PostgreSQL URL');
  const address = env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233';
  const namespace = env.TEMPORAL_NAMESPACE ?? 'default';
  const taskQueue = env.TEMPORAL_TASK_QUEUE ?? 'luma-exceptions-v1';
  if (
    ![address, namespace, taskQueue].every((value) => value.trim().length > 0)
  )
    throw new Error(
      'Temporal address, namespace and task queue must not be empty',
    );
  if (env.TEMPORAL_DATA_REGION !== 'EU')
    throw new Error('TEMPORAL_DATA_REGION must be EU');
  const tls = env.TEMPORAL_TLS ?? 'false';
  if (!['true', 'false'].includes(tls))
    throw new Error('TEMPORAL_TLS must be true or false');
  if ((env.NODE_ENV === 'production' || env.TEMPORAL_API_KEY) && tls !== 'true')
    throw new Error('Temporal production connections and API keys require TLS');

  return {
    databaseUrl,
    temporal: {
      address,
      namespace,
      taskQueue,
      dataRegion: 'EU',
      tls: tls === 'true',
      ...(env.TEMPORAL_API_KEY ? { apiKey: env.TEMPORAL_API_KEY } : {}),
    },
  };
}

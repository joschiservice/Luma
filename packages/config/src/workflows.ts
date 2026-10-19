import {
  assertRegionalServiceEndpoint,
  type DataRegion,
  readRegionConfig,
} from './regions.js';

export interface WorkflowConfig {
  databaseUrl: string;
  temporal: {
    address: string;
    namespace: string;
    taskQueue: string;
    dataRegion: DataRegion;
    /** A private CA replaces the system roots when the server certificate is self-issued. */
    tls: boolean | { serverRootCACertificate: Uint8Array };
    apiKey?: string;
    payloadEncryption?: {
      keyArn: string;
      decryptionKeyArns: string[];
      kmsRegion: string;
      credentials: {
        accessKeyId: string;
        secretAccessKey: string;
        sessionToken?: string;
      };
      cacheTtlMs: number;
      cacheMaxUses: number;
    };
  };
}

const kmsRegions: Record<DataRegion, readonly string[]> = {
  AU: ['ap-southeast-2'],
  EU: [
    'eu-central-1',
    'eu-west-1',
    'eu-west-3',
    'eu-north-1',
    'eu-south-1',
    'eu-south-2',
  ],
  US: ['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2'],
};

/** Validates regional Temporal transport and KMS encryption; production requires TLS and encryption. */
export function readWorkflowConfig(
  env: Readonly<Record<string, string | undefined>>,
): WorkflowConfig {
  const databaseUrl = env.WORKFLOW_DATABASE_URL;
  if (
    !databaseUrl ||
    !['postgres:', 'postgresql:'].includes(new URL(databaseUrl).protocol)
  )
    throw new Error('WORKFLOW_DATABASE_URL must be a PostgreSQL URL');
  const { region } = readRegionConfig(env);
  const address = env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233';
  const namespace = env.TEMPORAL_NAMESPACE ?? 'default';
  const taskQueue = env.TEMPORAL_TASK_QUEUE ?? 'luma-exceptions-v1';
  if (
    ![address, namespace, taskQueue].every((value) => value.trim().length > 0)
  )
    throw new Error(
      'Temporal address, namespace and task queue must not be empty',
    );
  if (env.TEMPORAL_DATA_REGION !== region)
    throw new Error('TEMPORAL_DATA_REGION must equal LUMA_REGION');
  const tls = env.TEMPORAL_TLS ?? 'false';
  if (!['true', 'false'].includes(tls))
    throw new Error('TEMPORAL_TLS must be true or false');
  if ((env.NODE_ENV === 'production' || env.TEMPORAL_API_KEY) && tls !== 'true')
    throw new Error('Temporal production connections and API keys require TLS');
  const endpoint = new URL(`http${tls === 'true' ? 's' : ''}://${address}`);
  const local =
    env.NODE_ENV !== 'production' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== '/' ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error('Temporal address must contain only host and port');
  if (!local)
    assertRegionalServiceEndpoint(env, 'temporal', endpoint.toString());
  const serverRootCACertificate = readServerCertificateAuthority(env, tls);
  const payloadEncryption = readEncryption(env, region);

  return {
    databaseUrl,
    temporal: {
      address,
      namespace,
      taskQueue,
      dataRegion: region,
      tls: serverRootCACertificate
        ? { serverRootCACertificate }
        : tls === 'true',
      ...(env.TEMPORAL_API_KEY ? { apiKey: env.TEMPORAL_API_KEY } : {}),
      ...(payloadEncryption ? { payloadEncryption } : {}),
    },
  };
}

/**
 * Reads `TEMPORAL_TLS_SERVER_CA`, a base64-encoded PEM bundle that the client trusts instead
 * of the system roots. It requires TLS, so a self-hosted server can use a private CA.
 */
function readServerCertificateAuthority(
  env: Readonly<Record<string, string | undefined>>,
  tls: string,
) {
  const encoded = env.TEMPORAL_TLS_SERVER_CA;
  if (!encoded) return undefined;
  if (tls !== 'true')
    throw new Error('TEMPORAL_TLS_SERVER_CA requires TEMPORAL_TLS=true');
  const pem = Buffer.from(encoded, 'base64');
  if (
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) ||
    !pem.toString('utf8').includes('-----BEGIN CERTIFICATE-----')
  )
    throw new Error(
      'TEMPORAL_TLS_SERVER_CA must be a base64-encoded PEM certificate bundle',
    );

  return new Uint8Array(pem);
}

function readEncryption(
  env: Readonly<Record<string, string | undefined>>,
  region: DataRegion,
): WorkflowConfig['temporal']['payloadEncryption'] {
  const keyArn = env.TEMPORAL_KMS_KEY_ARN;
  const kmsRegion = env.TEMPORAL_KMS_REGION;
  const accessKeyId = env.TEMPORAL_KMS_ACCESS_KEY_ID;
  const secretAccessKey = env.TEMPORAL_KMS_SECRET_ACCESS_KEY;
  const present = [keyArn, kmsRegion, accessKeyId, secretAccessKey].some(
    (value) => value !== undefined,
  );
  if (!present) {
    if (env.NODE_ENV === 'production')
      throw new Error('Temporal production requires KMS payload encryption');
    if (env.TEMPORAL_KMS_DECRYPTION_KEY_ARNS || env.TEMPORAL_KMS_SESSION_TOKEN)
      throw new Error('Temporal KMS settings are incomplete');

    return undefined;
  }
  if (!keyArn || !kmsRegion || !accessKeyId?.trim() || !secretAccessKey?.trim())
    throw new Error('Temporal KMS settings are incomplete');
  if (!kmsRegions[region].includes(kmsRegion))
    throw new Error('Temporal KMS region must remain in the cell region');
  const decryptionKeyArns = (env.TEMPORAL_KMS_DECRYPTION_KEY_ARNS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  for (const arn of [keyArn, ...decryptionKeyArns]) {
    const match = /^arn:aws:kms:([a-z0-9-]+):\d{12}:key\/[a-f0-9-]{36}$/.exec(
      arn,
    );
    if (!match || match[1] !== kmsRegion)
      throw new Error(
        'Temporal KMS key must be a single-region key ARN in the configured KMS region',
      );
  }

  function bounded(name: string, fallback: number, maximum: number) {
    const value = env[name] ?? String(fallback);
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > maximum)
      throw new Error(`${name} is outside the supported key cache limit`);

    return Number(value);
  }

  return {
    keyArn,
    kmsRegion,
    decryptionKeyArns,
    credentials: {
      accessKeyId,
      secretAccessKey,
      ...(env.TEMPORAL_KMS_SESSION_TOKEN
        ? { sessionToken: env.TEMPORAL_KMS_SESSION_TOKEN }
        : {}),
    },
    cacheTtlMs: bounded('TEMPORAL_KMS_CACHE_TTL_MS', 60000, 300000),
    cacheMaxUses: bounded('TEMPORAL_KMS_CACHE_MAX_USES', 1000, 10000),
  };
}
